// Hàng đợi "channel-sync": đồng bộ hội thoại Messenger qua Conversations API (bổ sung cho webhook).
// - job "sync": chạy syncMessengerAccount cho một kênh (backfill hoặc incremental).
// - job "tick" (scheduler mỗi MESSENGER_SYNC_INTERVAL_SEC): đẩy job incremental cho mọi kênh đang kết nối
//   (kênh chưa từng đồng bộ lịch sử thì đẩy backfill thay vì incremental).
// Hai chế độ không chạy chồng trên một kênh: incremental gặp backfill đang chờ/chạy thì bỏ lượt; backfill
// gặp incremental đang chạy thì chờ nó xong.
import { UnrecoverableError, type Job, type JobsOptions, type Queue } from 'bullmq';
import {
  CHANNEL_SYNC_JOB_NAME,
  CHANNEL_SYNC_TICK_JOB_NAME,
  channelSyncJobId,
  PermanentSendError,
  syncMessengerAccount,
  syncTickPlan,
  writeSyncState,
  type ChannelSyncJobData,
  type SyncOptions,
  type SyncResult,
} from '@dezon/core';
import { QUEUE_NAMES } from '@dezon/shared';
import { CHANNEL_SYNC_JOB_OPTIONS, CHANNEL_SYNC_TICK_JOB_OPTIONS } from '../config';
import type { Logger } from '../logger';
import type { PipelineRuntime } from '../pipeline-runtime';
import { isFinalFailure } from './outbound.processor';

export const CHANNEL_SYNC_QUEUE = QUEUE_NAMES.channelSync;
export const CHANNEL_SYNC_SCHEDULER_ID = 'channel-sync:tick';

export interface ChannelSyncConfig {
  /** MESSENGER_SYNC_INTERVAL_SEC: 0 = tắt đồng bộ định kỳ. */
  intervalSec: number;
  /** MESSENGER_HISTORY_DAYS: số ngày lịch sử mặc định cho backfill. */
  historyDays: number;
}

/** Kênh cần đồng bộ ở tick này. */
export interface SyncTarget {
  id: string;
  /** Chưa từng đồng bộ lịch sử => tick đẩy backfill thay vì incremental. */
  needsBackfill: boolean;
}

/** Sau khi backfill thất bại hẳn: tạm dừng đồng bộ định kỳ (và backfill tự động) của kênh 15 phút. */
export const BACKFILL_FAILED_PAUSE_MS = 15 * 60_000;

/** Phần core/DB dùng trong processor — tách ra để test có thể thay thế. */
export interface ChannelSyncHandlers {
  sync: (channelAccountId: string, opts: SyncOptions) => Promise<SyncResult>;
  /**
   * Kênh Messenger đang kết nối và không bị tạm dừng (pausedUntil). Rỗng nếu worker không có connector
   * Messenger (thiếu META_*: đã cảnh báo một lần lúc khởi động, không đẩy job lỗi mỗi phút).
   */
  listSyncTargets: () => Promise<SyncTarget[]>;
  /** Tick tự đẩy backfill: bật cờ backfillRunning (trang Kênh hiện "Đang đồng bộ lịch sử…"). */
  markBackfillQueued: (channelAccountId: string) => Promise<void>;
  /** Backfill thất bại hẳn: tắt cờ backfillRunning + ghi lỗi + tạm dừng (core có thể đã ghi — idempotent). */
  markBackfillFailed: (channelAccountId: string, error: string) => Promise<void>;
}

export function channelSyncHandlers(runtime: PipelineRuntime): ChannelSyncHandlers {
  const { db, deps } = runtime;
  return {
    sync: (id, opts) => syncMessengerAccount(db, deps, id, opts),
    listSyncTargets: async () => {
      if (!deps.connectors.messenger) return [];
      // Số kênh nhỏ: lọc trong bộ nhớ (toán tử drizzle-orm không phải dependency của worker).
      const rows = await db.query.channelAccounts.findMany({
        columns: { id: true, type: true, status: true, settings: true },
      });
      const now = deps.ctx.now();
      return rows
        .filter((r) => r.type === 'messenger' && r.status === 'connected')
        .flatMap((r) => {
          const plan = syncTickPlan(r.settings, now);
          return plan.paused ? [] : [{ id: r.id, needsBackfill: plan.needsBackfill }];
        });
    },
    markBackfillQueued: (id) => writeSyncState(db, id, { backfillRunning: true }),
    markBackfillFailed: (id, error) => {
      const now = deps.ctx.now();
      return writeSyncState(db, id, {
        backfillRunning: false,
        lastError: error,
        lastErrorAt: now.toISOString(),
        pausedUntil: new Date(now.getTime() + BACKFILL_FAILED_PAUSE_MS).toISOString(),
      });
    },
  };
}

