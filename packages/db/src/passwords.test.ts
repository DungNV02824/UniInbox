import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './passwords';
import { describeDatabase } from './scripts/util';

describe('passwords', () => {
  it('hash argon2id, mỗi lần một salt khác', async () => {
    const a = await hashPassword('Dezon@2026');
    const b = await hashPassword('Dezon@2026');
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, 'Dezon@2026')).toBe(true);
    expect(await verifyPassword(a, 'dezon@2026')).toBe(false);
  });

  it('verify trả về false với hash hỏng', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });

  it('không cho mật khẩu rỗng', async () => {
    await expect(hashPassword('')).rejects.toThrow();
  });
});

describe('describeDatabase', () => {
  it('không lộ mật khẩu', () => {
    const out = describeDatabase('postgres://dezon:secret@localhost:5433/dezon_inbox');
    expect(out).toBe('localhost:5433/dezon_inbox');
    expect(out).not.toContain('secret');
  });
});
