// CLI: pnpm db:migrate — chạy migration lên DATABASE_URL (đọc từ .env gốc hoặc biến môi trường).
import { loadRootEnv } from '@dezon/shared/server';
import { runMigrations } from '../migrate';
import { describeDatabase } from './util';

async function main(): Promise<void> {
  loadRootEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Thiếu biến môi trường DATABASE_URL');

  console.log(`[db:migrate] Đang chạy migration trên ${describeDatabase(url)}...`);
  const started = Date.now();
  await runMigrations(url);
  console.log(`[db:migrate] Xong sau ${Date.now() - started} ms.`);
}

main().catch((err: unknown) => {
  console.error('[db:migrate] Lỗi:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
