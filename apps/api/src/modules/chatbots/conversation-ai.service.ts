import {
  ackHandoff,
  AI_KICK_JOB_NAME,
  type AiKickJobData,
  aiKickJobId,
  type InboxContext,
  listAiRuns,
  needsChatbotKick,
  resolveHandoff,
  resumeConversationAi,
  setConversationChatbot,
  type UpdateConversationResult,
  type Viewer,
} from '@dezon/core';
import type { Db } from '@dezon/db';
import { type AiRunDto, type ConversationSummary, REALTIME_EVENTS } from '@dezon/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { withTimeout } from '../../common/with-timeout';
import { DB } from '../../infra/db/db.constants';
import { INBOX_CONTEXT } from '../../infra/inbox/inbox.constants';
import { AI_REPLY_QUEUE, ENQUEUE_TIMEOUT_MS } from '../../infra/queue/queue.constants';
import { RealtimeService } from '../realtime/realtime.service';
import { roomsOfSummary } from '../realtime/rooms';

/** Chatbot / tạm dừng AI / chuyển người thật trên một hội thoại; phát conversation.updated sau mỗi thao tác. */
@Injectable()
export class ConversationAiService {
  private readonly logger = new Logger(ConversationAiService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(INBOX_CONTEXT) private readonly ctx: InboxContext,
    private readonly realtime: RealtimeService,
    @Inject(AI_REPLY_QUEUE) private readonly aiReply: Queue<AiKickJobData>,
  ) {}

  async setChatbot(viewer: Viewer, id: string, chatbotId: string | null): Promise<ConversationSummary> {
    const summary = await this.publish(setConversationChatbot(this.db, viewer, id, chatbotId, this.ctx));
    if (chatbotId) await this.kickIfCustomerWaiting(id);
    return summary;
  }

  async resumeAi(viewer: Viewer, id: string): Promise<ConversationSummary> {
    const summary = await this.publish(resumeConversationAi(this.db, viewer, id, this.ctx));
    await this.kickIfCustomerWaiting(id);
    return summary;
  }

  ackHandoff(viewer: Viewer, id: string): Promise<ConversationSummary> {
    return this.publish(ackHandoff(this.db, viewer, id, this.ctx));
  }

  async resolveHandoff(viewer: Viewer, id: string): Promise<ConversationSummary> {
    const summary = await this.publish(resolveHandoff(this.db, viewer, id, this.ctx));
    await this.kickIfCustomerWaiting(id);
    return summary;
  }

  aiRuns(id: string): Promise<AiRunDto[]> {
    return listAiRuns(this.db, id);
  }

  private async publish(pending: Promise<UpdateConversationResult>): Promise<ConversationSummary> {
    const { conversation, previousAssigneeId } = await pending;
    this.realtime.emit(
      roomsOfSummary(conversation, previousAssigneeId),
      REALTIME_EVENTS.conversationUpdated,
      {
        conversation,
      },
    );
    return conversation;
  }

  /**
   * Bot vừa được bật lại mà khách đang chờ (tin cuối không tính system là của khách) ⇒ đẩy job "kick" để
   * worker lên lịch trả lời (debounce như tin khách mới). Lỗi Redis chỉ log: thao tác của nhân viên đã lưu,
   * bot vẫn trả lời ở tin khách kế tiếp.
   */
  private async kickIfCustomerWaiting(conversationId: string): Promise<void> {
    try {
      if (!(await needsChatbotKick(this.db, conversationId, this.ctx.now()))) return;
      await withTimeout(
        this.aiReply.add(
          AI_KICK_JOB_NAME,
          { conversationId },
          { jobId: aiKickJobId(conversationId), removeOnComplete: true, removeOnFail: true },
        ),
        ENQUEUE_TIMEOUT_MS,
        'Đẩy job đánh thức chatbot',
      );
    } catch (error) {
      this.logger.warn({ err: error, conversationId }, 'Không đẩy được job đánh thức chatbot');
    }
  }
}
