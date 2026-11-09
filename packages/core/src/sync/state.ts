// Trạng thái đồng bộ lưu ở channel_accounts.settings.sync (jsonb tự do => đọc an toàn).
import { channelAccounts, type Db } from '@dezon/db';
import type { ChannelSyncState } from '@dezon/shared';
import { eq, sql } from 'drizzle-orm';

const isoOrNull = (v: unknown): string | null =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;

const textOrNull = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.slice(0, max) : null;

const countOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;

/** Đọc trạng thái đồng bộ từ channel_accounts.settings (dùng cho ChannelAccountDto.sync). */
export function readSyncState(settings: Record<string, unknown> | null | undefined): ChannelSyncState | null {
  const raw = settings?.sync;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  const days = s.backfillDays;
  return {
    lastSyncedAt: isoOrNull(s.lastSyncedAt),
    lastBackfillAt: isoOrNull(s.lastBackfillAt),
    backfillDays: typeof days === 'number' && Number.isInteger(days) && days > 0 ? days : null,
    backfillRunning: s.backfillRunning === true,
    lastError: textOrNull(s.lastError, 500),
    lastErrorAt: isoOrNull(s.lastErrorAt),
    backfillConversations: countOrNull(s.backfillConversations),
    backfillMessagesStored: countOrNull(s.backfillMessagesStored),
    backfillTruncated: s.backfillTruncated === true,
    pausedUntil: isoOrNull(s.pausedUntil),
  };
}

/** Kênh cần làm gì ở tick đồng bộ định kỳ. */
export interface SyncTickPlan {
  /** Chưa từng đồng bộ lịch sử (kênh kết nối trước khi có tính năng, backfill lỗi hẳn) => backfill. */
  needsBackfill: boolean;
  /** Đang tạm dừng (Facebook giới hạn tần suất / lỗi không thử lại được) => bỏ qua tick này. */
  paused: boolean;
}

export function syncTickPlan(settings: Record<string, unknown> | null | undefined, now: Date): SyncTickPlan {
  const state = readSyncState(settings);
  const pausedUntil = state?.pausedUntil ? Date.parse(state.pausedUntil) : NaN;
  return {
    needsBackfill: !state?.lastBackfillAt,
    paused: Number.isFinite(pausedUntil) && pausedUntil > now.getTime(),
  };
}

/** Ghi một phần trạng thái đồng bộ vào channel_accounts.settings.sync (merge, giữ khóa khác). */
export async function writeSyncState(
  db: Db,
  channelAccountId: string,
  patch: Partial<ChannelSyncState>,
): Promise<void> {
  // JSON.stringify bỏ khóa undefined; null được giữ (để xóa lastError).
  const json = JSON.stringify(patch);
  await db
    .update(channelAccounts)
    .set({
      settings: sql`jsonb_set(
        coalesce(${channelAccounts.settings}, '{}'::jsonb),
        '{sync}',
        (CASE WHEN jsonb_typeof(${channelAccounts.settings} -> 'sync') = 'object'
              THEN ${channelAccounts.settings} -> 'sync' ELSE '{}'::jsonb END) || ${json}::jsonb
      )`,
    })
    .where(eq(channelAccounts.id, channelAccountId));
}
