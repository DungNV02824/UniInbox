import { type Algorithm, hash, verify } from '@node-rs/argon2';

// `Algorithm` là const enum ambient (không dùng được với isolatedModules) => giá trị số: Argon2id = 2.
const ARGON2ID = 2 as Algorithm;

// Tham số argon2id theo khuyến nghị OWASP (m=19 MiB, t=2, p=1).
const OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  if (plain.length === 0) throw new Error('Mật khẩu không được để trống');
  return hash(plain, OPTIONS);
}

/** Trả về false (không ném lỗi) khi hash hỏng hoặc sai định dạng. */
export async function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plain);
  } catch {
    return false;
  }
}
