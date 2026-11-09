import { Global, Inject, Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../../config';
import { REDIS } from './redis.constants';

@Injectable()
class RedisLifecycle implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    // Chưa kết nối được thì QUIT sẽ nằm chờ trong offline queue => ngắt luôn.
    if (this.redis.status !== 'ready') {
      this.redis.disconnect();
      return;
    }
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Redis => {
        const logger = new Logger('Redis');
        const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, connectionName: 'dezon-api' });
        // Chỉ ghi message (URL có thể chứa mật khẩu).
        redis.on('error', (err: Error) => logger.warn(`Lỗi kết nối Redis: ${err.message}`));
        return redis;
      },
    },
    RedisLifecycle,
  ],
  exports: [REDIS],
})
export class RedisModule {}
