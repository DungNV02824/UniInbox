// Đồng bộ hội thoại qua API nền tảng (bổ sung cho webhook).
// - backfill: tải lịch sử N ngày gần nhất (khi kết nối Page / admin bấm "Đồng bộ lịch sử").
// - incremental: định kỳ kéo hội thoại có cập nhật mới (lưới an toàn khi webhook lỡ tin; ở chế độ
//   Phát triển của Meta App, webhook chỉ gửi tin của người có vai trò trong app).
import type { Db } from '@dezon/db';
import type { PipelineDeps } from '../pipeline/types';

export type SyncMode = 'backfill' | 'incremental';

/** Hàng đợi `channel-sync`. */
export interface ChannelSyncJobData {
  channelAccountId: string;
  mode: SyncMode;
  /** Chỉ cho backfill; mặc định MESSENGER_HISTORY_DAYS. */
  days?: number;
}
export const CHANNEL_SYNC_JOB_NAME = 'sync';
/** Tên job định kỳ (scheduler) duyệt mọi kênh đang kết nối và đẩy job incremental cho từng kênh. */
export const CHANNEL_SYNC_TICK_JOB_NAME = 'tick';

/** jobId cố định để không chạy chồng 2 lần đồng bộ cùng loại cho một kênh (BullMQ cấm ':' trong id). */
export const channelSyncJobId = (channelAccountId: string, mode: SyncMode): string =>
  `sync-${mode}-${channelAccountId}`;

export interface SyncOptions {
  mode: SyncMode;
  /** backfill: số ngày lịch sử. */
  days?: number;
  /** Giới hạn an toàn để một lần chạy không quá lâu. */
  maxConversations?: number;
  maxMessagesPerConversation?: number;
  now?: () => Date;
}

export interface SyncResult {
  conversations: number;
  /** Số tin MỚI được lưu (tin đã có bị bỏ qua nhờ chống trùng). */
  messagesStored: number;
  /** Tin đã có sẵn (đã nhận qua webhook hoặc lần đồng bộ trước). */
  messagesSkipped: number;
  /** true nếu dừng vì chạm giới hạn an toàn (maxConversations / maxMessagesPerConversation). */
  truncated?: boolean;
}

export type SyncFn = (
  db: Db,
  deps: PipelineDeps,
  channelAccountId: string,
  opts: SyncOptions,
) => Promise<SyncResult>;
