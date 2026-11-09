// Cursor phân trang dạng opaque: base64url của {t, id}.
// `t` là thời điểm dạng ISO với độ chính xác micro giây (lấy từ Postgres) để so sánh không lệch.
import { InboxValidationError } from './errors';

export interface CursorValue {
  /** null = mốc thời gian NULL (hội thoại chưa có tin). */
  t: string | null;
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorValue {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed && typeof parsed === 'object') {
      const { t, id } = parsed as Record<string, unknown>;
      const tOk = t === null || (typeof t === 'string' && TS_RE.test(t));
      if (tOk && typeof id === 'string' && UUID_RE.test(id)) return { t: t as string | null, id };
    }
  } catch {
    // rơi xuống lỗi chung bên dưới
  }
  throw new InboxValidationError('Cursor không hợp lệ');
}
