import type { LlmClient, MediaStorage, MessengerGraphApi, MessengerLoginApi } from '@dezon/core';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { buildLoggerParams } from './common/logger';
import { type AppConfig, ConfigModule } from './config';
import { AiInfraModule } from './infra/ai/ai-infra.module';
import type { GeminiModelLister } from './infra/ai/ai.constants';
import { CryptoModule } from './infra/crypto/crypto.module';
import { DbModule } from './infra/db/db.module';
import { InboxInfraModule } from './infra/inbox/inbox-infra.module';
import { QueueModule } from './infra/queue/queue.module';
import { RedisModule } from './infra/redis/redis.module';
import { StorageModule } from './infra/storage/storage.module';
import { AuthModule } from './modules/auth/auth.module';
import { ChannelsModule } from './modules/channels/channels.module';
import { ChatbotsModule } from './modules/chatbots/chatbots.module';
import { ContactTagsModule } from './modules/contact-tags/contact-tags.module';
import { MessengerModule } from './modules/connectors/messenger/messenger.module';
import { HealthModule } from './modules/health/health.module';
import { InboxModule } from './modules/inbox/inbox.module';
import { MediaModule } from './modules/media/media.module';
import { PublicConfigModule } from './modules/public-config/public-config.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { SettingsModule } from './modules/settings/settings.module';
import { UsersModule } from './modules/users/users.module';

/** Thay phụ thuộc bên ngoài (chỉ dùng trong test). */
export interface AppOverrides {
  /** Thay MediaStorage S3 (null = coi như chưa cấu hình S3). */
  mediaStorage?: MediaStorage | null;
  /** Thay Graph API của Messenger. */
  messengerGraph?: MessengerGraphApi;
  /** Thay Facebook Login (chọn Fanpage). */
  messengerLogin?: MessengerLoginApi;
  /** Thay client Gemini (null = coi như chưa có GEMINI_API_KEY). */
  llm?: LlmClient | null;
  /** Thay hàm liệt kê model Gemini (null = chưa có key). */
  geminiModels?: GeminiModelLister | null;
  /** Thay `fetch` khi gọi webhook Lark. */
  fetch?: typeof fetch;
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig, overrides: AppOverrides = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggerModule.forRoot(buildLoggerParams(config)),
        DbModule,
        RedisModule,
        CryptoModule,
        QueueModule,
        StorageModule.forRoot(overrides.mediaStorage),
        InboxInfraModule,
        AiInfraModule.forRoot({
          llm: overrides.llm,
          geminiModels: overrides.geminiModels,
          fetch: overrides.fetch,
        }),
        AuthModule,
        RealtimeModule,
        UsersModule,
        HealthModule,
        PublicConfigModule,
        MessengerModule.forRoot(overrides.messengerGraph, overrides.messengerLogin),
        ChannelsModule,
        InboxModule,
        MediaModule,
        ChatbotsModule,
        ContactTagsModule,
        SettingsModule,
      ],
      providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
    };
  }
}