/** Phần Queue mà tick cần (để test dùng bản giả). */
export type SyncQueue = Pick<Queue<ChannelSyncJobData>, 'add' | 'getJob'>;

export interface TickResult {
  /** Số job đã đẩy (incremental + backfill). */
  enqueued: number;
  /** Trong đó số job backfill (kênh chưa từng đồng bộ lịch sử). */
  backfills: number;
  skipped: number;
}

/** Job còn đang chờ/chạy/hoãn (chưa xong) thì không đẩy thêm. */
async function isPending(queue: SyncQueue, jobId: string): Promise<boolean> {
  const job = await queue.getJob(jobId);
  if (!job) return false;
  const state = await job.getState();
  if (state !== 'completed' && state !== 'failed' && state !== 'unknown') return true;
  // Job cùng id đã xong nhưng còn lưu (đẩy thiếu removeOnComplete): xóa để không chặn lần sau.
  await job.remove().catch(() => undefined);
  return false;
}

async function isActive(queue: SyncQueue, jobId: string): Promise<boolean> {
  const job = await queue.getJob(jobId);
  return job ? (await job.getState()) === 'active' : false;
}

/**
 * Đẩy job cho mỗi kênh Messenger cần đồng bộ: incremental, hoặc backfill `historyDays` ngày nếu kênh chưa
 * từng đồng bộ lịch sử (kênh kết nối trước khi có tính năng, backfill lỗi hẳn). Bỏ qua kênh đã có job
 * incremental/backfill chưa xong (jobId cố định nên BullMQ cũng tự chống trùng).
 */
export async function runChannelSyncTick(
  queue: SyncQueue,
  handlers: Pick<ChannelSyncHandlers, 'listSyncTargets' | 'markBackfillQueued'>,
  historyDays: number,
): Promise<TickResult> {
  const targets = await handlers.listSyncTargets();
  const result: TickResult = { enqueued: 0, backfills: 0, skipped: 0 };
  for (const { id: channelAccountId, needsBackfill } of targets) {
    const incrementalId = channelSyncJobId(channelAccountId, 'incremental');
    const backfillId = channelSyncJobId(channelAccountId, 'backfill');
    const busy = (await isPending(queue, incrementalId)) || (await isPending(queue, backfillId));
    if (busy) {
      result.skipped += 1;
      continue;
    }
    if (needsBackfill) {
      // Ghi cờ TRƯỚC khi đẩy: job có thể chạy xong (ghi false) trước khi add() trả về.
      await handlers.markBackfillQueued(channelAccountId);
      const opts: JobsOptions = { ...CHANNEL_SYNC_JOB_OPTIONS.backfill, jobId: backfillId };
      const data: ChannelSyncJobData = { channelAccountId, mode: 'backfill', days: historyDays };
      await queue.add(CHANNEL_SYNC_JOB_NAME, data, opts);
      result.backfills += 1;
    } else {
      const opts: JobsOptions = { ...CHANNEL_SYNC_JOB_OPTIONS.incremental, jobId: incrementalId };
      await queue.add(CHANNEL_SYNC_JOB_NAME, { channelAccountId, mode: 'incremental' }, opts);
    }
    result.enqueued += 1;
  }
  return result;
}

/** Backfill chờ incremental đang chạy của cùng kênh xong (incremental thường vài giây). */
export const BACKFILL_WAIT_MAX_MS = 2 * 60_000;
const BACKFILL_WAIT_STEP_MS = 1_000;

