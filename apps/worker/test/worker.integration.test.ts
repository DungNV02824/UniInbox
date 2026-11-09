// Test tích hợp: Redis thật qua Testcontainers (không dùng .env hay docker-compose).
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { QueueEvents } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorkerApp, type WorkerApp } from '../src/app';
import { createSilentLogger } from '../src/logger';
import {
  HEARTBEAT_EVERY_MS,
  HEARTBEAT_SCHEDULER_ID,
  SYSTEM_JOBS,
  SYSTEM_QUEUE,
} from '../src/processors/system.processor';

describe('worker (Redis thật)', () => {
  let container: StartedRedisContainer;
  let app: WorkerApp;
  let events: QueueEvents;

  beforeAll(async () => {
    container = await new RedisContainer('redis:7-alpine').start();
    const redisUrl = container.getConnectionUrl();
    app = await startWorkerApp({ redisUrl, logger: createSilentLogger() });
    events = new QueueEvents(SYSTEM_QUEUE, { connection: { url: redisUrl } });
    await events.waitUntilReady();
  });

  afterAll(async () => {
    await events?.close();
    await app?.close();
    await container?.stop();
  });

  it('xử lý job echo và trả về payload', async () => {
    const queue = app.queues.get(SYSTEM_QUEUE)!;
    const payload = { message: 'xin chào', items: [1, 2, 3] };
    const job = await queue.add(SYSTEM_JOBS.echo, payload);
    await expect(job.waitUntilFinished(events, 15_000)).resolves.toEqual(payload);
  });

  it('job lạ bị đánh dấu failed', async () => {
    const queue = app.queues.get(SYSTEM_QUEUE)!;
    const job = await queue.add('khong-ton-tai', {}, { attempts: 1 });
    await expect(job.waitUntilFinished(events, 15_000)).rejects.toThrow(/khong-ton-tai/);
  });

  it('Redis không kết nối được thì khởi động thất bại (không treo)', async () => {
    const started = Date.now();
    await expect(
      startWorkerApp({
        redisUrl: 'redis://127.0.0.1:1',
        logger: createSilentLogger(),
        redisStartupTimeoutMs: 1_000,
      }),
    ).rejects.toThrow(/Không kết nối được Redis/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('đã đăng ký lịch heartbeat mỗi 60s', async () => {
    const queue = app.queues.get(SYSTEM_QUEUE)!;
    const scheduler = await queue.getJobScheduler(HEARTBEAT_SCHEDULER_ID);
    expect(scheduler).toBeDefined();
    expect(scheduler?.name).toBe(SYSTEM_JOBS.heartbeat);
    expect(scheduler?.every).toBe(HEARTBEAT_EVERY_MS);
  });
});
