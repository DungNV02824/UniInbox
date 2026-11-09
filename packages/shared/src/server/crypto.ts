// Mã hóa AES-256-GCM cho channel_accounts.credentials (mục 5).
// Định dạng: "v1:<iv b64>:<authTag b64>:<ciphertext b64>", IV ngẫu nhiên 12 byte mỗi lần.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export type Aad = string | Buffer;

/** Giải mã khóa base64 (ENCRYPTION_KEY). Ném lỗi nếu không đúng 32 byte. Không bao giờ in giá trị khóa. */
export function parseEncryptionKey(base64: string): Buffer {
  const trimmed = base64.trim();
  if (!BASE64_PATTERN.test(trimmed) || trimmed.length % 4 !== 0) {
    throw new Error('ENCRYPTION_KEY phải là chuỗi base64 hợp lệ');
  }
  const key = Buffer.from(trimmed, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`ENCRYPTION_KEY phải giải mã ra đúng ${KEY_BYTES} byte (hiện là ${key.length})`);
  }
  return key;
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(`Khóa mã hóa phải dài ${KEY_BYTES} byte`);
  }
}

function toAadBuffer(aad: Aad): Buffer {
  return typeof aad === 'string' ? Buffer.from(aad, 'utf8') : aad;
}

export function encrypt(plaintext: string, key: Buffer, aad?: Aad): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  if (aad !== undefined) cipher.setAAD(toAadBuffer(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

function decodePart(part: string | undefined): Buffer | null {
  if (part === undefined) return null;
  if (part === '') return Buffer.alloc(0);
  if (!BASE64_PATTERN.test(part) || part.length % 4 !== 0) return null;
  return Buffer.from(part, 'base64');
}

/** Giải mã; ném lỗi khi sai định dạng, sai khóa, sai AAD hoặc dữ liệu bị sửa. */
export function decrypt(payload: string, key: Buffer, aad?: Aad): string {
  assertKey(key);
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Dữ liệu mã hóa sai định dạng');
  }
  const iv = decodePart(parts[1]);
  const tag = decodePart(parts[2]);
  const ciphertext = decodePart(parts[3]);
  if (!iv || iv.length !== IV_BYTES || !tag || tag.length !== TAG_BYTES || !ciphertext) {
    throw new Error('Dữ liệu mã hóa sai định dạng');
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    if (aad !== undefined) decipher.setAAD(toAadBuffer(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Giải mã thất bại: sai khóa hoặc dữ liệu đã bị thay đổi');
  }
}

export function encryptJson<T>(value: T, key: Buffer, aad?: Aad): string {
  return encrypt(JSON.stringify(value), key, aad);
}

export function decryptJson<T>(payload: string, key: Buffer, aad?: Aad): T {
  return JSON.parse(decrypt(payload, key, aad)) as T;
}
