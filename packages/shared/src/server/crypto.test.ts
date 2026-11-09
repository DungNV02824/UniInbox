import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, decryptJson, encrypt, encryptJson, parseEncryptionKey } from './crypto';

const key = randomBytes(32);

/** Đổi 1 byte trong phần thứ `index` của payload v1:iv:tag:ct */
function tamper(payload: string, index: number): string {
  const parts = payload.split(':');
  const buf = Buffer.from(parts[index]!, 'base64');
  buf[0] = buf[0]! ^ 0xff;
  parts[index] = buf.toString('base64');
  return parts.join(':');
}

describe('crypto AES-256-GCM', () => {
  it('mã hóa rồi giải mã ra đúng chuỗi (kể cả tiếng Việt có dấu, emoji)', () => {
    const text = 'Chào chị Lan 👋 — mẫu bàn gỗ óc chó giá bao nhiêu ạ? Đặt cọc 30%.';
    const payload = encrypt(text, key);
    expect(payload).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(payload).not.toContain('Lan');
    expect(decrypt(payload, key)).toBe(text);
  });

  it('round-trip chuỗi rỗng', () => {
    expect(decrypt(encrypt('', key), key)).toBe('');
  });

  it('round-trip JSON', () => {
    const creds = {
      accessToken: 'tok_123',
      refreshToken: 'ref_456',
      cookie: [{ k: 'zpw', v: 'ấ' }],
      imei: 'x',
    };
    expect(decryptJson<typeof creds>(encryptJson(creds, key), key)).toEqual(creds);
  });

  it('IV khác nhau ở mỗi lần mã hóa', () => {
    const a = encrypt('cùng nội dung', key);
    const b = encrypt('cùng nội dung', key);
    expect(a).not.toBe(b);
    expect(a.split(':')[1]).not.toBe(b.split(':')[1]);
    expect(Buffer.from(a.split(':')[1]!, 'base64')).toHaveLength(12);
  });

  it('phát hiện dữ liệu bị sửa (ciphertext, tag, iv)', () => {
    const payload = encrypt('bí mật', key);
    expect(() => decrypt(tamper(payload, 3), key)).toThrow(/Giải mã thất bại/);
    expect(() => decrypt(tamper(payload, 2), key)).toThrow(/Giải mã thất bại/);
    expect(() => decrypt(tamper(payload, 1), key)).toThrow(/Giải mã thất bại/);
  });

  it('sai khóa thì thất bại', () => {
    const payload = encrypt('bí mật', key);
    expect(() => decrypt(payload, randomBytes(32))).toThrow(/Giải mã thất bại/);
  });

  it('sai định dạng thì thất bại', () => {
    expect(() => decrypt('abc', key)).toThrow(/sai định dạng/);
    expect(() => decrypt('v2:a:b:c', key)).toThrow(/sai định dạng/);
    expect(() => decrypt('v1:!!:??:##', key)).toThrow(/sai định dạng/);
    const [, iv, tag, ct] = encrypt('x', key).split(':');
    expect(() => decrypt(`v1:${iv}:${tag!.slice(4)}:${ct}`, key)).toThrow(/sai định dạng/);
  });

  it('hỗ trợ AAD: phải khớp khi giải mã', () => {
    const payload = encrypt('token', key, 'channel_account:123');
    expect(decrypt(payload, key, 'channel_account:123')).toBe('token');
    expect(() => decrypt(payload, key, 'channel_account:456')).toThrow(/Giải mã thất bại/);
    expect(() => decrypt(payload, key)).toThrow(/Giải mã thất bại/);
    expect(decryptJson(encryptJson({ a: 1 }, key, Buffer.from('ctx')), key, Buffer.from('ctx'))).toEqual({
      a: 1,
    });
  });

  it('khóa không đủ 32 byte bị từ chối', () => {
    expect(() => encrypt('x', randomBytes(16))).toThrow(/32 byte/);
    expect(() => decrypt(encrypt('x', key), randomBytes(31))).toThrow(/32 byte/);
  });
});

describe('parseEncryptionKey', () => {
  it('chấp nhận base64 32 byte', () => {
    expect(parseEncryptionKey(randomBytes(32).toString('base64'))).toHaveLength(32);
  });

  it('từ chối độ dài khác 32 byte và chuỗi không phải base64, không in giá trị khóa', () => {
    const short = randomBytes(16).toString('base64');
    expect(() => parseEncryptionKey(short)).toThrow(/32 byte/);
    expect(() => parseEncryptionKey(randomBytes(33).toString('base64'))).toThrow(/32 byte/);
    expect(() => parseEncryptionKey('khong-phai-base64!')).toThrow(/base64/);
    expect(() => parseEncryptionKey('')).toThrow();
    expect(() => parseEncryptionKey(short)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(short) }),
    );
  });
});
