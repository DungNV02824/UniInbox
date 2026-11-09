// Nhận diện tin echo do chính app của hệ thống gửi (2.2).
// Hợp đồng với connector: mọi echo có direction 'out', senderType 'agent', `raw` là payload gốc
// của nền tảng (Messenger: entry.messaging[i], có `message.app_id`). Pipeline tự so app_id.
import type { NormalizedInboundMessage } from '@dezon/shared';
import { parseMessengerSendMetadata } from '../connectors/messenger/send';
import type { PipelineDeps } from './types';

function rawMessage(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const message = (raw as { message?: unknown }).message;
  return message && typeof message === 'object' ? (message as Record<string, unknown>) : undefined;
}

function rawAppId(raw: unknown): string | undefined {
  const appId = rawMessage(raw)?.app_id;
  if (typeof appId === 'string' && appId !== '') return appId;
  if (typeof appId === 'number' && Number.isFinite(appId)) return String(appId);
  return undefined;
}

/**
 * true nếu là tin echo do hệ thống gửi qua Send API: app_id trùng app của mình (META_APP_ID).
 * Không có app_id thì dựa vào metadata 'dezon-inbox[:<messageId>]' mà connector gắn khi gửi.
 */
export function isOwnEcho(
  message: Pick<NormalizedInboundMessage, 'direction' | 'channelType' | 'raw'>,
  deps: Pick<PipelineDeps, 'ownAppIds'>,
): boolean {
  if (message.direction !== 'out') return false;
  const own = deps.ownAppIds[message.channelType];
  const appId = rawAppId(message.raw);
  if (appId !== undefined) return own !== undefined && appId === String(own);
  return parseMessengerSendMetadata(rawMessage(message.raw)?.metadata).own;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** id message nội bộ gắn trong metadata của echo (chỉ trả khi đúng dạng uuid). */
export function ownEchoMessageId(raw: unknown): string | undefined {
  const { messageId } = parseMessengerSendMetadata(rawMessage(raw)?.metadata);
  return messageId && UUID_RE.test(messageId) ? messageId : undefined;
}
