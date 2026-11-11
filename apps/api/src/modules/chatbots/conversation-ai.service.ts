import {
  ackHandoff,
  buildHandoffActionLarkCard,
  type CredentialsCipher,
  getLarkConfig,
  loadHandoffActionNotice,
  notifyLark,
  AI_KICK_JOB_NAME,
  type AiKickJobData,
  aiKickJobId,
  type HandoffActionMessageDeps,
  type InboxContext,
  listAiRuns,
  needsChatbotKick,
  OUTBOUND_JOB_NAME,
  type OutboundJobData,
  outboundJobId,
  type PipelineLogger,
  resolveHandoff,
  resumeConversationAi,
  sendHandoffActionMessage,
  setConversationChatbot,
  type UpdateConversationResult,
  type Viewer,
} from '@dezon/core';
import type { Db } from '@dezon/db';
import { type AiRunDto, type ConversationSummary, REALTIME_EVENTS } from '@dezon/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { withTimeout } from '../../common/with-timeout';
import { APP_CONFIG, type AppConfig } from '../../config';
import { HTTP_FETCH } from '../../infra/ai/ai.constants';
import { DB } from '../../infra/db/db.constants';
import { CREDENTIALS_CIPHER, INBOX_CONTEXT } from '../../infra/inbox/inbox.constants';
import { AI_REPLY_QUEUE, ENQUEUE_TIMEOUT_MS, OUTBOUND_QUEUE } from '../../infra/queue/queue.constants';
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
    @Inject(OUTBOUND_QUEUE) private readonly outbound: Queue<OutboundJobData>,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CREDENTIALS_CIPHER) private readonly cipher: CredentialsCipher,
    @Inject(HTTP_FETCH) private readonly fetchFn: typeof fetch,
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

  async ackHandoff(viewer: Viewer, id: string): Promise<ConversationSummary> {
    const result = await ackHandoff(this.db, viewer, id, this.ctx);
    const summary = await this.publish(Promise.resolve(result));
    const handoffIds = result.ackedHandoffId ? [result.ackedHandoffId] : [];
    await this.sendHandoffActionMessage(id, 'ack', handoffIds);
    await this.notifyHandoffAction(viewer, id, 'ack', handoffIds);
    return summary;
  }

  async resolveHandoff(viewer: Viewer, id: string): Promise<ConversationSummary> {
    const result = await resolveHandoff(this.db, viewer, id, this.ctx);
    const summary = await this.publish(Promise.resolve(result));
    // Quyết định kick TRƯỚC khi gửi tin của nút: tin bot đó thành tin cuối nên needsChatbotKick tính sau sẽ
    // tưởng khách hết chờ. Thứ tự đẩy job: tin của nút ⇒ kick (khách thấy tin nút trước câu trả lời của bot)
    // ⇒ báo Lark sau cùng (Lark chậm không làm khách chờ lâu hơn).
    const kick = await this.customerWaiting(id);
    await this.sendHandoffActionMessage(id, 'resolve', result.resolvedHandoffIds);
    if (kick) await this.enqueueKick(id);
    await this.notifyHandoffAction(viewer, id, 'resolve', result.resolvedHandoffIds);
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
   * Bot của hội thoại bật "Gửi Lark khi bấm nút" ⇒ gửi thẻ Lark (vd. "✅ Nghiệm thu" / "☑️ Đã chuyển tiền") kèm
   * tóm tắt yêu cầu chuyển người. Chỉ báo khi lần bấm này thật sự đổi trạng thái (bấm lại không gửi trùng).
   * Lỗi Lark chỉ log: thao tác của nhân viên đã lưu. Env LARK_* chỉ dùng khi admin chưa từng lưu cấu hình Lark.
   */
  private async notifyHandoffAction(
    viewer: Viewer,
    conversationId: string,
    action: 'ack' | 'resolve',
    handoffIds: string[],
  ): Promise<void> {
    if (handoffIds.length === 0) return;
    try {
      const card = await loadHandoffActionNotice(this.db, {
        conversationId,
        action,
        handoffIds,
        actorUserId: viewer.id,
        now: this.ctx.now(),
        appUrl: this.config.APP_URL,
      });
      if (!card) return;
      const lark = await getLarkConfig(this.db, this.cipher, {
        webhookUrl: this.config.LARK_WEBHOOK_URL ?? null,
        secret: this.config.LARK_WEBHOOK_SECRET ?? null,
      });
      if (!lark) return;
      await notifyLark(lark, buildHandoffActionLarkCard(card), {
        fetch: this.fetchFn,
        now: this.ctx.now,
        timeoutMs: 5000,
      });
    } catch (error) {
      this.logger.warn({ err: error, conversationId, action }, 'Không gửi được thông báo Lark khi bấm nút');
    }
  }

  /**
   * Bot của hội thoại có đặt tin cho nút vừa bấm (handoff_ack_message / handoff_resolve_message) và lần bấm này
   * thật sự đổi trạng thái ⇒ bot gửi khách tin đó (sender 'bot', qua hàng đợi outbound). Không gửi được (kênh mất
   * kết nối / ngoài cửa sổ) ⇒ core thêm tin system cho nhân viên. Mọi lỗi chỉ log: thao tác của nhân viên đã lưu.
   */
  private async sendHandoffActionMessage(
    conversationId: string,
    action: 'ack' | 'resolve',
    handoffIds: string[],
  ): Promise<void> {
    if (handoffIds.length === 0) return;
    try {
      await sendHandoffActionMessage(this.db, this.messageDeps, { conversationId, action, handoffIds });
    } catch (error) {
      this.logger.warn({ err: error, conversationId, action }, 'Không gửi được tin của nút banner Cần người');
    }
  }

  /** Phụ thuộc của sendHandoffActionMessage: realtime của API, logger Nest, hàng đợi outbound. */
  private get messageDeps(): HandoffActionMessageDeps {
    const log = this.logger;
    const logger: PipelineLogger = {
      info: (obj, msg) => log.log(obj, msg),
      warn: (obj, msg) => log.warn(obj, msg),
      error: (obj, msg) => log.error(obj, msg),
      debug: (obj, msg) => log.debug(obj, msg),
    };
    return {
      ctx: this.ctx,
      publisher: this.realtime,
      logger,
      scheduler: {
        // Cùng jobId cố định như worker (outboundJobId) ⇒ sweeper requeueQueuedBotMessages không gửi trùng.
        enqueueOutbound: async (messageId, delayMs) => {
          await withTimeout(
            this.outbound.add(
              OUTBOUND_JOB_NAME,
              { messageId },
              { jobId: outboundJobId(messageId), delay: Math.max(0, Math.round(delayMs)) },
            ),
            ENQUEUE_TIMEOUT_MS,
            'Đẩy job outbound',
          );
        },
      },
    };
  }

  /** Bot bật và khách đang chờ (needsChatbotKick); lỗi DB ⇒ false (chỉ log). */
  private async customerWaiting(conversationId: string): Promise<boolean> {
    try {
      return await needsChatbotKick(this.db, conversationId, this.ctx.now());
    } catch (error) {
      this.logger.warn({ err: error, conversationId }, 'Không kiểm được khách có đang chờ bot không');
      return false;
    }
  }

  /**
   * Bot vừa được bật lại mà khách đang chờ (tin cuối không tính system là của khách) ⇒ đẩy job "kick" để
   * worker lên lịch trả lời (debounce như tin khách mới). Lỗi Redis chỉ log: thao tác của nhân viên đã lưu,
   * bot vẫn trả lời ở tin khách kế tiếp.
   */
  private async kickIfCustomerWaiting(conversationId: string): Promise<void> {
    if (await this.customerWaiting(conversationId)) await this.enqueueKick(conversationId);
  }

  /** Đẩy job "kick" (jobId cố định theo hội thoại). Lỗi Redis chỉ log. */
  private async enqueueKick(conversationId: string): Promise<void> {
    try {
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
