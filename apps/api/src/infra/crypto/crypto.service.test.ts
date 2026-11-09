import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config';
import { CryptoService } from './crypto.service';

const makeService = (key = randomBytes(32).toString('base64')) =>
  new CryptoService({ ENCRYPTION_KEY: key } as AppConfig);

describe('CryptoService', () => {
  it('mã hóa/giải mã credentials bằng ENCRYPTION_KEY', () => {
    const service = makeService();
    const creds = { accessToken: 'tok_abc', refreshToken: 'ref_xyz' };
    const payload = service.encryptJson(creds, 'channel_account:1');
    expect(payload).not.toContain('tok_abc');
    expect(service.decryptJson(payload, 'channel_account:1')).toEqual(creds);
    expect(service.decrypt(service.encrypt('Chào chị Lan'))).toBe('Chào chị Lan');
  });

  it('khóa khác không giải mã được', () => {
    const payload = makeService().encrypt('bí mật');
    expect(() => makeService().decrypt(payload)).toThrow(/Giải mã thất bại/);
  });

  it('từ chối khóa không đủ 32 byte', () => {
    expect(() => makeService(randomBytes(16).toString('base64'))).toThrow(/32 byte/);
  });
});
