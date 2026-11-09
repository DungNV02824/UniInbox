// Test tích hợp hàng đợi channel-sync với Redis thật: đăng ký/gỡ lịch tick, tick đẩy job incremental
// (chống trùng theo jobId), backfill thử lại rồi ghi lỗi. Phần core (DB, Graph API) là hàm giả.
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import {
  CHANNEL_SYNC_JOB_NAME,
  CHANNEL_SYNC_TICK_JOB_NAME,
  channelSyncJobId,
  type ChannelSyncJobData,
} from '@dezon/core';
import { Queue, QueueEvents } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startWorkerApp, type WorkerApp } from '../src/app';
import { createSilentLogger } from '../src/logger';
import { channelSyncProcessor } from '../src/processors';
import {
  CHANNEL_SYNC_QUEUE,
  CHANNEL_SYNC_SCHEDULER_ID,
  registerChannelSyncSchedulers,
  type ChannelSyncHandlers,
} from '../src/processors/channel-sync.processor';

describe('channel-sync worker (Redis thật)', () => {
  let container: StartedRedisContainer;
  let app: WorkerApp;
  let events: QueueEvents;
  let redisUrl: string;
  const syncMock = vi.fn<ChannelSyncHandlers['sync']>();
  const listMock = vi.fn<ChannelSyncHandlers['listSyncTargets']>();
  const markBackfillQueued = vi.fn<ChannelSyncHandlers['markBackfillQueued']>(async () => undefined);
  const markBackfillFailed = vi.fn<ChannelSyncHandlers['markBackfillFailed']>(async () => undefined);
  // Giữ job tick sau khi xong để waitUntilFinished đọc được kết quả.
  const tickOpts = { attempts: 1, removeOnComplete: false };
  const queue = () => app.queues.get(CHANNEL_SYNC_QUEUE) as Queue<ChannelSyncJobData>;

  beforeAll(async () => {
    container = await new RedisContainer('redis:7-alpine').start();
    redisUrl = container.getConnectionUrl();
    app = await startWorkerApp({
      redisUrl,
      logger: createSilentLogger(),
      processors: [
        channelSyncProcessor(
          { sync: syncMock, listSyncTargets: listMock, markBackfillQueued, markBackfillFailed },
          // Lịch dài để tick tự động không xen vào test; test tự đẩy job tick.
          { intervalSec: 3_600, historyDays: 30 },
        ),
      ],
    });
    events = new QueueEvents(CHANNEL_SYNC_QUEUE, { connection: { url: redisUrl } });
    await events.waitUntilReady();
  });

  afterAll(async () => {
    await events?.close();
    await app?.close();
    await container?.stop();
  });

  beforeEach(() => {
    syncMock.mockReset();
    listMock.mockReset();
    markBackfillFailed.mockClear();
  });

  it('khởi động đã đăng ký lịch tick theo MESSENGER_SYNC_INTERVAL_SEC', async () => {
    const scheduler = await queue().getJobScheduler(CHANNEL_SYNC_SCHEDULER_ID);
    expect(scheduler?.name).toBe(CHANNEL_SYNC_TICK_JOB_NAME);
    expect(Number(scheduler?.every)).toBe(3_600_000);
  });

  it('đổi interval thì cập nhật lịch; interval = 0 thì gỡ lịch (idempotent)', async () => {
    const q = new Queue(CHANNEL_SYNC_QUEUE, { connection: { url: redisUrl } });
    try {
      await registerChannelSyncSchedulers(q, { intervalSec: 120, historyDays: 30 });
      expect(Number((await q.getJobScheduler(CHANNEL_SYNC_SCHEDULER_ID))?.every)).toBe(120_000);
      expect(await q.getJobSchedulersCount()).toBe(1);

      await registerChannelSyncSchedulers(q, { intervalSec: 0, historyDays: 30 });
      // getJobScheduler trả object rỗng khi đã gỡ: kiểm bằng danh sách lịch.
      expect(await q.getJobSchedulersCount()).toBe(0);
      await registerChannelSyncSchedulers(q, { intervalSec: 0, historyDays: 30 });
      expect(await q.getJobSchedulersCount()).toBe(0);

      // Trả lại lịch như lúc khởi động cho các test sau.
      await registerChannelSyncSchedulers(q, { intervalSec: 3_600, historyDays: 30 });
    } finally {
      await q.close();
    }
  });

  it('tick đẩy job incremental cho từng kênh; job xong bị xóa nên tick sau chạy lại được', async () => {
    listMock.mockResolvedValue([
      { id: 'ch-a', needsBackfill: false },
      { id: 'ch-b', needsBackfill: false },
    ]);
    syncMock.mockResolvedValue({ conversations: 1, messagesStored: 0, messagesSkipped: 2 });

    for (let round = 1; round <= 2; round++) {
      const tick = await queue().add(CHANNEL_SYNC_TICK_JOB_NAME, {} as ChannelSyncJobData, tickOpts);
      await expect(tick.waitUntilFinished(events, 15_000)).resolves.toEqual({
        enqueued: 2,
        backfills: 0,
        skipped: 0,
      });
      await vi.waitFor(() => expect(syncMock).toHaveBeenCalledTimes(2 * round), { timeout: 10_000 });
      // removeOnComplete: job incremental không còn trong Redis => không chặn tick sau.
      // Chờ cả hai kênh (job incremental còn đọc trạng thái backfill trước khi gọi core).
      for (const ch of ['ch-a', 'ch-b']) {
        await vi.waitFor(
          async () => expect(await queue().getJob(channelSyncJobId(ch, 'incremental'))).toBeUndefined(),
          { timeout: 5_000 },
        );
      }
    }
    expect(syncMock).toHaveBeenCalledWith('ch-a', { mode: 'incremental' });
    expect(syncMock).toHaveBeenCalledWith('ch-b', { mode: 'incremental' });
  });

  it('chống trùng: kênh đang đồng bộ thì tick không đẩy thêm job', async () => {
    listMock.mockResolvedValue([{ id: 'ch-slow', needsBackfill: false }]);
    let release!: () => void;
    syncMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ conversations: 0, messagesStored: 0, messagesSkipped: 0 });
        }),
    );
    const first = await queue().add(CHANNEL_SYNC_TICK_JOB_NAME, {} as ChannelSyncJobData, tickOpts);
    await expect(first.waitUntilFinished(events, 15_000)).resolves.toEqual({
      enqueued: 1,
      backfills: 0,
      skipped: 0,
    });
    await vi.waitFor(() => expect(syncMock).toHaveBeenCalledOnce(), { timeout: 10_000 });

    const second = await queue().add(CHANNEL_SYNC_TICK_JOB_NAME, {} as ChannelSyncJobData, tickOpts);
    await expect(second.waitUntilFinished(events, 15_000)).resolves.toEqual({
      enqueued: 0,
      backfills: 0,
      skipped: 1,
    });
    release();
    await vi.waitFor(
      async () => expect(await queue().getJob(channelSyncJobId('ch-slow', 'incremental'))).toBeUndefined(),
      { timeout: 5_000 },
    );
    expect(syncMock).toHaveBeenCalledOnce();
  });

  it('kênh chưa từng đồng bộ lịch sử: tick đẩy backfill MESSENGER_HISTORY_DAYS', async () => {
    listMock.mockResolvedValue([{ id: 'ch-new', needsBackfill: true }]);
    syncMock.mockResolvedValue({ conversations: 3, messagesStored: 9, messagesSkipped: 0 });
    const tick = await queue().add(CHANNEL_SYNC_TICK_JOB_NAME, {} as ChannelSyncJobData, tickOpts);
    await expect(tick.waitUntilFinished(events, 15_000)).resolves.toEqual({
      enqueued: 1,
      backfills: 1,
      skipped: 0,
    });
    await vi.waitFor(() => expect(syncMock).toHaveBeenCalledWith('ch-new', { mode: 'backfill', days: 30 }), {
      timeout: 10_000,
    });
    expect(markBackfillQueued).toHaveBeenCalledWith('ch-new');
    await vi.waitFor(
      async () => expect(await queue().getJob(channelSyncJobId('ch-new', 'backfill'))).toBeUndefined(),
      { timeout: 5_000 },
    );
  });

  it('backfill lỗi: thử đủ số lượt rồi ghi lỗi đồng bộ lịch sử (1 lần)', async () => {
    syncMock.mockRejectedValue(new Error('Graph API 500'));
    const job = await queue().add(
      CHANNEL_SYNC_JOB_NAME,
      { channelAccountId: 'ch-x', mode: 'backfill', days: 7 },
      { jobId: channelSyncJobId('ch-x', 'backfill'), backoff: { type: 'fixed', delay: 50 } },
    );
    await expect(job.waitUntilFinished(events, 15_000)).rejects.toThrow(/500/);
    await vi.waitFor(() => expect(markBackfillFailed).toHaveBeenCalledOnce(), { timeout: 5_000 });
    expect(syncMock).toHaveBeenCalledTimes(3);
    expect(syncMock).toHaveBeenCalledWith('ch-x', { mode: 'backfill', days: 7 });
    expect(markBackfillFailed).toHaveBeenCalledWith('ch-x', expect.stringContaining('Graph API 500'));
    // removeOnFail: admin bấm "Đồng bộ lịch sử" lần nữa vẫn đẩy được job cùng jobId.
    await vi.waitFor(
      async () => expect(await queue().getJob(channelSyncJobId('ch-x', 'backfill'))).toBeUndefined(),
      { timeout: 5_000 },
    );
  });
});
