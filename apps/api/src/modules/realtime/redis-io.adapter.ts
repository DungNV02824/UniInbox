import type { INestApplicationContext } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { SOCKET_PATH } from '@dezon/shared';
import { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';
import type { AppConfig } from '../../config';

async function closeRedis(redis: Redis): Promise<void> {
  if (redis.status !== 'ready') {
    redis.disconnect();
    return;
  }
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}

type PromiseCommand = 'publish' | 'subscribe' | 'psubscribe' | 'unsubscribe' | 'punsubscribe';

/**
 * @socket.io/redis-adapter gọi publish/subscribe mà không bắt lỗi: khi Redis mất kết nối, promise
 * bị từ chối không ai xử lý sẽ làm sập process. Bọc các lệnh đó để chỉ ghi cảnh báo.
 */
function catchCommandRejections(redis: Redis, commands: PromiseCommand[], logger: Logger): void {
  const target = redis as unknown as Record<PromiseCommand, (...args: unknown[]) => Promise<unknown>>;
  for (const command of commands) {
    const original = target[command].bind(redis);
    target[command] = (...args: unknown[]) => {
      const result = original(...args);
      result.catch((err: unknown) =>
        logger.warn(`Redis ${command} lỗi: ${err instanceof Error ? err.message : String(err)}`),
      );
      return result;
    };
  }
}

/**
 * Socket.IO dùng Redis adapter (2 kết nối pub/sub) để sự kiện phát từ worker
 * (@socket.io/redis-emitter) hoặc API khác tới được mọi client. Path và CORS lấy từ config.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly pub: Redis;
  private readonly sub: Redis;

  constructor(
    app: INestApplicationContext,
    private readonly config: AppConfig,
  ) {
    super(app);
    const logger = new Logger('Redis:socket.io');
    const onError = (err: Error) => logger.warn(`Lỗi kết nối Redis: ${err.message}`);
    this.pub = new Redis(config.REDIS_URL, { connectionName: 'dezon-api:io-pub' });
    // Không ready check (INFO) cho kết nối sub: INFO chen giữa lúc đã vào chế độ subscribe sẽ bị Redis từ chối.
    this.sub = new Redis(config.REDIS_URL, {
      connectionName: 'dezon-api:io-sub',
      enableReadyCheck: false,
    });
    this.pub.on('error', onError);
    this.sub.on('error', onError);
    catchCommandRejections(this.pub, ['publish'], logger);
    catchCommandRejections(this.sub, ['subscribe', 'psubscribe', 'unsubscribe', 'punsubscribe'], logger);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, {
      ...options,
      path: SOCKET_PATH,
      serveClient: false,
      cors: { origin: new URL(this.config.APP_URL).origin, credentials: true },
    }) as Server;
    server.adapter(createAdapter(this.pub, this.sub));
    return server;
  }

  override async dispose(): Promise<void> {
    await Promise.allSettled([closeRedis(this.pub), closeRedis(this.sub)]);
  }
}