export interface ChannelSyncProcessorContext {
  handlers: ChannelSyncHandlers;
  config: ChannelSyncConfig;
  queue: SyncQueue;
  logger: Pick<Logger, 'info' | 'debug' | 'warn'>;
  /** Thay được trong test. */
  sleep?: (ms: number) => Promise<void>;
  backfillWaitMaxMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createChannelSyncProcessor(ctx: ChannelSyncProcessorContext) {
  const { handlers, config, queue, logger } = ctx;
  const sleep = ctx.sleep ?? defaultSleep;
  const waitMax = ctx.backfillWaitMaxMs ?? BACKFILL_WAIT_MAX_MS;

  /** Backfill: chờ incremental đang chạy của kênh xong để hai chế độ không chạy chồng. */
  async function waitForIncremental(channelAccountId: string): Promise<void> {
    const id = channelSyncJobId(channelAccountId, 'incremental');
    for (let waited = 0; await isActive(queue, id); waited += BACKFILL_WAIT_STEP_MS) {
      if (waited >= waitMax) {
        logger.warn({ channelAccountId }, 'Đồng bộ định kỳ chạy quá lâu, vẫn bắt đầu đồng bộ lịch sử');
        return;
      }
      await sleep(BACKFILL_WAIT_STEP_MS);
    }
  }

  return async (job: Pick<Job<ChannelSyncJobData>, 'id' | 'name' | 'data'>): Promise<unknown> => {
    switch (job.name) {
      case CHANNEL_SYNC_TICK_JOB_NAME: {
        const result = await runChannelSyncTick(queue, handlers, config.historyDays);
        logger.debug({ jobId: job.id, ...result }, 'Tick đồng bộ kênh');
        return result;
      }
      case CHANNEL_SYNC_JOB_NAME: {
        const { channelAccountId, mode } = job.data;
        if (mode === 'incremental') {
          // Backfill đang chờ/chạy sẽ đọc cả phần này: bỏ lượt (tick sau chạy lại).
          if (await isPending(queue, channelSyncJobId(channelAccountId, 'backfill'))) {
            logger.debug({ jobId: job.id, channelAccountId }, 'Đang đồng bộ lịch sử, bỏ lượt định kỳ');
            return { skipped: 'backfill' };
          }
        } else {
          await waitForIncremental(channelAccountId);
        }
        const opts: SyncOptions =
          mode === 'backfill' ? { mode, days: job.data.days ?? config.historyDays } : { mode };
        const started = Date.now();
        let result: SyncResult;
        try {
          result = await handlers.sync(channelAccountId, opts);
        } catch (error) {
          // Incremental: core đã log + ghi lỗi vào sync state, tick sau tự chạy lại => không ném (tránh
          // thêm một dòng "Job thất bại" kèm stack mỗi phút).
          if (mode === 'incremental') {
            logger.debug({ jobId: job.id, channelAccountId }, 'Đồng bộ định kỳ lỗi, chờ tick sau');
            return { failed: true };
          }
          // Token hỏng / thiếu quyền / máy chủ chưa cấu hình: thử lại vô ích (core đã ghi lỗi vào sync state).
          if (error instanceof PermanentSendError) throw new UnrecoverableError(error.message);
          throw error;
        }
        // Chỉ log số đếm, không log nội dung tin nhắn. Incremental không có tin mới thì để debug.
        const level = mode === 'backfill' || result.messagesStored > 0 ? 'info' : 'debug';
        logger[level](
          { jobId: job.id, channelAccountId, mode, ...result, ms: Date.now() - started },
          'Đồng bộ kênh xong',
        );
        return result;
      }
      default:
        throw new Error(`Job không hỗ trợ trong hàng đợi "${CHANNEL_SYNC_QUEUE}": ${job.name}`);
    }
  };
}

/** Backfill thất bại hẳn (hết lượt) thì đảm bảo trạng thái không kẹt ở "đang đồng bộ". */
export function createChannelSyncFailedHandler(handlers: ChannelSyncHandlers) {
  return async (job: Job<ChannelSyncJobData>, error: Error, logger: Logger): Promise<void> => {
    if (job.name !== CHANNEL_SYNC_JOB_NAME || job.data.mode !== 'backfill') return;
    if (!isFinalFailure(job, error)) return;
    try {
      await handlers.markBackfillFailed(
        job.data.channelAccountId,
        `Đồng bộ lịch sử thất bại: ${error.message}`,
      );
    } catch (markError) {
      logger.error({ jobId: job.id, err: markError }, 'Không ghi được lỗi đồng bộ lịch sử');
    }
  };
}

/** Đăng ký (hoặc cập nhật) lịch tick; interval = 0 thì gỡ lịch. Idempotent. */
export async function registerChannelSyncSchedulers(queue: Queue, config: ChannelSyncConfig): Promise<void> {
  if (config.intervalSec <= 0) {
    await queue.removeJobScheduler(CHANNEL_SYNC_SCHEDULER_ID);
    return;
  }
  await queue.upsertJobScheduler(
    CHANNEL_SYNC_SCHEDULER_ID,
    { every: config.intervalSec * 1_000 },
    { name: CHANNEL_SYNC_TICK_JOB_NAME, data: {}, opts: CHANNEL_SYNC_TICK_JOB_OPTIONS },
  );
}
