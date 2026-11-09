import { createDb, type DbHandle } from '@dezon/db';
import { Global, Inject, Injectable, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config';
import { DB, DB_HANDLE } from './db.constants';

@Injectable()
class DbLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  async onApplicationShutdown(): Promise<void> {
    await this.handle.close();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DB_HANDLE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): DbHandle => {
        const logger = new Logger('Postgres');
        // Lỗi của kết nối rảnh trong pool: ghi log thay vì làm sập process.
        return createDb(config.DATABASE_URL, {
          onError: (err) => logger.error({ err }, 'Lỗi kết nối Postgres'),
        });
      },
    },
    { provide: DB, inject: [DB_HANDLE], useFactory: (handle: DbHandle) => handle.db },
    DbLifecycle,
  ],
  exports: [DB],
})
export class DbModule {}
