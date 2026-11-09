import { type DynamicModule, Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from './config.constants';
import { loadAppConfig } from './load-config';

@Global()
@Module({})
export class ConfigModule {
  /** Gọi một lần lúc khởi động; truyền `config` sẵn có để không validate lại. */
  static forRoot(config: AppConfig = loadAppConfig()): DynamicModule {
    return {
      module: ConfigModule,
      global: true,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
