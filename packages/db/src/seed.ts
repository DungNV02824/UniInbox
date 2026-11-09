import type { UserRole } from '@dezon/shared';
import { sql } from 'drizzle-orm';
import type { Db } from './client';
import { hashPassword } from './passwords';
import { users } from './schema';

export const MIN_SEED_PASSWORD_LENGTH = 8;

export interface SeedUserInput {
  email: string;
  password: string;
  name?: string;
}

export interface SeedUsersInput {
  admin: SeedUserInput;
  agent?: SeedUserInput;
}

export interface SeedUsersOptions {
  /** Ghi đè mật khẩu của user đã tồn tại (mặc định: không). */
  resetPasswords?: boolean;
}

export interface SeededUser {
  id: string;
  email: string;
  role: UserRole;
  created: boolean;
}

const DEFAULT_NAMES: Record<UserRole, string> = { admin: 'Quản trị viên', agent: 'Nhân viên' };

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/**
 * Tạo/cập nhật user seed, idempotent: upsert theo email chữ thường.
 * User đã có: chỉ cập nhật name, role, is_active; giữ nguyên mật khẩu trừ khi resetPasswords.
 */
export async function seedUsers(
  db: Db,
  input: SeedUsersInput,
  opts: SeedUsersOptions = {},
): Promise<SeededUser[]> {
  const entries: [UserRole, SeedUserInput][] = [['admin', input.admin]];
  if (input.agent) entries.push(['agent', input.agent]);

  const result: SeededUser[] = [];
  for (const [role, user] of entries) {
    result.push(await upsertUser(db, role, user, opts.resetPasswords ?? false));
  }
  return result;
}

async function upsertUser(
  db: Db,
  role: UserRole,
  user: SeedUserInput,
  resetPassword: boolean,
): Promise<SeededUser> {
  const email = normalizeEmail(user.email);
  if (!email.includes('@')) throw new Error(`Email seed (${role}) không hợp lệ`);
  if (user.password.length < MIN_SEED_PASSWORD_LENGTH) {
    throw new Error(`Mật khẩu seed (${role}) phải có ít nhất ${MIN_SEED_PASSWORD_LENGTH} ký tự`);
  }
  const name = user.name?.trim() || DEFAULT_NAMES[role];
  const passwordHash = await hashPassword(user.password);

  const [row] = await db
    .insert(users)
    .values({ email, passwordHash, name, role, isActive: true })
    .onConflictDoUpdate({
      target: users.email,
      set: {
        name,
        role,
        isActive: true,
        updatedAt: new Date(),
        ...(resetPassword ? { passwordHash } : {}),
      },
    })
    // xmax = 0 nghĩa là dòng vừa được INSERT (không phải UPDATE).
    .returning({ id: users.id, email: users.email, role: users.role, created: sql<boolean>`(xmax = 0)` });

  if (!row) throw new Error(`Không thể seed user ${role}`);
  return row;
}
