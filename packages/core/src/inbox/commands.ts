// Phần ghi của hộp thư. Hàm KHÔNG tự đẩy job hay phát realtime: trả dữ liệu để API làm việc đó.
import { randomUUID } from 'node:crypto';
import {
  auditLogs,
  channelAccounts,
  contacts,
  conversations,
  handoffs,
  messages,
  users,
  type Db,
  type NewMessage,
} from '@dezon/db';
import type {
  ContactDetail,
  ConversationSummary,
  MessageAttachment,
  MessageDto,
  OutboundAttachmentInput,
  SendMessageRequest,
  UpdateContactRequest,
  UpdateConversationRequest,
} from '@dezon/shared';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DEFAULT_AI_PAUSE_AFTER_AGENT_MIN, pauseAiAfterAgentMessage } from '../ai/agent-pause';
import { normalizeContactTags } from '../contact-tags/service';
import { firstCustomerMessageAt } from '../pipeline/window-anchor';
import { canSend } from '../policy';
import {
  canViewConversation,
  CONVERSATION_NOT_FOUND,
  visibleConversationsWhere,
  assertCanView,
} from './access';
import { InboxForbiddenError, InboxNotFoundError, InboxValidationError, SendNotAllowedError } from './errors';
import { loadContactDetail, loadSummary, selectMessageRows, toMessageDto, type DbLike } from './read-model';
import { splitOutboundText } from './split-text';
import type { InboxContext, Viewer } from './types';

export interface SendAgentMessageResult {
  /** Các message vừa tạo (status = queued), theo thứ tự gửi: text tách ≤ OUTBOUND_TEXT_MAX_CHARS ký tự, mỗi tệp một tin. */
  messages: MessageDto[];
  conversation: ConversationSummary;
  /**
   * true khi (conversationId, clientId) đã được gửi trước đó: `messages` là các tin CŨ (trạng thái hiện
   * tại), không tạo tin mới. Caller không phát message.created lại; chỉ cần đẩy lại job cho tin còn
   * queued (jobId cố định nên không gửi trùng).
   */
  duplicate: boolean;
}

/**
 * Dữ liệu cho worker gửi tin, lưu ở messages.raw khi nhân viên gửi qua hệ thống.
 * `tag` = 'HUMAN_AGENT' khi gửi ngoài cửa sổ 24h của Messenger.
 * `batchId`: chung cho các phần của một lần gửi — phần trước lỗi hẳn thì worker hủy các phần sau.
 */
export interface OutboundRawMeta {
  outbound: { tag?: 'HUMAN_AGENT'; batchId?: string };
}

async function summaryOrThrow(db: DbLike, id: string, ctx: InboxContext): Promise<ConversationSummary> {
  const summary = await loadSummary(db, id, ctx);
  if (!summary) throw new InboxNotFoundError(CONVERSATION_NOT_FOUND);
  return summary;
}

function toStoredAttachment(a: OutboundAttachmentInput): MessageAttachment {
  return {
    type: a.type,
    storage_key: a.storageKey,
    mime: a.mime,
    ...(a.width !== undefined ? { width: a.width } : {}),
    ...(a.height !== undefined ? { height: a.height } : {}),
    ...(a.name !== undefined ? { name: a.name } : {}),
  };
}

/**
 * Nhân viên gửi tin: kiểm quyền xem, kiểm kênh còn 'connected', kiểm cửa sổ gửi (ChannelPolicy,
 * by = 'agent'; ném SendNotAllowedError kèm lý do), tạo message queued (sender_type = agent,
 * sender_user_id = viewer), cập nhật last_message_at. Caller đẩy job outbound cho từng message.
 * Idempotent theo `clientId`: gửi lại cùng clientId trả các tin đã tạo (duplicate = true). An toàn khi
 * hai request chạy đồng thời vì kiểm tra nằm sau khóa FOR UPDATE của dòng hội thoại.
 * Hội thoại có chatbot ⇒ theo agent_reply_mode của bot: 'pause' ⇒ ai_paused_until = now + agent_pause_minutes
 * (null ⇒ ctx.aiPauseAfterAgentMin, mặc định 30) phút; 'stop' ⇒ dừng hẳn; 'continue' ⇒ không tạm dừng.
 */
