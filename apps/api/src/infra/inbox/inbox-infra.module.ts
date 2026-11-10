import type { CredentialsCipher, InboxContext, MediaStorage } from '@dezon/core';
import { Global, Module, ServiceUnavailableException } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config';
import { CryptoService } from '../crypto/crypto.service';
import { MEDIA_STORAGE, STORAGE_NOT_CONFIGURED_MESSAGE } from '../storage/storage.constants';
import { CREDENTIALS_CIPHER, INBOX_CONTEXT } from './inbox.constants';

export function createInboxContext(config: AppConfig, storage: MediaStorage | null): InboxContext {
  return {
    signUrl: (key) =>
      storage
        ? storage.signedUrl(key)
        : Promise.reject(new ServiceUnavailableException(STORAGE_NOT_CONFIGURED_MESSAGE)),
    now: () => new Date(),
    policy: {
      metaHumanAgentEnabled: config.META_HUMAN_AGENT_ENABLED,
      zaloOaAllowPaidBot: config.ZALO_OA_ALLOW_PAID_BOT,
    },
    aiPauseAfterAgentMin: config.AI_PAUSE_AFTER_AGENT_MIN,
  };
}

/** Phụ thuộc dùng chung khi gọi lõi nghiệp vụ @dezon/core. */
@Global()
@Module({
  providers: [
    { provide: INBOX_CONTEXT, inject: [APP_CONFIG, MEDIA_STORAGE], useFactory: createInboxContext },
    {
      provide: CREDENTIALS_CIPHER,
      inject: [CryptoService],
      useFactory: (crypto: CryptoService): CredentialsCipher => ({
        encryptJson: (value) => crypto.encryptJson(value),
        decryptJson: (payload) => crypto.decryptJson(payload),
      }),
    },
  ],
  exports: [INBOX_CONTEXT, CREDENTIALS_CIPHER],
})
export class InboxInfraModule {}
