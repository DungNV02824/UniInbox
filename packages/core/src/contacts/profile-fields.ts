// Trường thông tin khách (contacts.profile_fields): hàm thuần dùng chung cho đọc hồ sơ, nhân viên sửa và bot thu thập.
import type { ContactProfileFieldValue } from '@dezon/db';
import { CAPTURE_BUILTIN_LABELS, type CaptureBuiltinKey, type ContactProfileFieldDto } from '@dezon/shared';

/** Tên hiển thị mặc định của một khóa: trường có sẵn ⇒ CAPTURE_BUILTIN_LABELS ("Nhu cầu"…), còn lại ⇒ chính khóa. */
export function defaultProfileFieldLabel(key: string): string {
  return Object.prototype.hasOwnProperty.call(CAPTURE_BUILTIN_LABELS, key)
    ? CAPTURE_BUILTIN_LABELS[key as CaptureBuiltinKey]
    : key;
}

/** Cắt chuỗi theo số ký tự (code point — không cắt đôi emoji/ký tự ghép UTF-16). */
export function truncateCodePoints(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join('');
}

/**
 * contacts.profile_fields ⇒ danh sách hiển thị: 'need' (Nhu cầu) trước, rồi các trường khác theo thời gian điền
 * (updatedAt tăng dần, cùng lúc ⇒ theo khóa). Bỏ mục hỏng (không có giá trị chữ); nhãn trống ⇒ nhãn mặc định.
 */
export function toProfileFieldDtos(
  fields: Record<string, ContactProfileFieldValue> | null | undefined,
): ContactProfileFieldDto[] {
  if (!fields || typeof fields !== 'object') return [];
  const out: ContactProfileFieldDto[] = [];
  for (const [key, raw] of Object.entries(fields)) {
    if (!raw || typeof raw !== 'object' || typeof raw.value !== 'string' || raw.value === '') continue;
    const label =
      typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label : defaultProfileFieldLabel(key);
    out.push({
      key,
      label,
      value: raw.value,
      source: raw.source === 'user' ? 'user' : 'ai',
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    });
  }
  return out.sort((a, b) => {
    if (a.key === 'need' || b.key === 'need') return a.key === 'need' ? (b.key === 'need' ? 0 : -1) : 1;
    const t = Date.parse(a.updatedAt || '0') - Date.parse(b.updatedAt || '0');
    if (t !== 0 && !Number.isNaN(t)) return t;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}
