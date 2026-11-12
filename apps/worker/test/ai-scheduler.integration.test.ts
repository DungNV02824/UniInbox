// Test tích hợp AiJobScheduler (BullMQ) với Redis thật: debounce "xóa và tạo lại" job ai-reply, khe nối tiếp
// khi job đang chạy, nhắc handoff, outbound tin bot có delay giãn bong bóng.
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import {
  AI_REPLY_JOB_NAME,
  aiReplyJobId,
  HANDOFF_REMINDER_JOB_NAME,
  handoffReminderJobId,
  OUTBOUND_JOB_NAME,
  outboundJobId,
  type AiJobScheduler,
} from '@dezon/core';
import { QUEUE_NAMES } from '@dezon/shared';
import { Worker, type Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { toDebounceRedis } from '../src/ai/runtime';
import { aiReplyFollowUpJobId, createBullAiJobScheduler } from '../src/ai/scheduler';
import { createSilentLogger } from '../src/logger';
import { createQueue } from '../src/queues';
import { closeRedis, createRedisConnection } from '../src/redis';

describe('AiJobScheduler BullMQ (Redis thật)', () => {
  let container: StartedRedisContainer;
  let redisUrl: string;
  let connection: Redis;
  let aiReplyQueue: Queue;
  let outboundQueue: Queue;
  let scheduler: AiJobScheduler;

  beforeAll(async () => {
    container = await new RedisContainer('redis:7-alpine').start();
    redisUrl = container.getConnectionUrl();
    connection = createRedisConnection(redisUrl);
    aiReplyQueue = createQueue(QUEUE_NAMES.aiReply, connection);
    outboundQueue = createQueue(QUEUE_NAMES.outbound, connection);
    scheduler = createBullAiJobScheduler({ aiReplyQueue, outboundQueue, logger: createSilentLogger() });
  });

  afterAll(async () => {
    await aiReplyQueue?.close();
    await outboundQueue?.close();
    if (connection) await closeRedis(connection);
    await container?.stop();
  });

  const state = async (queue: Queue, id: string) => (await queue.getJob(id))?.getState() ?? 'missing';
  const delayOf = async (queue: Queue, id: string) => (await queue.getJob(id))?.opts.delay;

  it('lên lịch lại thay job delayed cũ (một job, delay mới, data mới)', async () => {
    await scheduler.scheduleReply('c1', 10_000);
    const first = await aiReplyQueue.getJob(aiReplyJobId('c1'));
    expect(first?.name).toBe(AI_REPLY_JOB_NAME);
    expect(first?.data).toMatchObject({ conversationId: 'c1' });
    expect(await first?.getState()).toBe('delayed');
    expect(first?.opts.attempts).toBe(2);

    await scheduler.scheduleReply('c1', 25_000);
    expect(await delayOf(aiReplyQueue, aiReplyJobId('c1'))).toBe(25_000);
    expect(await state(aiReplyQueue, aiReplyJobId('c1'))).toBe('delayed');
    expect(await aiReplyQueue.getDelayedCount()).toBe(1);
    expect(await state(aiReplyQueue, aiReplyFollowUpJobId('c1'))).toBe('missing');
  });

  it('job đang chạy ⇒ dùng khe nối tiếp; xong thì quay về khe chính và xóa khe nối tiếp', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const processed: string[] = [];
    const worker = new Worker(
      QUEUE_NAMES.aiReply,
      async (job) => {
        processed.push(String(job.id));
        if (job.id === aiReplyJobId('c2')) await gate;
      },
      { connection: { url: redisUrl }, concurrency: 2 },
    );
    try {
      await scheduler.scheduleReply('c2', 0);
      await vi.waitFor(async () => expect(await state(aiReplyQueue, aiReplyJobId('c2'))).toBe('active'), {
        timeout: 10_000,
      });

      // Tin khách mới trong lúc job đang gọi LLM.
      await scheduler.scheduleReply('c2', 60_000);
      expect(await state(aiReplyQueue, aiReplyFollowUpJobId('c2'))).toBe('delayed');
      await scheduler.scheduleReply('c2', 30_000);
      expect(await delayOf(aiReplyQueue, aiReplyFollowUpJobId('c2'))).toBe(30_000);
      expect(await state(aiReplyQueue, aiReplyJobId('c2'))).toBe('active');

      release();
      // removeOnComplete: job chính biến mất khi xong.
      await vi.waitFor(async () => expect(await state(aiReplyQueue, aiReplyJobId('c2'))).toBe('missing'), {
        timeout: 10_000,
      });
    } finally {
      await worker.close();
    }

    await scheduler.scheduleReply('c2', 20_000);
    expect(await state(aiReplyQueue, aiReplyJobId('c2'))).toBe('delayed');
    expect(await delayOf(aiReplyQueue, aiReplyJobId('c2'))).toBe(20_000);
    expect(await state(aiReplyQueue, aiReplyFollowUpJobId('c2'))).toBe('missing');
    expect(processed).toEqual([aiReplyJobId('c2')]);
  });

  it('job cũ đã thất bại (cùng jobId) ⇒ xóa rồi tạo lại', async () => {
    const worker = new Worker(
      QUEUE_NAMES.aiReply,
      async () => {
        throw new Error('hỏng');
      },
      { connection: { url: redisUrl } },
    );
    try {
      await aiReplyQueue.add(
        AI_REPLY_JOB_NAME,
        { conversationId: 'c3', scheduledAt: new Date().toISOString() },
        { jobId: aiReplyJobId('c3'), attempts: 1, removeOnFail: false },
      );
      await vi.waitFor(async () => expect(await state(aiReplyQueue, aiReplyJobId('c3'))).toBe('failed'), {
        timeout: 10_000,
      });
    } finally {
      await worker.close();
    }
    await scheduler.scheduleReply('c3', 15_000);
    expect(await state(aiReplyQueue, aiReplyJobId('c3'))).toBe('delayed');
    expect(await delayOf(aiReplyQueue, aiReplyJobId('c3'))).toBe(15_000);
  });

  it('lượt đánh thức: khe trống ⇒ thêm job wakeup; đã có job chờ (kick / debounce) ⇒ KHÔNG thay', async () => {
    // Khe trống ⇒ thêm job ở khe chính, data.wakeup = true, đúng delay.
    await scheduler.scheduleWakeup('w1', 120_000);
    const wake = await aiReplyQueue.getJob(aiReplyJobId('w1'));
    expect(wake?.data).toMatchObject({ conversationId: 'w1', wakeup: true });
    expect(wake?.opts.delay).toBe(120_000);
    expect(await wake?.getState()).toBe('delayed');

    // Đã có job chờ ngắn (vd. kick sau "Tiếp tục AI") ⇒ lượt đánh thức dài KHÔNG đè lên.
    await scheduler.scheduleReply('w2', 5_000);
    await scheduler.scheduleWakeup('w2', 86_400_000);
    const kept = await aiReplyQueue.getJob(aiReplyJobId('w2'));
    expect(kept?.opts.delay).toBe(5_000);
    expect(kept?.data.wakeup).toBeUndefined();
    expect(await aiReplyQueue.getJob(aiReplyFollowUpJobId('w2'))).toBeUndefined();

    // Tin khách mới sau khi đã hẹn đánh thức ⇒ debounce thường thay job (job đó chạy, còn nghỉ thì tự hẹn lại).
    await scheduler.scheduleReply('w1', 3_000);
    const replaced = await aiReplyQueue.getJob(aiReplyJobId('w1'));
    expect(replaced?.opts.delay).toBe(3_000);
    expect(replaced?.data.wakeup).toBeUndefined();
  });

  it('nhắc handoff: jobId theo handoff, lên lịch lại thay job cũ', async () => {
    const data = { conversationId: 'c4', handoffId: 'h4' };
    await scheduler.scheduleHandoffReminder(data, 15 * 60_000);
    await scheduler.scheduleHandoffReminder(data, 5 * 60_000);
    const job = await aiReplyQueue.getJob(handoffReminderJobId('h4'));
    expect(job?.name).toBe(HANDOFF_REMINDER_JOB_NAME);
    expect(job?.data).toEqual(data);
    expect(job?.opts.delay).toBe(5 * 60_000);
    expect(job?.opts.attempts).toBe(3);
    expect(await job?.getState()).toBe('delayed');
  });

  it('outbound tin bot: jobId send-<id>, delay giãn bong bóng, tùy chọn thử lại của hàng đợi outbound', async () => {
    await scheduler.enqueueOutbound('m1', 0);
    await scheduler.enqueueOutbound('m2', 1_100);
    await scheduler.enqueueOutbound('m3', 2_450);
    const jobs = await Promise.all(['m1', 'm2', 'm3'].map((id) => outboundQueue.getJob(outboundJobId(id))));
    expect(jobs.map((j) => j?.name)).toEqual([OUTBOUND_JOB_NAME, OUTBOUND_JOB_NAME, OUTBOUND_JOB_NAME]);
    expect(jobs.map((j) => j?.data)).toEqual([{ messageId: 'm1' }, { messageId: 'm2' }, { messageId: 'm3' }]);
    expect(jobs.map((j) => j?.opts.delay)).toEqual([0, 1_100, 2_450]);
    expect(jobs[2]?.opts.attempts).toBe(3);
    expect(await jobs[0]?.getState()).toBe('waiting');
    expect(await jobs[2]?.getState()).toBe('delayed');
  });

  it('DebounceRedis qua ioredis: SET NX PX, GET, DEL', async () => {
    const r = toDebounceRedis(connection);
    expect(await r.set('debounce:x:first', '1', 'PX', 60_000, 'NX')).toBe('OK');
    expect(await r.set('debounce:x:first', '2', 'PX', 60_000, 'NX')).toBeNull();
    expect(await r.get('debounce:x:first')).toBe('1');
    expect(await connection.pttl('debounce:x:first')).toBeGreaterThan(0);
    expect(await r.del('debounce:x:first', 'debounce:x:last')).toBe(1);
  });
});
