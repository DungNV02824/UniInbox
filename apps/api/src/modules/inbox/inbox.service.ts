import {
  getConversationDetail,
  type InboxContext,
  listConversations,
  listMessages,
  markConversationRead,
  OUTBOUND_JOB_NAME,
  type OutboundJobData,
  outboundJobId,
  sendAgentMessage,
  updateContact,
  updateConversation,
  type Viewer,
} from '@dezon/core';
import type { Db } from '@dezon/db';
import {
  type ContactDetail,
  type ConversationDetail,
  type ConversationSummary,
  type ListConversationsQuery,
  type ListMessagesQuery,
  type MessageDto,
  type Page,
  REALTIME_EVENTS,
  type SendMessageRequest,
  type UpdateContactRequest,
  type UpdateConversationRequest,
} from '@dezon/shared';
import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { withTimeout } from '../../common/with-timeout';
import { DB } from '../../infra/db/db.constants';
import { INBOX_CONTEXT } from '../../infra/inbox/inbox.constants';
import { ENQUEUE_TIMEOUT_MS, OUTBOUND_QUEUE } from '../../infra/queue/queue.constants';
import { ContactConversationsBroadcaster } from '../realtime/contact-conversations-broadcaster';
import { RealtimeService } from '../realtime/realtime.service';
import { roomsOfSummary as roomsOf } from '../realtime/rooms';

/** Gọi lõi nghiệp vụ hộp thư rồi làm phần việc của API: đẩy job gửi tin, phát realtime. */
@Injectable()
export class InboxService {
  private readonly logger = new Logger(InboxService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(INBOX_CONTEXT) private readonly ctx: InboxContext,
    @Inject(OUTBOUND_QUEUE) private readonly outbound: Queue<OutboundJobData>,
    private readonly realtime: RealtimeService,
    private readonly contactConversations: ContactConversationsBroadcaster,
  ) {}

  list(viewer: Viewer, query: ListConversationsQuery): Promise<Page<ConversationSummary>> {
    return listConversations(this.db, viewer, query, this.ctx);
  }

  detail(viewer: Viewer, id: string): Promise<ConversationDetail> {
    return getConversationDetail(this.db, viewer, id, this.ctx);
  }

  messages(viewer: Viewer, id: string, query: ListMessagesQuery): Promise<Page<MessageDto>> {
    return listMessages(this.db, viewer, id, query, this.ctx);
  }

  async send(viewer: Viewer, id: string, input: SendMessageRequest): Promise<{ messages: MessageDto[] }> {
    const { messages, conversation, duplicate } = await sendAgentMessage(
      this.db,
      viewer,
      id,
      input,
      this.ctx,
    );
    if (duplicate) {
      // Gửi lại cùng clientId (lần trước mất phản hồi / đẩy job lỗi): không tạo tin mới, chỉ đẩy lại job
      // cho tin còn queued — jobId cố định nên BullMQ bỏ qua job đã có.
      await this.enqueueOutbound(messages.filter((m) => m.status === 'queued'));
      return { messages };
    }
    // Phát trước khi đẩy job để message.created tới client trước message.updated của worker.
    const rooms = roomsOf(conversation);
    for (const message of messages) {
      this.realtime.emit(rooms, REALTIME_EVENTS.messageCreated, { message, conversation });
    }
    this.realtime.emit(rooms, REALTIME_EVENTS.conversationUpdated, { conversation });
    await this.enqueueOutbound(messages);
    return { messages };
  }

  async markRead(viewer: Viewer, id: string): Promise<ConversationSummary> {
    const conversation = await markConversationRead(this.db, viewer, id, this.ctx);
    this.realtime.emit(roomsOf(conversation), REALTIME_EVENTS.conversationUpdated, { conversation });
    return conversation;
  }

  async update(viewer: Viewer, id: string, input: UpdateConversationRequest): Promise<ConversationSummary> {
    const { conversation, previousAssigneeId } = await updateConversation(
      this.db,
      viewer,
      id,
      input,
      this.ctx,
    );
    this.realtime.emit(roomsOf(conversation, previousAssigneeId), REALTIME_EVENTS.conversationUpdated, {
      conversation,
    });
    return conversation;
  }

  /**
   * Sửa khách; đổi tên hoặc tag ⇒ phát conversation.updated (summary có contact.displayName/tags mới) cho các
   * hội thoại của khách để danh sách đang mở cập nhật ngay.
   */
  async updateContact(viewer: Viewer, id: string, input: UpdateContactRequest): Promise<ContactDetail> {
    const detail = await updateContact(this.db, viewer, id, input, this.ctx);
    if (input.tags !== undefined || input.displayName !== undefined) {
      await this.contactConversations.emitForContacts([detail.id]);
    }
    return detail;
  }

  /** Mỗi message một job; jobId cố định để không gửi trùng. */
  private async enqueueOutbound(messages: MessageDto[]): Promise<void> {
    if (messages.length === 0) return;
    try {
      await withTimeout(
        this.outbound.addBulk(
          messages.map((m) => ({
            name: OUTBOUND_JOB_NAME,
            data: { messageId: m.id },
            opts: { jobId: outboundJobId(m.id), attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
          })),
        ),
        ENQUEUE_TIMEOUT_MS,
        'Đẩy job outbound',
      );
    } catch (error) {
      // Tin đã lưu (status queued) nhưng chưa vào hàng đợi: báo lỗi để nhân viên biết.
      this.logger.error({ err: error, messageIds: messages.map((m) => m.id) }, 'Không đẩy được job gửi tin');
      throw new ServiceUnavailableException(
        'Tin đã lưu nhưng chưa đưa được vào hàng đợi gửi, vui lòng thử lại',
      );
    }
  }
}
