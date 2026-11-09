import { Worker, type Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { QUEUE_CONCURRENCY, REDIS_STARTUP_TIMEOUT_MS, SHUTDOWN_TIMEOUT_MS } from './config';
import type { Logger } from './logger';
import { PROCESSORS, type ProcessorDefinition } from './processors';
import { createQueue } from './queues';
import { closeRedis, createRedisConnection, waitForRedis } from './redis';

export interface WorkerAppOptions {
  redisUrl: string;
  logger: Logger;
  processors?: readonly ProcessorDefinition[];
  redisStartupTimeoutMs?: number;
}

export interface WorkerApp {
  queues: Map<string, Queue>;
  workers: Worker[];
  close: () => Promise<void>;
}

/** Khởi động worker: tạo queue, đăng ký scheduler, chạy một BullMQ Worker cho mỗi processor. */
export async function startWorkerApp(options: WorkerAppOptions): Promise<WorkerApp> {
  const {
    redisUrl,
    logger,
    processors = PROCESSORS,
    redisStartupTimeoutMs = REDIS_STARTUP_TIMEOUT_MS,
  } = options;
  // Các Queue dùng chung 1 kết nối; mỗi Worker có kết nối riêng (lệnh chặn).
  const queueConnection = createRedisConnection(redisUrl, { connectionName: 'dezon-worker:queues' });
  const workerConnections: Redis[] = [];
  const queues = new Map<string, Queue>();
  const workers: Worker[] = [];

  const close = async (): Promise<void> => {
    // Đóng Worker trước: chờ job đang chạy xong (có giới hạn thời gian).
    const closingWorkers = Promise.allSettled(workers.map((w) => w.close()));
    const timedOut = await Promise.race([
      closingWorkers.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), SHUTDOWN_TIMEOUT_MS).unref()),
    ]);
    if (timedOut) {
      logger.warn('Hết thời gian chờ job đang chạy, buộc đóng worker');
      await Promise.allSettled(workers.map((w) => w.close(true)));
    }
    await Promise.allSettled([...queues.values()].map((q) => q.close()));
    await Promise.allSettled([queueConnection, ...workerConnections].map(closeRedis));
  };

  try {
    await waitForRedis(queueConnection, redisStartupTimeoutMs);
    for (const def of processors) {
      const queue = createQueue(def.queue, queueConnection);
      queue.on('error', (error) => logger.error({ queue: def.queue, err: error }, 'Lỗi queue'));
      queues.set(def.queue, queue);
      await def.registerSchedulers?.(queue);

      const connection = createRedisConnection(redisUrl, { connectionName: `dezon-worker:${def.queue}` });
      workerConnections.push(connection);
      const worker = new Worker(def.queue, def.createProcessor(logger.child({ queue: def.queue }), queue), {
        connection,
        concurrency: QUEUE_CONCURRENCY[def.queue],
      });
      attachWorkerLogging(worker, logger);
      if (def.onFailed) attachFailedHook(worker, def, logger);
      workers.push(worker);
    }
    await Promise.all(workers.map((w) => w.waitUntilReady()));
  } catch (error) {
    await close();
    throw error;
  }

  logger.info({ queues: [...queues.keys()] }, 'Worker đã sẵn sàng');
  return { queues, workers, close };
}

function attachFailedHook(worker: Worker, def: ProcessorDefinition, logger: Logger): void {
  const log = logger.child({ queue: def.queue });
  worker.on('failed', (job, error) => {
    if (!job || !def.onFailed) return;
    def
      .onFailed(job, error, log)
      .catch((hookError: unknown) => log.error({ jobId: job.id, err: hookError }, 'Lỗi xử lý job thất bại'));
  });
}

function attachWorkerLogging(worker: Worker, logger: Logger): void {
  const log = logger.child({ queue: worker.name });
  // Chỉ log id/tên job, không log payload (có thể chứa nội dung tin nhắn).
  worker.on('completed', (job) => log.debug({ jobId: job.id, job: job.name }, 'Job hoàn thành'));
  worker.on('failed', (job, error) =>
    log.warn({ jobId: job?.id, job: job?.name, attemptsMade: job?.attemptsMade, err: error }, 'Job thất bại'),
  );
  worker.on('error', (error) => log.error({ err: error }, 'Lỗi worker'));
}
