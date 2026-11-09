import { createS3Storage, type MediaStorage } from '@dezon/core';
import { type DynamicModule, Global, Logger, Module, type Provider } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config';
import { MEDIA_STORAGE } from './storage.constants';

/** Tạo MediaStorage từ env S3_*; thiếu bucket/khóa thì trả null (ghi cảnh báo). */
export function createStorageFromConfig(config: AppConfig): MediaStorage | null {
  const { S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY } = config;
  if (!S3_BUCKET || !S3_ACCESS_KEY || !S3_SECRET_KEY) {
    new Logger('Storage').warn('Thiếu S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY: tắt lưu trữ tệp');
    return null;
  }
  return createS3Storage({
    endpoint: config.S3_ENDPOINT,
    publicEndpoint: config.S3_PUBLIC_ENDPOINT,
    bucket: S3_BUCKET,
    accessKeyId: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_KEY,
    region: config.S3_REGION,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    signedUrlTtlSec: config.MEDIA_SIGNED_URL_TTL_SEC,
  });
}

@Global()
@Module({})
export class StorageModule {
  /** `override` (test): dùng storage này thay cho S3 từ env; null = coi như chưa cấu hình. */
  static forRoot(override?: MediaStorage | null): DynamicModule {
    const provider: Provider =
      override !== undefined
        ? { provide: MEDIA_STORAGE, useValue: override }
        : { provide: MEDIA_STORAGE, inject: [APP_CONFIG], useFactory: createStorageFromConfig };
    return { module: StorageModule, global: true, providers: [provider], exports: [MEDIA_STORAGE] };
  }
}
