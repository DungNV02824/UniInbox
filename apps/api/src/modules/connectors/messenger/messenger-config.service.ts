import {
  createMessengerGraphApi,
  createMessengerLoginApi,
  type MessengerConfig,
  type MessengerGraphApi,
  type MessengerLoginApi,
} from '@dezon/core';
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { META_NOT_CONFIGURED_MESSAGE } from './messenger.constants';

/** Đọc cấu hình META_*; thiếu biến cần cho thao tác nào thì thao tác đó trả 503. */
@Injectable()
export class MessengerConfigService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  verifyToken(): string {
    return this.require(this.config.META_VERIFY_TOKEN, 'META_VERIFY_TOKEN');
  }

  appSecret(): string {
    return this.require(this.config.META_APP_SECRET, 'META_APP_SECRET');
  }

  graphConfig(): MessengerConfig {
    return {
      appId: this.require(this.config.META_APP_ID, 'META_APP_ID'),
      appSecret: this.appSecret(),
      graphBaseUrl: this.config.META_GRAPH_BASE_URL,
      graphVersion: this.require(this.config.META_GRAPH_VERSION, 'META_GRAPH_VERSION'),
      loginDialogBaseUrl: this.config.META_LOGIN_DIALOG_BASE_URL,
    };
  }

  /** Facebook Login for Business (tùy chọn). */
  loginConfigId(): string | undefined {
    return this.config.META_LOGIN_CONFIG_ID;
  }

  private require(value: string | undefined, name: string): string {
    if (!value) throw new ServiceUnavailableException(`${META_NOT_CONFIGURED_MESSAGE} (thiếu ${name})`);
    return value;
  }
}

/** Graph API tạo lần đầu dùng tới, để app vẫn khởi động khi chưa cấu hình Meta. */
export function createLazyGraphApi(config: MessengerConfigService): MessengerGraphApi {
  let graph: MessengerGraphApi | undefined;
  const get = () => (graph ??= createMessengerGraphApi(config.graphConfig()));
  return {
    getPage: (token) => get().getPage(token),
    subscribeApp: (pageId, token) => get().subscribeApp(pageId, token),
    unsubscribeApp: (pageId, token) => get().unsubscribeApp(pageId, token),
  };
}

/** Facebook Login API tạo lần đầu dùng tới (thiếu cấu hình => 503 khi gọi). */
export function createLazyLoginApi(config: MessengerConfigService): MessengerLoginApi {
  let api: MessengerLoginApi | undefined;
  const get = () => (api ??= createMessengerLoginApi(config.graphConfig()));
  return {
    buildLoginUrl: (input) => get().buildLoginUrl(input),
    exchangeCode: (code, redirectUri) => get().exchangeCode(code, redirectUri),
    exchangeLongLivedUserToken: (token) => get().exchangeLongLivedUserToken(token),
    getMe: (token) => get().getMe(token),
    listPages: (token) => get().listPages(token),
  };
}
