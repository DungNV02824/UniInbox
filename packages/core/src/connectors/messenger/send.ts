// Send API (docs/research/messenger-platform.md §5): text dạng JSON, tệp dạng multipart `filedata`.
import {
  PermanentSendError,
  type ChannelRecipient,
  type OutboundPart,
  type ResolvedChannelAccount,
} from '../types';
import type { SendOptions, SendResult } from '../types';
import type { MessengerConfig } from './config';
import { MSG_TOKEN_INVALID, mapSendError, networkSendError } from './errors';
import { GraphNetworkError, graphRequest, type GraphResponse } from './graph';

/** Tài liệu: "less than 2000 characters". API/worker đã tách tin trước khi gọi connector. */
export const MESSENGER_TEXT_MAX = 1999;
/** "Maximum file size is 25MB" (upload trực tiếp; giới hạn 8MB ảnh chỉ áp dụng khi gửi bằng URL). */
export const MESSENGER_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
/** Đánh dấu tin do hệ thống gửi; quay lại trong echo (message.metadata). */
export const MESSENGER_SEND_METADATA = 'dezon-inbox';

/** metadata gửi kèm: 'dezon-inbox:<messageId>' để echo khớp được message (giới hạn < 1000 ký tự). */
export function messengerSendMetadata(messageId?: string): string {
  return messageId ? `${MESSENGER_SEND_METADATA}:${messageId}` : MESSENGER_SEND_METADATA;
}

/** Đọc metadata của echo: own = do hệ thống gửi; messageId nếu có gắn. */
export function parseMessengerSendMetadata(metadata: unknown): { own: boolean; messageId?: string } {
  if (typeof metadata !== 'string') return { own: false };
  if (metadata === MESSENGER_SEND_METADATA) return { own: true };
  const prefix = `${MESSENGER_SEND_METADATA}:`;
  if (!metadata.startsWith(prefix)) return { own: false };
  const messageId = metadata.slice(prefix.length);
  return messageId ? { own: true, messageId } : { own: true };
}

/** Lấy Page Access Token từ credentials đã giải mã; thiếu => lỗi credentials. */
export function pageTokenOf(account: ResolvedChannelAccount): string {
  const token = account.credentials.pageAccessToken;
  if (typeof token !== 'string' || token.trim() === '') {
    throw new PermanentSendError(MSG_TOKEN_INVALID, true, 'missing_token');
  }
  return token;
}

function messagingParams(options?: SendOptions): Record<string, string> {
  return options?.tag ? { messaging_type: 'MESSAGE_TAG', tag: options.tag } : { messaging_type: 'RESPONSE' };
}

function buildRequestBody(
  to: ChannelRecipient,
  part: OutboundPart,
  options?: SendOptions,
): Record<string, unknown> | FormData {
  const recipient = { id: to.externalUserId };
  if (part.kind === 'text') {
    if (part.text.trim() === '') throw new PermanentSendError('Tin nhắn rỗng', false, 'empty_text');
    if (part.text.length > MESSENGER_TEXT_MAX) {
      throw new PermanentSendError(`Tin nhắn dài quá ${MESSENGER_TEXT_MAX} ký tự`, false, 'text_too_long');
    }
    return {
      recipient,
      ...messagingParams(options),
      message: { text: part.text, metadata: messengerSendMetadata(options?.messageId) },
    };
  }

  if (part.data.length > MESSENGER_ATTACHMENT_MAX_BYTES) {
    throw new PermanentSendError('Tệp vượt quá 25MB — Messenger không nhận', false, 'file_too_large');
  }
  const form = new FormData();
  form.append('recipient', JSON.stringify(recipient));
  for (const [key, value] of Object.entries(messagingParams(options))) form.append(key, value);
  form.append(
    'message',
    JSON.stringify({
      // Upload và gửi trong một bước: KHÔNG đặt is_reusable=true (tài liệu Saving assets).
      attachment: { type: part.type, payload: { is_reusable: false } },
      metadata: messengerSendMetadata(options?.messageId),
    }),
  );
  form.append('filedata', new Blob([new Uint8Array(part.data)], { type: part.mime }), part.filename);
  return form;
}

export async function sendMessengerPart(
  config: MessengerConfig,
  account: ResolvedChannelAccount,
  to: ChannelRecipient,
  part: OutboundPart,
  options?: SendOptions,
): Promise<SendResult> {
  const token = pageTokenOf(account);
  const body = buildRequestBody(to, part, options);

  let res: GraphResponse;
  try {
    res = await graphRequest(config, { method: 'POST', path: `${account.externalId}/messages`, token, body });
  } catch (err) {
    if (err instanceof GraphNetworkError) throw networkSendError(err.timeout);
    throw err;
  }
  if (!res.ok) throw mapSendError(res.status, res.error);

  const messageId = res.data.message_id;
  if (typeof messageId !== 'string' || messageId === '') {
    // Hiếm (tài liệu mơ hồ về dạng phản hồi): không thử lại để tránh gửi trùng.
    throw new PermanentSendError(
      'Facebook không trả về mã tin nhắn — kiểm tra lại trên Messenger',
      false,
      'no_mid',
    );
  }
  return { externalMessageId: messageId };
}
