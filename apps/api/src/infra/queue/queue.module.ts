import { QUEUE_NAMES } from '@dezon/shared';
import { Global, Inject, Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { type DefaultJobOptions, Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../../config';
import { CHANNEL_SYNC_QUEUE, INBOUND_QUEUE, OUTBOUND_QUEUE, QUEUE_CONNECTION } from './queue.constants';

/** Mặc định cho job do API đẩy (giống worker). */
const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { count: 1_000, age: 24 * 3600 },
  removeOnFail: { count: 5_000, age: 7 * 24 * 3600 },
};

const SHUTDOWN_READY_WAIT_MS = 1_000;

function createQueue(name: string, connection: Redis): Queue {
  const queue = new Queue(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
  const logger = new Logger(`Queue:${name}`);
  queue.on('error', (err: Error) => logger.warn(`Lỗi queue: ${err.message}`));
  return queue;
}

@Injectable()
class QueueLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(INBOUND_QUEUE) private readonly inbound: Queue,
    @Inject(OUTBOUND_QUEUE) private readonly outbound: Queue,
    @Inject(CHANNEL_SYNC_QUEUE) private readonly channelSync: Queue,
    @Inject(QUEUE_CONNECTION) private readonly connection: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    // BullMQ còn đang khởi tạo (đọc version Redis) mà đóng kết nối ngay thì sinh lỗi không ai bắt:
    // chờ khởi tạo xong, tối đa SHUTDOWN_READY_WAIT_MS (Redis chết thì không chờ mãi).
    const queues = [this.inbound, this.outbound, this.channelSync];
    const ready = Promise.allSettled(queues.map((q) => q.waitUntilReady()));
    await Promise.race([ready, new Promise((r) => setTimeout(r, SHUTDOWN_READY_WAIT_MS).unref())]);
    await Promise.allSettled(queues.map((q) => q.close()));
    if (this.connection.status !== 'ready') {
      this.connection.disconnect();
      return;
    }
    try {
      await this.connection.quit();
    } catch {
      this.connection.disconnect();
    }
  }
}

@Global()
@Module({
  providers: [
    {
      provide: QUEUE_CONNECTION,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Redis => {
        const logger = new Logger('Redis:queues');
        const redis = new Redis(config.REDIS_URL, {
          maxRetriesPerRequest: null,
          // Redis mất kết nối => lệnh lỗi ngay thay vì nằm chờ (webhook trả 500 để Meta gửi lại).
          enableOfflineQueue: false,
          connectionName: 'dezon-api:queues',
        });
        redis.on('error', (err: Error) => logger.warn(`Lỗi kết nối Redis: ${err.message}`));
        return redis;
      },
    },
    {
      provide: INBOUND_QUEUE,
      inject: [QUEUE_CONNECTION],
      useFactory: (connection: Redis) => createQueue(QUEUE_NAMES.inbound, connection),
    },
    {
      provide: OUTBOUND_QUEUE,
      inject: [QUEUE_CONNECTION],
      useFactory: (connection: Redis) => createQueue(QUEUE_NAMES.outbound, connection),
    },
    {
      provide: CHANNEL_SYNC_QUEUE,
      inject: [QUEUE_CONNECTION],
      useFactory: (connection: Redis) => createQueue(QUEUE_NAMES.channelSync, connection),
    },
    QueueLifecycle,
  ],
  exports: [INBOUND_QUEUE, OUTBOUND_QUEUE, CHANNEL_SYNC_QUEUE],
})
export class QueueModule {}
