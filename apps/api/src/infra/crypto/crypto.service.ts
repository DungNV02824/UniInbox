import {
  type Aad,
  decrypt,
  decryptJson,
  encrypt,
  encryptJson,
  parseEncryptionKey,
} from '@dezon/shared/server';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config';

/**
 * Mã hóa AES-256-GCM bằng ENCRYPTION_KEY — dùng cho channel_accounts.credentials.
 * Khóa chỉ nằm trong bộ nhớ, không bao giờ ghi log.
 */
@Injectable()
export class CryptoService {
  private readonly key: Buffer;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.key = parseEncryptionKey(config.ENCRYPTION_KEY);
  }

  encrypt(plaintext: string, aad?: Aad): string {
    return encrypt(plaintext, this.key, aad);
  }

  decrypt(payload: string, aad?: Aad): string {
    return decrypt(payload, this.key, aad);
  }

  encryptJson<T>(value: T, aad?: Aad): string {
    return encryptJson(value, this.key, aad);
  }

  decryptJson<T>(payload: string, aad?: Aad): T {
    return decryptJson<T>(payload, this.key, aad);
  }
}
