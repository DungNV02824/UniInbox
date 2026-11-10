import {
  createChatbot,
  deleteChatbot,
  getChatbot,
  getConversationSummary,
  type InboxContext,
  listChatbots,
  updateChatbot,
  type Viewer,
} from '@dezon/core';
import type { Db } from '@dezon/db';
import {
  type ChatbotDto,
  type ChatbotSummary,
  type CreateChatbotRequest,
  REALTIME_EVENTS,
  type UpdateChatbotRequest,
} from '@dezon/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DB } from '../../infra/db/db.constants';
import { INBOX_CONTEXT } from '../../infra/inbox/inbox.constants';
import { RealtimeService } from '../realtime/realtime.service';
import { roomsOfSummary } from '../realtime/rooms';

/** Số hội thoại tối đa được phát conversation.updated khi xóa bot. */
export const DELETE_EMIT_LIMIT = 200;
/** Số truy vấn summary chạy song song khi phát. */
export const DELETE_EMIT_CONCURRENCY = 10;

export interface DeleteChatbotResponse {
  /** Số hội thoại bị gỡ bot (chuyển ai_mode 'off'). */
  detachedConversations: number;
}

/** CRUD chatbot: gọi lõi @dezon/core, phát realtime cho hội thoại bị gỡ bot khi xóa. */
@Injectable()
export class ChatbotsService {
  private readonly logger = new Logger(ChatbotsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(INBOX_CONTEXT) private readonly ctx: InboxContext,
    private readonly realtime: RealtimeService,
  ) {}

  list(viewer: Viewer): Promise<ChatbotSummary[]> {
    return listChatbots(this.db, viewer);
  }

  get(id: string): Promise<ChatbotDto> {
    return getChatbot(this.db, id);
  }

  create(actorUserId: string, input: CreateChatbotRequest): Promise<ChatbotDto> {
    return createChatbot(this.db, actorUserId, input);
  }

  update(actorUserId: string, id: string, input: UpdateChatbotRequest): Promise<ChatbotDto> {
    return updateChatbot(this.db, actorUserId, id, input);
  }

  async remove(actorUserId: string, id: string): Promise<DeleteChatbotResponse> {
    const { detachedConversationIds } = await deleteChatbot(this.db, actorUserId, id);
    await this.emitUpdated(detachedConversationIds);
    return { detachedConversations: detachedConversationIds.length };
  }

  /**
   * Phát conversation.updated cho tối đa DELETE_EMIT_LIMIT hội thoại mới nhất (core trả theo last_message_at
   * giảm dần), chạy song song tối đa DELETE_EMIT_CONCURRENCY. Phần còn lại: client thấy khi tải lại danh sách
   * (không bắn hàng nghìn sự kiện/truy vấn một lúc). Lỗi đọc một hội thoại không làm hỏng request.
   */
  private async emitUpdated(conversationIds: string[]): Promise<void> {
    const ids = conversationIds.slice(0, DELETE_EMIT_LIMIT);
    let failed = 0;
    let next = 0;
    const workers = Array.from({ length: Math.min(DELETE_EMIT_CONCURRENCY, ids.length) }, async () => {
      while (next < ids.length) {
        const conversationId = ids[next++]!;
        try {
          const conversation = await getConversationSummary(this.db, conversationId, this.ctx);
          this.realtime.emit(roomsOfSummary(conversation), REALTIME_EVENTS.conversationUpdated, {
            conversation,
          });
        } catch {
          failed++;
        }
      }
    });
    await Promise.all(workers);
    if (failed > 0) this.logger.warn({ failed }, 'Không phát được conversation.updated sau khi xóa chatbot');
    const skipped = conversationIds.length - ids.length;
    if (skipped > 0) {
      this.logger.log({ skipped }, 'Xóa chatbot: bỏ qua realtime cho hội thoại cũ (client tự tải lại)');
    }
  }
}
