import {
  CHANNEL_SYNC_JOB_NAME,
  CHANNEL_SYNC_TICK_JOB_NAME,
  channelSyncJobId,
  PermanentSendError,
  type ChannelSyncJobData,
} from '@dezon/core';
import { UnrecoverableError, type Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '../logger';
import {
  createChannelSyncFailedHandler,
  createChannelSyncProcessor,
  runChannelSyncTick,
  type ChannelSyncHandlers,
  type SyncQueue,
} from './channel-sync.processor';

type FakeState = 'waiting' | 'active' | 'delayed' | 'completed' | 'failed';

/** Queue giả: lưu job theo id; add trùng id thì bỏ qua như BullMQ. */
function fakeQueue(initial: Record<string, FakeState> = {}) {
  const jobs = new Map<string, FakeState>(Object.entries(initial));
  const added: { name: string; data: ChannelSyncJobData; opts: Record<string, unknown> }[] = [];
  const removed: string[] = [];
  const queue = {
    getJob: vi.fn(async (id: string) => {
      const state = jobs.get(id);
      if (!state) return undefined;
      return {
        getState: async () => state,
        remove: async () => {
          jobs.delete(id);
          removed.push(id);
        },
      };
    }),
    add: vi.fn(async (name: string, data: ChannelSyncJobData, opts: { jobId: string }) => {
      if (!jobs.has(opts.jobId)) {
        jobs.set(opts.jobId, 'waiting');
        added.push({ name, data, opts });
      }
      return {};
    }),
  };
  return { queue: queue as unknown as SyncQueue, jobs, added, removed };
}

const result = { conversations: 2, messagesStored: 3, messagesSkipped: 1 };

function handlers(overrides: Partial<ChannelSyncHandlers> = {}): ChannelSyncHandlers {
  return {
    sync: vi.fn(async () => result),
    listSyncTargets: vi.fn(async () => [
      { id: 'ch-1', needsBackfill: false },
      { id: 'ch-2', needsBackfill: false },
    ]),
    markBackfillQueued: vi.fn(async () => undefined),
    markBackfillFailed: vi.fn(async () => undefined),
    ...overrides,
  };
}

const config = { intervalSec: 60, historyDays: 30 };

describe('runChannelSyncTick', () => {
  it('đẩy một job incremental cho mỗi kênh Messenger đang kết nối', async () => {
    const { queue, added } = fakeQueue();
    const res = await runChannelSyncTick(queue, handlers(), 30);
    expect(res).toEqual({ enqueued: 2, backfills: 0, skipped: 0 });
    expect(added).toEqual([
      {
        name: CHANNEL_SYNC_JOB_NAME,
        data: { channelAccountId: 'ch-1', mode: 'incremental' },
        opts: expect.objectContaining({
          jobId: channelSyncJobId('ch-1', 'incremental'),
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
        }),
      },
      expect.objectContaining({ data: { channelAccountId: 'ch-2', mode: 'incremental' } }),
    ]);
  });

  it('không có kênh nào (ngắt kết nối / loại khác đã bị lọc) thì không đẩy job', async () => {
    const { queue, added } = fakeQueue();
    const res = await runChannelSyncTick(queue, handlers({ listSyncTargets: async () => [] }), 30);
    expect(res).toEqual({ enqueued: 0, backfills: 0, skipped: 0 });
    expect(added).toHaveLength(0);
  });

  it('chống trùng: bỏ qua kênh có job incremental đang chờ/chạy hoặc đang đồng bộ lịch sử', async () => {
    const { queue, added } = fakeQueue({
      [channelSyncJobId('ch-1', 'incremental')]: 'active',
      [channelSyncJobId('ch-2', 'backfill')]: 'delayed',
    });
    const res = await runChannelSyncTick(queue, handlers(), 30);
    expect(res).toEqual({ enqueued: 0, backfills: 0, skipped: 2 });
    expect(added).toHaveLength(0);
  });

  it('job cùng id đã xong nhưng còn lưu thì xóa rồi đẩy lại (không chặn tick sau)', async () => {
    const { queue, added, removed } = fakeQueue({
      [channelSyncJobId('ch-1', 'incremental')]: 'completed',
      [channelSyncJobId('ch-2', 'backfill')]: 'failed',
    });
    const res = await runChannelSyncTick(queue, handlers(), 30);
    expect(res).toEqual({ enqueued: 2, backfills: 0, skipped: 0 });
    expect(added).toHaveLength(2);
    expect(removed).toEqual([channelSyncJobId('ch-1', 'incremental'), channelSyncJobId('ch-2', 'backfill')]);
  });

  it('kênh chưa từng đồng bộ lịch sử: đẩy backfill MESSENGER_HISTORY_DAYS thay vì incremental', async () => {
    const { queue, added } = fakeQueue();
    const h = handlers({
      listSyncTargets: async () => [
        { id: 'ch-new', needsBackfill: true },
        { id: 'ch-old', needsBackfill: false },
      ],
    });
    const res = await runChannelSyncTick(queue, h, 45);
    expect(res).toEqual({ enqueued: 2, backfills: 1, skipped: 0 });
    expect(h.markBackfillQueued).toHaveBeenCalledWith('ch-new');
    expect(added[0]).toEqual({
      name: CHANNEL_SYNC_JOB_NAME,
      data: { channelAccountId: 'ch-new', mode: 'backfill', days: 45 },
      opts: expect.objectContaining({
        jobId: channelSyncJobId('ch-new', 'backfill'),
        attempts: 3,
        removeOnComplete: true,
        removeOnFail: true,
      }),
    });
    expect(added[1]).toMatchObject({ data: { channelAccountId: 'ch-old', mode: 'incremental' } });
    // Tick sau: các job còn chờ => không đẩy thêm (kể cả backfill).
    const again = await runChannelSyncTick(queue, h, 45);
    expect(again).toEqual({ enqueued: 0, backfills: 0, skipped: 2 });
    expect(h.markBackfillQueued).toHaveBeenCalledOnce();
  });

  it('hai tick liên tiếp khi job chưa chạy: chỉ một job mỗi kênh', async () => {
    const { queue, added } = fakeQueue();
    await runChannelSyncTick(queue, handlers(), 30);
    const second = await runChannelSyncTick(queue, handlers(), 30);
    expect(second).toEqual({ enqueued: 0, backfills: 0, skipped: 2 });
    expect(added).toHaveLength(2);
  });
});

describe('channel-sync processor', () => {
  const logger = createSilentLogger();
  const job = (data: ChannelSyncJobData, name = CHANNEL_SYNC_JOB_NAME) => ({ id: 'j1', name, data });

  it('backfill: gọi core với số ngày của job', async () => {
    const h = handlers();
    const run = createChannelSyncProcessor({ handlers: h, config, queue: fakeQueue().queue, logger });
    await expect(run(job({ channelAccountId: 'ch-1', mode: 'backfill', days: 7 }))).resolves.toEqual(result);
    expect(h.sync).toHaveBeenCalledWith('ch-1', { mode: 'backfill', days: 7 });
  });

  it('backfill không có days: dùng MESSENGER_HISTORY_DAYS', async () => {
    const h = handlers();
    const run = createChannelSyncProcessor({ handlers: h, config, queue: fakeQueue().queue, logger });
    await run(job({ channelAccountId: 'ch-1', mode: 'backfill' }));
    expect(h.sync).toHaveBeenCalledWith('ch-1', { mode: 'backfill', days: 30 });
  });

  it('incremental: gọi core không kèm days', async () => {
    const h = handlers();
    const run = createChannelSyncProcessor({ handlers: h, config, queue: fakeQueue().queue, logger });
    await run(job({ channelAccountId: 'ch-2', mode: 'incremental', days: 99 }));
    expect(h.sync).toHaveBeenCalledWith('ch-2', { mode: 'incremental' });
  });

  it('incremental gặp backfill đang chờ/chạy của cùng kênh: bỏ lượt, không gọi core', async () => {
    const h = handlers();
    const fq = fakeQueue({ [channelSyncJobId('ch-1', 'backfill')]: 'active' });
    const run = createChannelSyncProcessor({ handlers: h, config, queue: fq.queue, logger });
    await expect(run(job({ channelAccountId: 'ch-1', mode: 'incremental' }))).resolves.toEqual({
      skipped: 'backfill',
    });
    expect(h.sync).not.toHaveBeenCalled();
  });

  it('backfill chờ incremental đang chạy của cùng kênh xong rồi mới chạy', async () => {
    const h = handlers();
    const fq = fakeQueue({ [channelSyncJobId('ch-1', 'incremental')]: 'active' });
    let sleeps = 0;
    const sleep = vi.fn(async () => {
      sleeps++;
      if (sleeps === 3) fq.jobs.delete(channelSyncJobId('ch-1', 'incremental'));
    });
    const run = createChannelSyncProcessor({ handlers: h, config, queue: fq.queue, logger, sleep });
    await run(job({ channelAccountId: 'ch-1', mode: 'backfill', days: 7 }));
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(h.sync).toHaveBeenCalledOnce();
  });

  it('backfill chờ quá lâu thì vẫn chạy', async () => {
    const h = handlers();
    const fq = fakeQueue({ [channelSyncJobId('ch-1', 'incremental')]: 'active' });
    const sleep = vi.fn(async () => undefined);
    const run = createChannelSyncProcessor({
      handlers: h,
      config,
      queue: fq.queue,
      logger,
      sleep,
      backfillWaitMaxMs: 3_000,
    });
    await run(job({ channelAccountId: 'ch-1', mode: 'backfill' }));
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(h.sync).toHaveBeenCalledOnce();
  });

  it('incremental lỗi: không ném (core đã ghi lỗi, tick sau chạy lại)', async () => {
    const h = handlers({
      sync: vi.fn(async () => Promise.reject(new PermanentSendError('Thiếu quyền', false))),
    });
    const run = createChannelSyncProcessor({ handlers: h, config, queue: fakeQueue().queue, logger });
    await expect(run(job({ channelAccountId: 'ch-1', mode: 'incremental' }))).resolves.toEqual({
      failed: true,
    });
  });

  it('lỗi từ core được ném lại để BullMQ thử lại', async () => {
    const h = handlers({ sync: vi.fn(async () => Promise.reject(new Error('Graph API 500'))) });
    const run = createChannelSyncProcessor({ handlers: h, config, queue: fakeQueue().queue, logger });
    await expect(run(job({ channelAccountId: 'ch-1', mode: 'backfill' }))).rejects.toThrow(/500/);
  });

  it('PermanentSendError (token hỏng, thiếu quyền) thành UnrecoverableError: không thử lại', async () => {
    const h = handlers({
      sync: vi.fn(async () => Promise.reject(new PermanentSendError('Token hết hạn', true, 190))),
    });
    const run = createChannelSyncProcessor({ handlers: h, config, queue: fakeQueue().queue, logger });
    const err = await run(job({ channelAccountId: 'ch-1', mode: 'backfill' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toBe('Token hết hạn');
  });

  it('job tick đẩy job incremental', async () => {
    const fq = fakeQueue();
    const run = createChannelSyncProcessor({ handlers: handlers(), config, queue: fq.queue, logger });
    const res = await run(job({} as ChannelSyncJobData, CHANNEL_SYNC_TICK_JOB_NAME));
    expect(res).toEqual({ enqueued: 2, backfills: 0, skipped: 0 });
    expect(fq.added).toHaveLength(2);
  });

  it('job lạ thì ném lỗi', async () => {
    const run = createChannelSyncProcessor({
      handlers: handlers(),
      config,
      queue: fakeQueue().queue,
      logger,
    });
    await expect(run(job({ channelAccountId: 'x', mode: 'backfill' }, 'khac'))).rejects.toThrow(/khac/);
  });
});

describe('channel-sync failed handler', () => {
  const logger = createSilentLogger();
  const failedJob = (data: ChannelSyncJobData, attemptsMade: number, attempts = 3) =>
    ({
      id: 'j1',
      name: CHANNEL_SYNC_JOB_NAME,
      data,
      attemptsMade,
      opts: { attempts },
    }) as unknown as Job<ChannelSyncJobData>;

  it('backfill hết lượt: tắt backfillRunning + ghi lỗi', async () => {
    const h = handlers();
    await createChannelSyncFailedHandler(h)(
      failedJob({ channelAccountId: 'ch-1', mode: 'backfill' }, 3),
      new Error('Token hết hạn'),
      logger,
    );
    expect(h.markBackfillFailed).toHaveBeenCalledWith('ch-1', expect.stringContaining('Token hết hạn'));
  });

  it('backfill còn lượt thử: chưa ghi lỗi', async () => {
    const h = handlers();
    await createChannelSyncFailedHandler(h)(
      failedJob({ channelAccountId: 'ch-1', mode: 'backfill' }, 1),
      new Error('x'),
      logger,
    );
    expect(h.markBackfillFailed).not.toHaveBeenCalled();
  });

  it('incremental thất bại: không đụng trạng thái backfill', async () => {
    const h = handlers();
    await createChannelSyncFailedHandler(h)(
      failedJob({ channelAccountId: 'ch-1', mode: 'incremental' }, 1, 1),
      new Error('x'),
      logger,
    );
    expect(h.markBackfillFailed).not.toHaveBeenCalled();
  });

  it('ghi lỗi thất bại thì chỉ log, không ném', async () => {
    const h = handlers({ markBackfillFailed: vi.fn(async () => Promise.reject(new Error('DB down'))) });
    await expect(
      createChannelSyncFailedHandler(h)(
        failedJob({ channelAccountId: 'ch-1', mode: 'backfill' }, 3),
        new Error('x'),
        logger,
      ),
    ).resolves.toBeUndefined();
  });
});
