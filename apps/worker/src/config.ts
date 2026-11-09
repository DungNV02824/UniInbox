import type { DefaultJobOptions } from 'bullmq';
import type { SyncMode } from '@dezon/core';
import { QUEUE_NAMES, type QueueName } from '@dezon/shared';

/** Mặc định cho mọi job (các hàng đợi giai đoạn sau dùng lại). */
export const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  // Giữ tối đa 1000 job xong / 24h để tra cứu; job lỗi giữ lâu hơn để điều tra.
  removeOnComplete: { count: 1_000, age: 24 * 3600 },
  removeOnFail: { count: 5_000, age: 7 * 24 * 3600 },
};

/**
 * Đồng bộ lịch sử: thử 3 lần, backoff mũ. jobId cố định (channelSyncJobId) nên phải xóa job khi
 * xong/thất bại hẳn, nếu không lần đẩy sau cùng jobId bị BullMQ bỏ qua.
 */
const CHANNEL_SYNC_BACKFILL_OPTIONS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: true,
};

/**
 * Tùy chọn job theo hàng đợi (6.6): outbound thử 3 lần, inbound 5 lần, backoff mũ.
 * Áp cho job thêm qua Queue của worker; API cũng phải đẩy job với cùng tùy chọn.
 */
export const QUEUE_JOB_OPTIONS: Partial<Record<QueueName, DefaultJobOptions>> = {
  [QUEUE_NAMES.inbound]: {
    ...DEFAULT_JOB_OPTIONS,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
  },
  [QUEUE_NAMES.outbound]: {
    ...DEFAULT_JOB_OPTIONS,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
  },
  // Mặc định của hàng đợi = tùy chọn backfill (job do API đẩy khi kết nối Page / admin bấm đồng bộ).
  [QUEUE_NAMES.channelSync]: CHANNEL_SYNC_BACKFILL_OPTIONS,
};

/**
 * Tùy chọn job đồng bộ hội thoại theo chế độ. API đẩy job backfill PHẢI dùng cùng tùy chọn
 * (đặc biệt removeOnComplete/removeOnFail = true vì jobId cố định).
 * - backfill: thử 3 lần, backoff mũ.
 * - incremental: 1 lần (tick sau tự chạy lại).
 */
export const CHANNEL_SYNC_JOB_OPTIONS = {
  backfill: CHANNEL_SYNC_BACKFILL_OPTIONS,
  incremental: { attempts: 1, removeOnComplete: true, removeOnFail: true },
} satisfies Record<SyncMode, DefaultJobOptions>;

/** Job định kỳ "tick" (scheduler) của channel-sync: lỗi thì bỏ qua, chỉ giữ ít lịch sử. */
export const CHANNEL_SYNC_TICK_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 1,
  removeOnComplete: { count: 10 },
  removeOnFail: { count: 100 },
};

/** Giới hạn tải media tin đến: Messenger cho tối đa 25 MB mỗi tệp. */
export const INBOUND_MAX_MEDIA_BYTES = 25 * 1024 * 1024;

/** Số job xử lý song song cho từng hàng đợi. */
export const QUEUE_CONCURRENCY: Record<QueueName, number> = {
  [QUEUE_NAMES.system]: 2,
  [QUEUE_NAMES.inbound]: 10,
  [QUEUE_NAMES.outbound]: 5,
  [QUEUE_NAMES.aiReply]: 5,
  [QUEUE_NAMES.memoryUpdate]: 2,
  [QUEUE_NAMES.zaloOaTokenRefresh]: 1,
  // Giới hạn tần suất của Graph tính theo từng Trang, nên đồng bộ song song nhiều Trang không tăng rủi ro;
  // giữ vừa phải để không dồn quá nhiều kết nối DB/tải media cùng lúc khi kết nối hàng loạt Trang.
  [QUEUE_NAMES.channelSync]: 6,
};

/** Thời gian tối đa chờ các job đang chạy khi tắt worker. */
export const SHUTDOWN_TIMEOUT_MS = 15_000;

/** Thời gian tối đa chờ Redis sẵn sàng khi khởi động. */
export const REDIS_STARTUP_TIMEOUT_MS = 10_000;
