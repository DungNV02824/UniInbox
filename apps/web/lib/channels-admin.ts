// Trang admin Kênh: chia mục, sắp xếp, đếm, định dạng số liệu và xác nhận xóa kênh — hàm thuần để test.
import type {
  ChannelAccountDto,
  ChannelStats,
  DeleteChannelRequest,
  DeleteChannelResult,
} from '@dezon/shared';
import { api, ApiError } from '@/lib/api';

type SortableChannel = Pick<ChannelAccountDto, 'status' | 'displayName' | 'updatedAt'>;

/** Kênh còn hoạt động (kể cả hết hạn/lỗi cần kết nối lại) và kênh đã ngắt kết nối. */
export interface ChannelSections<T> {
  active: T[];
  disconnected: T[];
}

// Kênh hết hạn/lỗi lên đầu để admin thấy ngay việc cần làm.
const ACTIVE_ORDER: Record<ChannelAccountDto['status'], number> = {
  expired: 0,
  error: 0,
  connected: 1,
  disconnected: 2,
};

/**
 * Mục "đang hoạt động": kênh hết hạn/lỗi trước rồi kênh đang kết nối, trong mỗi nhóm theo tên (tiếng Việt).
 * Mục "đã ngắt": ngắt gần nhất (updatedAt) lên trước.
 */
export function splitChannels<T extends SortableChannel>(channels: readonly T[]): ChannelSections<T> {
  const active: T[] = [];
  const disconnected: T[] = [];
  for (const ch of channels) (ch.status === 'disconnected' ? disconnected : active).push(ch);
  active.sort(
    (a, b) =>
      ACTIVE_ORDER[a.status] - ACTIVE_ORDER[b.status] || a.displayName.localeCompare(b.displayName, 'vi'),
  );
  disconnected.sort(
    (a, b) =>
      (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) ||
      a.displayName.localeCompare(b.displayName, 'vi'),
  );
  return { active, disconnected };
}

export interface ChannelSummary {
  connected: number;
  /** Hết hạn hoặc lỗi: cần kết nối lại. */
  attention: number;
  disconnected: number;
}

export function summarizeChannels(channels: readonly Pick<ChannelAccountDto, 'status'>[]): ChannelSummary {
  const out: ChannelSummary = { connected: 0, attention: 0, disconnected: 0 };
  for (const ch of channels) {
    if (ch.status === 'connected') out.connected += 1;
    else if (ch.status === 'disconnected') out.disconnected += 1;
    else out.attention += 1;
  }
  return out;
}

export interface SummaryPart {
  tone: 'ok' | 'warn' | 'muted';
  text: string;
}

/** "2 kênh đang hoạt động · 1 cần kết nối lại · 3 đã ngắt" (bỏ phần bằng 0, trừ phần đầu). */
export function summaryParts(summary: ChannelSummary): SummaryPart[] {
  const parts: SummaryPart[] = [
    { tone: 'ok', text: `${formatCount(summary.connected)} kênh đang hoạt động` },
  ];
  if (summary.attention)
    parts.push({ tone: 'warn', text: `${formatCount(summary.attention)} cần kết nối lại` });
  if (summary.disconnected)
    parts.push({ tone: 'muted', text: `${formatCount(summary.disconnected)} đã ngắt` });
  return parts;
}

const COUNT_FORMAT = new Intl.NumberFormat('vi-VN');

/** 1234 => "1.234". Giá trị không hợp lệ => "0". */
export function formatCount(n: number): string {
  return COUNT_FORMAT.format(Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
}

/** "12 hội thoại · 340 tin"; null khi API chưa trả số liệu. */
export function formatChannelStats(stats: ChannelStats | null | undefined): string | null {
  if (!stats) return null;
  return `${formatCount(stats.conversations)} hội thoại · ${formatCount(stats.messages)} tin`;
}

/** Câu trong hộp thoại xóa: "Sẽ xóa 12 hội thoại và 340 tin nhắn". */
export function deleteImpactText(stats: ChannelStats | null | undefined): string {
  if (!stats) return 'Sẽ xóa toàn bộ hội thoại và tin nhắn của kênh này';
  if (!stats.conversations && !stats.messages) return 'Kênh này chưa có hội thoại hay tin nhắn nào';
  return `Sẽ xóa ${formatCount(stats.conversations)} hội thoại và ${formatCount(stats.messages)} tin nhắn`;
}

/** Chỉ xóa được kênh không còn kết nối (API trả 409 với kênh `connected`). */
export function canDeleteChannel(channel: Pick<ChannelAccountDto, 'status'>): boolean {
  return channel.status !== 'connected';
}

/**
 * Chuẩn hóa tên xác nhận giống API: Unicode NFC (bộ gõ tiếng Việt có thể sinh chữ tổ hợp NFD trông y hệt
 * nhưng khác byte) rồi bỏ khoảng trắng đầu/cuối.
 */
export function normalizeConfirmName(value: string): string {
  return value.normalize('NFC').trim();
}

/** Tên gõ lại phải trùng chính xác tên kênh (sau chuẩn hóa; vẫn phân biệt hoa thường và dấu). */
export function isDeleteConfirmed(input: string, displayName: string): boolean {
  const typed = normalizeConfirmName(input);
  return typed.length > 0 && typed === normalizeConfirmName(displayName);
}

export function deleteErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return 'Kênh không còn tồn tại (có thể đã bị xóa).';
    return err.message;
  }
  return 'Không xóa được kênh. Vui lòng thử lại.';
}

/** "Kết nối bởi Hằng Nguyễn" / "Kết nối bằng Page Access Token"; null khi không rõ. */
export function connectedByText(channel: Pick<ChannelAccountDto, 'connectedBy'>): string | null {
  const by = channel.connectedBy;
  if (!by) return null;
  if (by.provider === 'facebook_login') {
    return `Kết nối bởi ${by.fbUserName?.trim() || 'tài khoản Facebook'}`;
  }
  if (by.provider === 'token') return 'Kết nối bằng Page Access Token';
  if (by.provider === 'zalo_oauth') return 'Kết nối qua Zalo OA';
  return null;
}

/** Ngày (không giờ) theo vi-VN, vd "6/11/2026"; chuỗi rỗng nếu không hợp lệ. */
export function formatDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : new Date(t).toLocaleDateString('vi-VN');
}

/** DELETE /channels/:id (admin). 409 = kênh còn kết nối; 400 = tên xác nhận không khớp. */
export function deleteChannel(id: string, body: DeleteChannelRequest) {
  return api.request<DeleteChannelResult>(`/channels/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body,
  });
}
