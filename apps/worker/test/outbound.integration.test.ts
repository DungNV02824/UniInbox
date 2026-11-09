// Test tích hợp hàng đợi outbound với Redis thật: thử lại lỗi tạm thời, không thử lại lỗi vĩnh viễn,
// hết lượt thì đánh dấu tin failed. Phần core (DB, connector) được thay bằng hàm giả.
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import {
  OUTBOUND_JOB_NAME,
  outboundJobId,
  OutboundNotReadyError,
  PermanentSendError,
  TransientSendError,
} from '@dezon/core';
import { QueueEvents } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startWorkerApp, type WorkerApp } from '../src/app';
import { createSilentLogger } from '../src/logger';
import { createRedisPublisher } from '../src/pipeline-runtime';
import { closeRedis, createRedisConnection } from '../src/redis';
import { outboundProcessor } from '../src/processors';
import { OUTBOUND_QUEUE, type OutboundHandlers } from '../src/processors/outbound.processor';

describe('outbound worker (Redis thật)', () => {
  let container: StartedRedisContainer;
  let app: WorkerApp;
  let events: QueueEvents;
  let redisUrl: string;
  const processMock = vi.fn<OutboundHandlers['process']>();
  const markFailed = vi.fn<OutboundHandlers['markFailed']>(async () => undefined);

  const add = (messageId: string) =>
    app.queues
      .get(OUTBOUND_QUEUE)!
      .add(
        OUTBOUND_JOB_NAME,
        { messageId },
        { jobId: outboundJobId(messageId), attempts: 3, backoff: { type: 'fixed', delay: 50 } },
      );

  beforeAll(async () => {
    container = await new RedisContainer('redis:7-alpine').start();
    redisUrl = container.getConnectionUrl();
    app = await startWorkerApp({
      redisUrl,
      logger: createSilentLogger(),
      processors: [outboundProcessor({ process: processMock, markFailed })],
    });
    events = new QueueEvents(OUTBOUND_QUEUE, { connection: { url: redisUrl } });
    await events.waitUntilReady();
  });

  afterAll(async () => {
    await events?.close();
    await app?.close();
    await container?.stop();
  });

  beforeEach(() => {
    processMock.mockReset();
    markFailed.mockClear();
  });

  it('thành công thì không đánh dấu failed', async () => {
    processMock.mockResolvedValue(undefined);
    const job = await add('msg-ok');
    await job.waitUntilFinished(events, 15_000);
    expect(processMock).toHaveBeenCalledWith('msg-ok');
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('lỗi tạm thời: thử đủ 3 lần rồi mới đánh dấu failed (1 lần)', async () => {
    processMock.mockRejectedValue(new TransientSendError('Graph API 503'));
    const job = await add('msg-transient');
    await expect(job.waitUntilFinished(events, 15_000)).rejects.toThrow(/503/);
    await vi.waitFor(() => expect(markFailed).toHaveBeenCalledOnce(), { timeout: 5_000 });
    expect(processMock).toHaveBeenCalledTimes(3);
    expect(markFailed).toHaveBeenCalledWith('msg-transient', expect.stringContaining('Graph API 503'));
  });

  it('lỗi vĩnh viễn: không thử lại, đánh dấu failed ngay', async () => {
    processMock.mockRejectedValue(new PermanentSendError('Người nhận không tồn tại'));
    const job = await add('msg-permanent');
    await expect(job.waitUntilFinished(events, 15_000)).rejects.toThrow(/Người nhận/);
    await vi.waitFor(() => expect(markFailed).toHaveBeenCalledOnce(), { timeout: 5_000 });
    expect(processMock).toHaveBeenCalledTimes(1);
  });

  it('tin trước chưa gửi xong: job được hoãn, không tốn lượt thử, chạy lại rồi hoàn thành', async () => {
    // Ném OutboundNotReadyError 4 lần (> attempts = 3) rồi mới thành công.
    let waits = 0;
    processMock.mockImplementation(async () => {
      if (waits++ < 4) throw new OutboundNotReadyError(50);
    });
    const job = await add('msg-wait');
    await job.waitUntilFinished(events, 15_000);
    expect(processMock).toHaveBeenCalledTimes(5);
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('jobId theo outboundJobId: thêm trùng không tạo job thứ hai', async () => {
    processMock.mockResolvedValue(undefined);
    const first = await add('msg-once');
    const second = await add('msg-once');
    expect(second.id).toBe(first.id);
  });

  it('RealtimePublisher phát qua Redis theo kênh của Socket.IO redis-adapter', async () => {
    const sub = createRedisConnection(redisUrl);
    const pub = createRedisConnection(redisUrl);
    try {
      const received = new Promise<string>((resolve) => {
        sub.on('pmessageBuffer', (_pattern: Buffer, channel: Buffer) => resolve(channel.toString()));
      });
      await sub.psubscribe('socket.io#*');
      createRedisPublisher(pub).emit(['role:admin'], 'conversation.updated', {
        conversation: {} as never,
      });
      await expect(received).resolves.toMatch(/^socket\.io#\/#role:admin#$/);
    } finally {
      await Promise.all([closeRedis(sub), closeRedis(pub)]);
    }
  });
});
