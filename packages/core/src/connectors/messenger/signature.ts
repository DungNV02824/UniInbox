// Xác minh webhook Meta: GET challenge và chữ ký X-Hub-Signature-256 (docs/research/messenger-platform.md §2).
import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_PREFIX = 'sha256=';
const HEX_SHA256 = /^[0-9a-f]{64}$/i;

/** So sánh chuỗi timing-safe; độ dài khác => false (không ném). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Lấy giá trị query đầu tiên (Fastify có thể trả mảng nếu tham số lặp lại). */
function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/** GET webhook: trả hub.challenge nếu mode=subscribe và verify_token khớp, ngược lại null. */
export function verifyMessengerChallenge(query: Record<string, unknown>, verifyToken: string): string | null {
  const mode = firstString(query['hub.mode']);
  const token = firstString(query['hub.verify_token']);
  const challenge = firstString(query['hub.challenge']);
  if (mode !== 'subscribe' || token === undefined || challenge === undefined) return null;
  if (!verifyToken || !safeEqual(token, verifyToken)) return null;
  return challenge;
}

/** So khớp X-Hub-Signature-256 ("sha256=<hex>") với HMAC-SHA256(appSecret, rawBody), timing-safe. */
export function verifyMessengerSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || !appSecret) return false;
  const header = signatureHeader.trim();
  if (!header.toLowerCase().startsWith(SIGNATURE_PREFIX)) return false;
  const received = header.slice(SIGNATURE_PREFIX.length);
  if (!HEX_SHA256.test(received)) return false;
  // HMAC trên RAW BYTES (Meta đã escape unicode trong body) — không JSON.stringify lại.
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(received, 'hex');
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

/** Đọc header không phân biệt hoa thường (Node đã hạ chữ thường, nhưng phòng thủ). */
export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}