export async function sendAgentMessage(
  db: Db,
  viewer: Viewer,
  conversationId: string,
  input: SendMessageRequest,
  ctx: InboxContext,
): Promise<SendAgentMessageResult> {
  const now = ctx.now();
  const { ids, duplicate } = await db.transaction(async (tx) => {
    const [conv] = await tx
      .select({
        id: conversations.id,
        assignedUserId: conversations.assignedUserId,
        channelAccountId: conversations.channelAccountId,
        lastCustomerMessageAt: conversations.lastCustomerMessageAt,
        windowSource: conversations.windowSource,
        channelType: channelAccounts.type,
        channelStatus: channelAccounts.status,
        channelName: channelAccounts.displayName,
      })
      .from(conversations)
      .innerJoin(channelAccounts, eq(channelAccounts.id, conversations.channelAccountId))
      .where(eq(conversations.id, conversationId))
      .for('update', { of: conversations });
    if (!conv) throw new InboxNotFoundError(CONVERSATION_NOT_FOUND);
    if (!canViewConversation(viewer, conv)) {
      throw new InboxForbiddenError('Bạn không có quyền gửi tin trong hội thoại này');
    }
    if (input.clientId) {
      const existing = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.conversationId, conv.id), eq(messages.clientId, input.clientId)));
      if (existing.length > 0) return { ids: existing.map((r) => r.id), duplicate: true };
    }
    if (conv.channelStatus !== 'connected') {
      throw new SendNotAllowedError(
        `Kênh "${conv.channelName}" đang mất kết nối. Hãy kết nối lại kênh trước khi gửi tin.`,
      );
    }

    const decision = canSend(
      {
        channelType: conv.channelType,
        lastCustomerMessageAt: conv.lastCustomerMessageAt,
        windowSource: conv.windowSource,
        firstCustomerMessageAt:
          conv.windowSource === 'ads' ? await firstCustomerMessageAt(tx, conv.id) : null,
      },
      'agent',
      now,
      ctx.policy,
    );
    if (!decision.allowed) throw new SendNotAllowedError(decision.reason ?? 'Không thể gửi tin lúc này.');

    const parts: Pick<NewMessage, 'text' | 'attachments'>[] = [
      ...splitOutboundText(input.text ?? '').map((text) => ({ text, attachments: [] })),
      ...(input.attachments ?? []).map((a) => ({ text: null, attachments: [toStoredAttachment(a)] })),
    ];
    if (parts.length === 0) throw new InboxValidationError('Tin nhắn phải có nội dung hoặc tệp đính kèm');

    const raw: OutboundRawMeta = {
      outbound: { ...(decision.tag ? { tag: decision.tag } : {}), batchId: randomUUID() },
    };
    // sent_at tăng 1ms mỗi phần để giữ đúng thứ tự hiển thị (sắp theo sent_at, id).
    const rows: NewMessage[] = parts.map((p, i) => ({
      ...p,
      conversationId: conv.id,
      channelAccountId: conv.channelAccountId,
      senderType: 'agent',
      senderUserId: viewer.id,
      status: 'queued',
      raw,
      clientId: input.clientId ?? null,
      sentAt: new Date(now.getTime() + i),
    }));
    const inserted = await tx.insert(messages).values(rows).returning({ id: messages.id });
    const lastSentAt = new Date(now.getTime() + rows.length - 1).toISOString();
    await tx
      .update(conversations)
      .set({
        lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${lastSentAt}::timestamptz)`,
        updatedAt: now,
      })
      .where(eq(conversations.id, conv.id));
    // Nhân viên vừa nhắn ⇒ áp "Khi nhân viên vào nhắn tin" của chatbot đang gắn (nếu có): tiếp tục / tạm nghỉ /
    // dừng hẳn.
    await pauseAiAfterAgentMessage(
      tx,
      conv.id,
      now,
      ctx.aiPauseAfterAgentMin ?? DEFAULT_AI_PAUSE_AFTER_AGENT_MIN,
    );
    return { ids: inserted.map((r) => r.id), duplicate: false };
  });

  const rows = await selectMessageRows(db, inArray(messages.id, ids), [
    asc(messages.sentAt),
    asc(messages.id),
  ]);
  const dtos = await Promise.all(rows.map((r) => toMessageDto(r, ctx)));
  return {
    messages: input.clientId ? dtos.map((m) => ({ ...m, clientId: input.clientId })) : dtos,
    conversation: await summaryOrThrow(db, conversationId, ctx),
    duplicate,
  };
}

/** Đặt unread_count = 0. */
export async function markConversationRead(
  db: Db,
  viewer: Viewer,
  conversationId: string,
  ctx: InboxContext,
): Promise<ConversationSummary> {
  await assertCanView(db, viewer, conversationId);
  await db
    .update(conversations)
    .set({ unreadCount: 0, updatedAt: ctx.now() })
    .where(and(eq(conversations.id, conversationId), sql`${conversations.unreadCount} <> 0`));
  return summaryOrThrow(db, conversationId, ctx);
}

export interface UpdateConversationResult {
  conversation: ConversationSummary;
  /** Người phụ trách trước khi đổi (để báo realtime cho người cũ). */
  previousAssigneeId: string | null;
}

/** Kiểm quyền phân công; trả lỗi tiếng Việt nếu không hợp lệ. */
async function assertCanAssign(
  db: DbLike,
  viewer: Viewer,
  current: string | null,
  next: string | null,
): Promise<void> {
  if (viewer.role !== 'admin') {
    const claimSelf = next === viewer.id;
    const releaseOwn = next === null && current === viewer.id;
    if (!claimSelf && !releaseOwn) {
      throw new InboxForbiddenError('Bạn chỉ có thể nhận hội thoại về mình hoặc bỏ nhận hội thoại của mình');
    }
    return;
  }
  if (next === null) return;
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, next), eq(users.isActive, true)));
  if (!user) throw new InboxValidationError('Nhân viên được phân công không tồn tại hoặc đã bị khóa');
}

/**
 * Đóng mọi handoff đang mở của hội thoại (resolved_at = now; chưa ai nhận thì coi `userId` là người nhận).
 * Trả id các handoff vừa đóng. Gọi trong transaction đã khóa dòng hội thoại.
 */
export async function resolveOpenHandoffs(
  tx: Pick<Db, 'update'>,
  conversationId: string,
  userId: string,
  now: Date,
): Promise<string[]> {
  const rows = await tx
    .update(handoffs)
    .set({
      resolvedAt: now,
      acknowledgedBy: sql`coalesce(${handoffs.acknowledgedBy}, ${userId}::uuid)`,
      acknowledgedAt: sql`coalesce(${handoffs.acknowledgedAt}, ${now.toISOString()}::timestamptz)`,
      updatedAt: now,
    })
    .where(and(eq(handoffs.conversationId, conversationId), isNull(handoffs.resolvedAt)))
    .returning({ id: handoffs.id });
  return rows.map((r) => r.id);
}

/**
 * Đổi trạng thái open/resolved và/hoặc phân công. Đổi trạng thái ⇒ đóng handoff đang mở
 * (resolveOpenHandoffs) và xóa handoff_reason/handoff_at; ai_mode giữ nguyên. Agent chỉ được nhận về mình hoặc bỏ nhận
 * hội thoại của mình; admin phân công cho bất kỳ nhân viên đang hoạt động. Ghi audit_logs.
 */
export async function updateConversation(
  db: Db,
  viewer: Viewer,
  conversationId: string,
  input: UpdateConversationRequest,
  ctx: InboxContext,
): Promise<UpdateConversationResult> {
  const now = ctx.now();
  const previousAssigneeId = await db.transaction(async (tx) => {
    const [conv] = await tx
      .select({
        id: conversations.id,
        assignedUserId: conversations.assignedUserId,
        status: conversations.status,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .for('update');
    if (!conv) throw new InboxNotFoundError(CONVERSATION_NOT_FOUND);
    if (!canViewConversation(viewer, conv)) {
      throw new InboxForbiddenError('Bạn không có quyền sửa hội thoại này');
    }

    const set: Partial<typeof conversations.$inferInsert> = {};
    const audits: (typeof auditLogs.$inferInsert)[] = [];
    const audit = (action: string, data: Record<string, unknown>) =>
      audits.push({ userId: viewer.id, action, entity: 'conversation', entityId: conv.id, data });

    if (input.assignedUserId !== undefined && input.assignedUserId !== conv.assignedUserId) {
      await assertCanAssign(tx, viewer, conv.assignedUserId, input.assignedUserId);
      set.assignedUserId = input.assignedUserId;
      audit('conversation.assign', { from: conv.assignedUserId, to: input.assignedUserId });
    }
    if (input.status !== undefined && input.status !== conv.status) {
      set.status = input.status;
      // Rời pending_human (hoặc đổi trạng thái khi còn handoff mở sót lại) ⇒ đóng handoff để lần chuyển
      // người sau không bị coi là trùng và banner "Cần người" không treo. ai_mode GIỮ NGUYÊN (thường là
      // 'off' sau escalate): bot chỉ chạy lại khi nhân viên chủ động bật (ô Chatbot hiện "Bật lại").
      const resolvedHandoffIds = await resolveOpenHandoffs(tx, conv.id, viewer.id, now);
      if (conv.status === 'pending_human' || resolvedHandoffIds.length > 0) {
        set.handoffReason = null;
        set.handoffAt = null;
      }
      audit('conversation.status', {
        from: conv.status,
        to: input.status,
        ...(resolvedHandoffIds.length > 0 ? { resolvedHandoffIds } : {}),
      });
    }
    if (audits.length > 0) {
      await tx
        .update(conversations)
        .set({ ...set, updatedAt: now })
        .where(eq(conversations.id, conv.id));
      await tx.insert(auditLogs).values(audits);
    }
    return conv.assignedUserId;
  });
  return { conversation: await summaryOrThrow(db, conversationId, ctx), previousAssigneeId };
}

/** Sửa tên/ghi chú/tag khách. Viewer phải xem được ít nhất một hội thoại của khách (admin luôn được). */
export async function updateContact(
  db: Db,
  viewer: Viewer,
  contactId: string,
  input: UpdateContactRequest,
  ctx: InboxContext,
): Promise<ContactDetail> {
  const [contact] = await db
    .select({ id: contacts.id, tags: contacts.tags })
    .from(contacts)
    .where(eq(contacts.id, contactId));
  if (!contact) throw new InboxNotFoundError('Không tìm thấy khách hàng');
  if (viewer.role !== 'admin') {
    const [visible] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.contactId, contactId), visibleConversationsWhere(viewer)))
      .limit(1);
    if (!visible) throw new InboxForbiddenError('Bạn không có quyền sửa thông tin khách hàng này');
  }

  const set: Partial<typeof contacts.$inferInsert> = {};
  if (input.displayName !== undefined) set.displayName = input.displayName;
  if (input.notes !== undefined) set.notes = input.notes;
  // Nhãn mới phải có trong danh sách nhãn (đổi về cách viết của danh sách); nhãn cũ ngoài danh sách được giữ.
  if (input.tags !== undefined) set.tags = await normalizeContactTags(db, contact.tags, input.tags);
  const fields = Object.keys(set);
  if (fields.length > 0) {
    await db.transaction(async (tx) => {
      await tx
        .update(contacts)
        .set({ ...set, updatedAt: ctx.now() })
        .where(eq(contacts.id, contactId));
      // Không ghi nội dung (thông tin cá nhân) vào audit, chỉ ghi tên trường đã sửa.
      await tx.insert(auditLogs).values({
        userId: viewer.id,
        action: 'contact.update',
        entity: 'contact',
        entityId: contactId,
        data: { fields },
      });
    });
  }

  const detail = await loadContactDetail(db, contactId, ctx);
  if (!detail) throw new InboxNotFoundError('Không tìm thấy khách hàng');
  return detail;
}
