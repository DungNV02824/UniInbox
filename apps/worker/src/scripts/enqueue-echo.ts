// Đưa thủ công một job "echo" vào hàng đợi system rồi chờ kết quả.
// Dùng: pnpm --filter @dezon/worker enqueue:echo [thông điệp]
import { QueueEvents } from 'bullmq';
import { loadEnv, loadRootEnv } from '@dezon/shared/server';
import { SYSTEM_JOBS, SYSTEM_QUEUE } from '../processors/system.processor';
import { createQueue } from '../queues';
import { closeRedis, createRedisConnection } from '../redis';

const WAIT_TIMEOUT_MS = 15_000;

async function run(): Promise<void> {
  loadRootEnv();
  const env = loadEnv();
  const message = process.argv.slice(2).join(' ') || 'xin chào từ enqueue-echo';

  const connection = createRedisConnection(env.REDIS_URL);
  const eventsConnection = createRedisConnection(env.REDIS_URL);
  const queue = createQueue(SYSTEM_QUEUE, connection);
  const events = new QueueEvents(SYSTEM_QUEUE, { connection: eventsConnection });
  try {
    await events.waitUntilReady();
    const job = await queue.add(SYSTEM_JOBS.echo, { message, sentAt: new Date().toISOString() });
    console.log(`Đã thêm job echo id=${job.id}, đang chờ worker xử lý...`);
    const result: unknown = await job.waitUntilFinished(events, WAIT_TIMEOUT_MS);
    console.log('Kết quả:', JSON.stringify(result));
  } finally {
    await events.close();
    await queue.close();
    await Promise.all([closeRedis(connection), closeRedis(eventsConnection)]);
  }
}

run().catch((error: unknown) => {
  console.error('enqueue-echo thất bại:', error instanceof Error ? error.message : error);
  process.exit(1);
});
