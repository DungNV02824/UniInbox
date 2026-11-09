// CLI: pnpm db:seed — tạo admin (bắt buộc) và agent (tùy chọn) từ biến SEED_*.
// Thêm cờ --reset-passwords để ghi đè mật khẩu của user đã tồn tại.
import { loadRootEnv } from '@dezon/shared/server';
import { createDb } from '../client';
import { seedUsers, type SeedUsersInput } from '../seed';
import { describeDatabase } from './util';

function readInput(env: NodeJS.ProcessEnv): SeedUsersInput {
  const adminEmail = env.SEED_ADMIN_EMAIL?.trim();
  const adminPassword = env.SEED_ADMIN_PASSWORD;
  if (!adminEmail) throw new Error('Thiếu SEED_ADMIN_EMAIL trong .env');
  if (!adminPassword) throw new Error('Thiếu SEED_ADMIN_PASSWORD trong .env — không thể tạo tài khoản admin');

  const input: SeedUsersInput = {
    admin: { email: adminEmail, password: adminPassword, name: env.SEED_ADMIN_NAME },
  };

  const agentEmail = env.SEED_AGENT_EMAIL?.trim();
  const agentPassword = env.SEED_AGENT_PASSWORD;
  if (agentEmail && agentPassword) {
    input.agent = { email: agentEmail, password: agentPassword, name: env.SEED_AGENT_NAME };
  } else if (agentEmail || agentPassword) {
    console.warn('[db:seed] Bỏ qua agent: cần cả SEED_AGENT_EMAIL và SEED_AGENT_PASSWORD.');
  }
  return input;
}

async function main(): Promise<void> {
  loadRootEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Thiếu biến môi trường DATABASE_URL');
  const input = readInput(process.env);
  const resetPasswords = process.argv.includes('--reset-passwords');

  console.log(`[db:seed] Seed user trên ${describeDatabase(url)}...`);
  const { db, close } = createDb(url, { max: 1 });
  try {
    const seeded = await seedUsers(db, input, { resetPasswords });
    for (const u of seeded) {
      console.log(`[db:seed] ${u.created ? 'Đã tạo' : 'Đã cập nhật'} ${u.role}: ${u.email}`);
    }
  } finally {
    await close();
  }
}

main().catch((err: unknown) => {
  console.error('[db:seed] Lỗi:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
