// Tiện ích dùng chung của pipeline inbound/outbound.
import type { Db } from '@dezon/db';
import type { ChannelType } from '@dezon/shared';
import { DrizzleQueryError } from 'drizzle-orm';
import { getConversationSummary, getMessageDto } from '../inbox/queries';
import { roomsForConversation } from '../realtime';
import type { PipelineDeps } from './types';

/** Lỗi vi phạm unique của Postgres (drizzle có thể bọc lỗi gốc trong `cause`). */
export function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    if (typeof e === 'object' && (e as { code?: unknown }).code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const URL_RE = /https?:\/\/[^\s"'<>]+/gi;

/**
 * Thông điệp lỗi an toàn để LOG: DrizzleQueryError mang cả câu SQL + params (attachments có URL CDN kèm token,
 * nội dung tin, tên khách…) ⇒ chỉ lấy mã + thông điệp lỗi gốc của Postgres; mọi URL còn sót bị che.
 */
export function safeErrorMessage(error: unknown): string {
  if (
    error instanceof DrizzleQueryError ||
    (error instanceof Error && 'query' in error && 'params' in error)
  ) {
    const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
    const code = typeof cause?.code === 'string' ? ` [${cause.code}]` : '';
    const detail = typeof cause?.message === 'string' ? `: ${cause.message}` : '';
    return `Lỗi truy vấn DB${code}${detail}`.replace(URL_RE, '<url>');
  }
  return errorMessage(error).replace(URL_RE, '<url>');
}

const CHANNEL_LABELS: Record<ChannelType, string> = {
  messenger: 'Khách Messenger',
  zalo_oa: 'Khách Zalo OA',
  zalo_personal: 'Khách Zalo',
};

/** Tên tạm khi không lấy được tên thật: "Khách Messenger …1234". */
export function fallbackContactName(channelType: ChannelType, externalUserId: string): string {
  return `${CHANNEL_LABELS[channelType]} …${externalUserId.slice(-4)}`;
}

/** Phát message.created kèm summary hội thoại. Lỗi phát realtime chỉ log (tin đã lưu). */
export async function emitMessageCreated(
  db: Db,
  deps: PipelineDeps,
  messageId: string,
  conversation: { id: string; assignedUserId: string | null },
): Promise<void> {
  try {
    const [message, summary] = await Promise.all([
      getMessageDto(db, messageId, deps.ctx),
      getConversationSummary(db, conversation.id, deps.ctx),
    ]);
    deps.publisher.emit(roomsForConversation(conversation), 'message.created', {
      message,
      conversation: summary,
    });
  } catch (error) {
    deps.logger.error({ messageId, err: safeErrorMessage(error) }, 'Không phát được message.created');
  }
}

export async function emitMessageUpdated(
  db: Db,
  deps: Pick<PipelineDeps, 'ctx' | 'publisher' | 'logger'>,
  messageId: string,
  conversation: { assignedUserId: string | null },
): Promise<void> {
  try {
    const message = await getMessageDto(db, messageId, deps.ctx);
    deps.publisher.emit(roomsForConversation(conversation), 'message.updated', { message });
  } catch (error) {
    deps.logger.error({ messageId, err: safeErrorMessage(error) }, 'Không phát được message.updated');
  }
}

/** Phát conversation.updated (ví dụ cửa sổ gửi đổi). Lỗi phát realtime chỉ log. */
export async function emitConversationUpdated(
  db: Db,
  deps: PipelineDeps,
  conversation: { id: string; assignedUserId: string | null },
): Promise<void> {
  try {
    const summary = await getConversationSummary(db, conversation.id, deps.ctx);
    deps.publisher.emit(roomsForConversation(conversation), 'conversation.updated', {
      conversation: summary,
    });
  } catch (error) {
    deps.logger.error(
      { conversationId: conversation.id, err: safeErrorMessage(error) },
      'Không phát được conversation.updated',
    );
  }
}
