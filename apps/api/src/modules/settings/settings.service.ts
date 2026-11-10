import {
  buildHandoffLarkCard,
  type CredentialsCipher,
  getAiSettings,
  getBusinessHours,
  getLarkConfig,
  getLarkSettings,
  type LarkConfig,
  notifyLark,
  putAiSettings,
  putBusinessHours,
  putLarkSettings,
} from '@dezon/core';
import type { Db } from '@dezon/db';
import type { AiSettings, BusinessHours, LarkSettingsDto, UpdateLarkSettingsRequest } from '@dezon/shared';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config';
import { HTTP_FETCH } from '../../infra/ai/ai.constants';
import { DB } from '../../infra/db/db.constants';
import { CREDENTIALS_CIPHER } from '../../infra/inbox/inbox.constants';

export const LARK_NOT_CONFIGURED_MESSAGE = 'Chưa cấu hình webhook Lark';

/** Cài đặt chung (app_settings): giờ làm việc, Lark, công tắc AI tổng. */
@Injectable()
export class SettingsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CREDENTIALS_CIPHER) private readonly cipher: CredentialsCipher,
    @Inject(HTTP_FETCH) private readonly fetchFn: typeof fetch,
  ) {}

  getBusinessHours(): Promise<BusinessHours> {
    return getBusinessHours(this.db);
  }

  putBusinessHours(actorUserId: string, input: BusinessHours): Promise<BusinessHours> {
    return putBusinessHours(this.db, actorUserId, input);
  }

  getLark(): Promise<LarkSettingsDto> {
    return getLarkSettings(this.db);
  }

  putLark(actorUserId: string, input: UpdateLarkSettingsRequest): Promise<LarkSettingsDto> {
    return putLarkSettings(this.db, actorUserId, input, this.cipher);
  }

  getAi(): Promise<AiSettings> {
    return getAiSettings(this.db);
  }

  putAi(actorUserId: string, input: AiSettings): Promise<AiSettings> {
    return putAiSettings(this.db, actorUserId, input);
  }

  /** Gửi thẻ thử tới webhook đang lưu (hoặc LARK_WEBHOOK_URL của env nếu chưa từng lưu). Lỗi ⇒ LarkNotifyError (502). */
  async testLark(): Promise<{ ok: true }> {
    const settings = await this.larkConfig();
    if (!settings) throw new BadRequestException(LARK_NOT_CONFIGURED_MESSAGE);
    const card = buildHandoffLarkCard({
      test: true,
      contactName: 'Khách hàng thử',
      channelName: 'Dezon Inbox',
      reasonLabel: 'Thử kết nối Lark',
      summary: 'Đây là thẻ thử. Khi AI chuyển hội thoại cho người thật, thông báo sẽ hiện như thế này.',
      conversationUrl: `${this.config.APP_URL.replace(/\/+$/, '')}/inbox`,
    });
    await notifyLark(settings, card, { fetch: this.fetchFn });
    return { ok: true };
  }

  /**
   * Đúng quy tắc của worker (getLarkConfig của core): env LARK_WEBHOOK_URL/SECRET chỉ dùng khi admin CHƯA
   * TỪNG lưu cấu hình Lark; đã lưu (kể cả xóa webhook) thì DB thắng ⇒ webhook rỗng = Lark đang tắt.
   */
  private larkConfig(): Promise<LarkConfig | null> {
    return getLarkConfig(this.db, this.cipher, {
      webhookUrl: this.config.LARK_WEBHOOK_URL ?? null,
      secret: this.config.LARK_WEBHOOK_SECRET ?? null,
    });
  }
}
