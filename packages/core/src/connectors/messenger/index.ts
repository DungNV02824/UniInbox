// Connector Messenger (Fanpage). Nguồn sự thật: docs/research/messenger-platform.md.
import type { ChannelConnector } from '../types';
import { createConversationsReader, type MessengerConversationsReader } from './conversations';
import type { MessengerConfig, MessengerGraphApi } from './config';
import { createGraphApi } from './graph-api';
import { createLoginApi, type MessengerLoginApi } from './oauth';
import { parseMessengerWebhook } from './parse';
import { fetchMessengerProfile } from './profile';
import { sendMessengerSenderAction } from './sender-action';
import { sendMessengerPart } from './send';
import { headerValue, verifyMessengerSignature } from './signature';

export type { MessengerConfig, MessengerCredentials, MessengerGraphApi } from './config';
export { verifyMessengerChallenge, verifyMessengerSignature } from './signature';
export { PAGE_INBOX_APP_IDS, messengerEchoSource, type MessengerEchoSource } from './echo';
export { MESSENGER_SUBSCRIBED_FIELDS } from './graph-api';
export * from './conversations';
export * from './thread-message';
export { mapReadError, MSG_READ_FORBIDDEN, MSG_TOKEN_INVALID } from './errors';
export {
  FACEBOOK_DIALOG_BASE_URL,
  FACEBOOK_LOGIN_SCOPES,
  FacebookLoginError,
  appSecretProof,
  pageMessagingAccess,
  type FacebookLoginUrlInput,
  type FacebookManagedPage,
  type FacebookUserToken,
  type MessengerLoginApi,
} from './oauth';
export {
  MESSENGER_SEND_METADATA,
  MESSENGER_TEXT_MAX,
  MESSENGER_ATTACHMENT_MAX_BYTES,
  messengerSendMetadata,
  parseMessengerSendMetadata,
} from './send';
export { SENDER_ACTION_TIMEOUT_MS } from './sender-action';

/** Connector Messenger kèm bộ đọc hội thoại (dùng cho đồng bộ; không thuộc interface chung ChannelConnector). */
export interface MessengerConnector extends ChannelConnector {
  readonly type: 'messenger';
  readonly conversations: MessengerConversationsReader;
}

/** Lấy bộ đọc hội thoại nếu connector là connector Messenger thật (connector giả trong test có thể không có). */
export function messengerConversationsOf(
  connector: ChannelConnector | undefined,
): MessengerConversationsReader | undefined {
  const reader = (connector as Partial<MessengerConnector> | undefined)?.conversations;
  return reader && typeof reader.listConversations === 'function' ? reader : undefined;
}

export function createMessengerConnector(config: MessengerConfig): MessengerConnector {
  return {
    type: 'messenger',
    conversations: createConversationsReader(config),
    verifyWebhook(req) {
      return verifyMessengerSignature(
        req.rawBody,
        headerValue(req.headers, 'x-hub-signature-256'),
        config.appSecret,
      );
    },
    parseWebhook(body, resolveAccount) {
      return parseMessengerWebhook(body, resolveAccount);
    },
    send(account, to, part, options) {
      return sendMessengerPart(config, account, to, part, options);
    },
    sendSenderAction(account, to, action) {
      return sendMessengerSenderAction(config, account, to, action);
    },
    fetchProfile(account, externalUserId) {
      return fetchMessengerProfile(config, account, externalUserId);
    },
  };
}

export function createMessengerGraphApi(config: MessengerConfig): MessengerGraphApi {
  return createGraphApi(config);
}

/** Facebook Login (chọn Fanpage bằng đăng nhập) — tách khỏi MessengerGraphApi để không phá các bản giả hiện có. */
export function createMessengerLoginApi(config: MessengerConfig): MessengerLoginApi {
  return createLoginApi(config);
}
