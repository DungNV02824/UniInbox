// Hiển thị trạng thái đồng bộ hội thoại của kênh (trang Kênh) — hàm thuần để test độc lập.
import { syncChannelSchema, type ChannelAccountDto, type ChannelSyncState } from '@dezon/shared';
import { ApiError } from '@/lib/api';
import { formatClock, formatDateTime } from '@/lib/inbox-format';

/** Các lựa chọn số ngày lịch sử trong hộp thoại "Đồng bộ lịch sử". */
export const SYNC_DAY_OPTIONS = [7, 30, 90, 180] as const;
export const DEFAULT_SYNC_DAYS = 30;

/** Chu kỳ tải lại danh sách kênh: nhanh khi có kênh đang đồng bộ lịch sử, chậm khi không. */
export const CHANNELS_POLL_FAST_MS = 5_000;
export const CHANNELS_POLL_SLOW_MS = 60_000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function channelsRefetchInterval(channels: ChannelAccountDto[] | undefined): number {
  return channels?.some((c) => c.sync?.backfillRunning) ? CHANNELS_POLL_FAST_MS : CHANNELS_POLL_SLOW_MS;
}

/** "vừa xong", "5 phút trước", "3 giờ trước", "2 ngày trước", quá 7 ngày thì ngày giờ đầy đủ. */
export function formatAgo(iso: string, now: Date = new Date()): string {
  const diff = now.getTime() - Date.parse(iso);
  if (Number.isNaN(diff)) return '';
  if (diff < MINUTE) return 'vừa xong';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} phút trước`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} giờ trước`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} ngày trước`;
  return formatDateTime(iso);
}

export interface SyncStatusView {
  /** Đang đồng bộ lịch sử (hiện vòng quay). */
  running: boolean;
  /** "Đồng bộ lần cuối: 5 phút trước" hoặc "Chưa đồng bộ lần nào"; null = không có thông tin đồng bộ. */
  lastSynced: string | null;
  /** Mô tả lần đồng bộ lịch sử gần nhất (title/tooltip), vd "Đã đồng bộ lịch sử 30 ngày lúc ...". */
  backfill: string | null;
  /** Lỗi đồng bộ còn hiệu lực (mới hơn lần đồng bộ thành công gần nhất). */
  error: { message: string; at: string | null } | null;
  /** Cảnh báo không phải lỗi: lần đồng bộ lịch sử chạm giới hạn, đồng bộ định kỳ đang tạm dừng. */
  warnings: string[];
}

/** Chỉ hiện trạng thái đồng bộ cho kênh Messenger ĐANG kết nối (kênh hết hạn đã có dòng lỗi riêng). */
export function showSyncStatus(channel: Pick<ChannelAccountDto, 'type' | 'status' | 'sync'>): boolean {
  return channel.type === 'messenger' && channel.status === 'connected' && !!channel.sync;
}

function backfillText(sync: ChannelSyncState): string | null {
  if (!sync.lastBackfillAt) return null;
  const days = sync.backfillDays ? ` ${sync.backfillDays} ngày` : '';
  const counts =
    typeof sync.backfillConversations === 'number'
      ? ` · ${sync.backfillConversations} hội thoại, ${sync.backfillMessagesStored ?? 0} tin mới`
      : '';
  return `Đã đồng bộ lịch sử${days} lúc ${formatDateTime(sync.lastBackfillAt)}${counts}`;
}

function warningsOf(sync: ChannelSyncState, now: Date): string[] {
  const out: string[] = [];
  if (sync.backfillTruncated && !sync.backfillRunning) {
    out.push(
      'Lần đồng bộ lịch sử gần nhất đạt giới hạn an toàn (500 hội thoại, 200 tin mỗi hội thoại): một phần lịch sử cũ chưa được kéo về.',
    );
  }
  const paused = sync.pausedUntil ? Date.parse(sync.pausedUntil) : NaN;
  if (Number.isFinite(paused) && paused > now.getTime()) {
    out.push(`Đồng bộ định kỳ tạm dừng đến ${formatClock(sync.pausedUntil!)} rồi tự chạy lại.`);
  }
  return out;
}

/** Lỗi chỉ còn hiệu lực khi xảy ra SAU lần đồng bộ thành công gần nhất. */
function activeError(sync: ChannelSyncState): SyncStatusView['error'] {
  if (!sync.lastError) return null;
  if (sync.lastSyncedAt && sync.lastErrorAt) {
    if (Date.parse(sync.lastErrorAt) <= Date.parse(sync.lastSyncedAt)) return null;
  } else if (sync.lastSyncedAt && !sync.lastErrorAt) {
    // Không biết lúc nào lỗi mà đã có lần thành công: coi như lỗi cũ.
    return null;
  }
  return { message: sync.lastError, at: sync.lastErrorAt };
}

export function describeSyncStatus(
  sync: ChannelSyncState | null | undefined,
  now: Date = new Date(),
): SyncStatusView {
  if (!sync) return { running: false, lastSynced: null, backfill: null, error: null, warnings: [] };
  const error = activeError(sync);
  return {
    running: sync.backfillRunning,
    lastSynced: sync.lastSyncedAt
      ? `Đồng bộ lần cuối: ${formatAgo(sync.lastSyncedAt, now)}`
      : 'Chưa đồng bộ lần nào',
    backfill: backfillText(sync),
    error: error && { message: error.message, at: error.at ? formatAgo(error.at, now) : null },
    warnings: warningsOf(sync, now),
  };
}

/** Kiểm tra số ngày chọn trong hộp thoại (chuỗi từ <select>) theo hợp đồng `syncChannelSchema`. */
export function parseSyncDays(
  value: string | number,
): { ok: true; days: number } | { ok: false; error: string } {
  const days = typeof value === 'number' ? value : Number(value.trim());
  const parsed = syncChannelSchema.safeParse({ days });
  if (!parsed.success || parsed.data.days === undefined || !Number.isFinite(days)) {
    return { ok: false, error: 'Số ngày không hợp lệ (1–365 ngày).' };
  }
  return { ok: true, days: parsed.data.days };
}

/** Thông báo lỗi khi bấm "Đồng bộ lịch sử". */
export function syncErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) return 'Đang đồng bộ, vui lòng chờ';
    if (err.status === 422) return err.message || 'Kênh chưa sẵn sàng để đồng bộ.';
    return err.message;
  }
  return 'Không bắt đầu được đồng bộ. Vui lòng thử lại.';
}
