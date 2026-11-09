// Định dạng hiển thị của hộp thư (tiếng Việt, múi giờ của trình duyệt).
import type { AttachmentType, ChannelType, LastMessagePreview, MessageStatus } from '@dezon/shared';

export const CHANNEL_TYPE_LABELS: Record<ChannelType, string> = {
  messenger: 'Messenger',
  zalo_oa: 'Zalo OA',
  zalo_personal: 'Zalo cá nhân',
};

export const MESSAGE_STATUS_LABELS: Record<MessageStatus, string> = {
  received: 'Đã nhận',
  queued: 'Đang gửi',
  sent: 'Đã gửi',
  delivered: 'Đã nhận',
  seen: 'Đã xem',
  failed: 'Gửi lỗi',
};

const ATTACHMENT_LABELS: Record<AttachmentType, string> = {
  image: '[Ảnh]',
  sticker: '[Nhãn dán]',
  video: '[Video]',
  audio: '[Âm thanh]',
  file: '[Tệp]',
};

/**
 * Bản xem trước có thể kèm thêm trường (chưa có trong hợp đồng 1A): người gửi và loại tệp.
 * Có thì hiển thị chính xác hơn ("Bạn:" thay vì "NV:", "[Ảnh]" thay vì "[Tệp đính kèm]").
 */
export type PreviewInput = LastMessagePreview & {
  senderUserId?: string | null;
  attachmentType?: AttachmentType | null;
};

/** Trích tin cuối cho một dòng danh sách hội thoại. */
export function formatPreview(last: PreviewInput | null, viewerId?: string): string {
  if (!last) return 'Chưa có tin nhắn';
  const text = last.text?.replace(/\s+/g, ' ').trim();
  const body =
    text ||
    (last.hasAttachments
      ? last.attachmentType
        ? ATTACHMENT_LABELS[last.attachmentType]
        : '[Tệp đính kèm]'
      : '');
  let prefix = '';
  if (last.senderType === 'agent') {
    prefix = viewerId && last.senderUserId === viewerId ? 'Bạn: ' : 'NV: ';
  } else if (last.senderType === 'bot') {
    prefix = 'AI: ';
  }
  return `${prefix}${body || '...'}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Giờ tương đối ngắn gọn cho danh sách: "Vừa xong", "5 phút", "3 giờ", "2 ngày", rồi "dd/MM" hoặc "dd/MM/yy". */
export function formatRelativeTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '';
  const t = new Date(iso);
  const diff = now.getTime() - t.getTime();
  if (Number.isNaN(diff)) return '';
  if (diff < MINUTE) return 'Vừa xong';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} phút`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} giờ`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} ngày`;
  const base = `${pad(t.getDate())}/${pad(t.getMonth() + 1)}`;
  return t.getFullYear() === now.getFullYear() ? base : `${base}/${String(t.getFullYear()).slice(-2)}`;
}

/** Giờ:phút của một tin. */
export function formatClock(iso: string): string {
  const t = new Date(iso);
  return `${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

/** Ngày/giờ đầy đủ (tooltip). */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN');
}

function dayKeyOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Khóa nhóm tin theo ngày (giờ địa phương). */
export function dayKey(iso: string): string {
  return dayKeyOf(new Date(iso));
}

/** Nhãn ngày giữa danh sách tin: "Hôm nay", "Hôm qua", "Thứ Hai, 03/11/2026". */
export function formatDayLabel(iso: string, now: Date = new Date()): string {
  const t = new Date(iso);
  const key = dayKeyOf(t);
  if (key === dayKeyOf(now)) return 'Hôm nay';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key === dayKeyOf(yesterday)) return 'Hôm qua';
  const weekday = t.toLocaleDateString('vi-VN', { weekday: 'long' });
  const cap = weekday.charAt(0).toUpperCase() + weekday.slice(1);
  return `${cap}, ${pad(t.getDate())}/${pad(t.getMonth() + 1)}/${t.getFullYear()}`;
}

/**
 * Chữ cái đầu cho avatar: tối đa 2 chữ (chữ đầu của từ đầu và từ cuối).
 * Ưu tiên các từ bắt đầu bằng chữ/số, bỏ phần như "(test)" — "Dezon Shop (test)" => "DS", không phải "D(".
 */
export function initials(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const plain = words.filter((word) => /^[\p{L}\p{N}]/u.test(word));
  const letters = (plain.length > 0 ? plain : words)
    .map((word) => /[\p{L}\p{N}]/u.exec(word)?.[0] ?? '')
    .filter(Boolean);
  if (letters.length === 0) return '?';
  const first = letters[0]!;
  const last = letters.length > 1 ? letters[letters.length - 1]! : '';
  return (first + last).toUpperCase();
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
export const FALLBACK_CHANNEL_COLOR = '#64748b';

/** Màu kênh an toàn để ghép chuỗi CSS (sai định dạng thì dùng màu xám). */
export function safeColor(color: string | null | undefined): string {
  return color && HEX.test(color) ? color : FALLBACK_CHANNEL_COLOR;
}
