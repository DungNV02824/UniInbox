// Hai nút trên banner "Cần người": thông báo Lark (bot bật handoff_action_lark) và tin bot gửi khách
// (chatbots.handoff_ack_message / handoff_resolve_message). Nút thứ ba "Không đạt" (AI soạn tin) ở handoff-reject.ts —
// thẻ Lark của nút đó cũng dựng ở đây (loadHandoffActionNotice action 'reject').
import {
  channelAccounts,
  chatbots,
  contacts,
  conversations,
  handoffs,
  messages,
  users,
  type Db,
} from '@dezon/db';
import {
  DEFAULT_HANDOFF_ACK_LABEL,
  DEFAULT_HANDOFF_RESOLVE_LABEL,
  HANDOFF_MESSAGE_CONTACT_PLACEHOLDER,
  HANDOFF_REJECT_LABEL,
} from '@dezon/shared';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { InboxContext } from '../inbox/types';
import type { PipelineLogger } from '../pipeline/types';
import type { RealtimePublisher } from '../realtime';
import { botCanSend, bubbleDelays, emitMessagesCreated, errorText, insertBotMessages } from './delivery';
import type { HandoffActionCardInput } from './lark';

const VN_TIME = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh',
  hour: '2-digit',
  minute: '2-digit',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour12: false,
});

/** "14:36 10/11/2026" (giờ Việt Nam). */
export function formatVnDateTime(d: Date): string {
  const parts = Object.fromEntries(VN_TIME.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.hour}:${parts.minute} ${parts.day}/${parts.month}/${parts.year}`;
}

export interface HandoffActionNoticeInput {
  conversationId: string;
  /** 'reject' = nút "Không đạt" (HANDOFF_REJECT_LABEL — handoff-reject.ts). */
  action: 'ack' | 'resolve' | 'reject';
  /** Handoff vừa ack / vừa đóng / vừa đánh dấu Không đạt ở lần bấm này; rỗng ⇒ không báo (bấm lại). */
  handoffIds: readonly string[];
  actorUserId: string;
  now: Date;
  /** `${APP_URL}` — nút "Mở hội thoại". */
  appUrl: string;
  /** Nút "Không đạt": lý do nhân viên gõ (thẻ Lark có dòng "Lý do không đạt"). */
  rejectReason?: string;
}

/**
 * Dữ liệu thẻ Lark cho lần bấm nút; null khi không cần báo: không có handoff mới, hội thoại không gắn bot,
 * hoặc bot không bật handoff_action_lark.
 */
export async function loadHandoffActionNotice(
  db: Db,
  input: HandoffActionNoticeInput,
): Promise<HandoffActionCardInput | null> {
  if (input.handoffIds.length === 0) return null;
  const [row] = await db
    .select({
      contactName: contacts.displayName,
      channelName: channelAccounts.displayName,
      chatbotName: chatbots.name,
      notify: chatbots.handoffActionLark,
      ackLabel: chatbots.handoffAckLabel,
      resolveLabel: chatbots.handoffResolveLabel,
    })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .innerJoin(channelAccounts, eq(channelAccounts.id, conversations.channelAccountId))
    .innerJoin(chatbots, eq(chatbots.id, conversations.chatbotId))
    .where(eq(conversations.id, input.conversationId));
  if (!row?.notify) return null;

  const [items, [actor]] = await Promise.all([
    db
      .select({ summary: handoffs.summary })
      .from(handoffs)
      .where(inArray(handoffs.id, [...input.handoffIds]))
      .orderBy(asc(handoffs.createdAt)),
    db.select({ name: users.name }).from(users).where(eq(users.id, input.actorUserId)),
  ]);

  const buttonLabel =
    input.action === 'reject'
      ? HANDOFF_REJECT_LABEL
      : input.action === 'ack'
        ? (row.ackLabel ?? DEFAULT_HANDOFF_ACK_LABEL)
        : (row.resolveLabel ?? DEFAULT_HANDOFF_RESOLVE_LABEL);
  return {
    action: input.action,
    buttonLabel,
    ...(input.action === 'reject' && input.rejectReason !== undefined
      ? { rejectReason: input.rejectReason }
      : {}),
    contactName: row.contactName ?? 'Khách',
    channelName: row.channelName,
    chatbotName: row.chatbotName,
    actorName: actor?.name ?? 'Nhân viên',
    at: formatVnDateTime(input.now),
    summaries: items.map((i) => i.summary).filter((s) => s.trim() !== ''),
    conversationUrl: `${input.appUrl.replace(/\/+$/, '')}/inbox/${input.conversationId}`,
  };
}

// ---------- Tin bot gửi khách khi bấm nút ----------

/** Tên khách thay cho HANDOFF_MESSAGE_CONTACT_PLACEHOLDER khi khách chưa có tên. */
export const HANDOFF_MESSAGE_CONTACT_FALLBACK = 'anh/chị';

/** Thay mọi `{ten_khach}` trong mẫu tin bằng tên khách (rỗng/thiếu ⇒ "anh/chị"). */
export function fillHandoffActionMessage(template: string, contactName: string | null | undefined): string {
  const name = contactName?.trim() || HANDOFF_MESSAGE_CONTACT_FALLBACK;
  return template.split(HANDOFF_MESSAGE_CONTACT_PLACEHOLDER).join(name);
}

/** Tin system (chỉ nhân viên thấy) khi bot không gửi được tin của nút cho khách. */
export function handoffActionBlockedText(buttonLabel: string, reason: string): string {
  return `Không gửi được tin «${buttonLabel}» cho khách: ${reason}`;
}

export interface HandoffActionMessageDeps {
  ctx: InboxContext;
  publisher: RealtimePublisher;
  logger: PipelineLogger;
  /** Xếp hàng gửi (outbound) — cùng hợp đồng AiJobScheduler.enqueueOutbound. */
  scheduler: { enqueueOutbound(messageId: string, delayMs: number): Promise<void> };
  /** Giãn cách bong bóng (test). */
  random?: () => number;
}

export interface HandoffActionMessageInput {
  conversationId: string;
  action: 'ack' | 'resolve';
  /** Handoff vừa ack / vừa đóng ở lần bấm này; rỗng ⇒ không gửi (bấm lại). */
  handoffIds: readonly string[];
}

export type HandoffActionMessageResult =
  /** Không gửi gì: bấm lại, hội thoại không gắn bot, hoặc bot không đặt tin cho nút này. */
  | { status: 'skipped' }
  /** Đã tạo tin bot (status 'queued'); `queued` = số tin đã đẩy vào hàng đợi (lỗi Redis ⇒ sweeper gửi lại). */
  | { status: 'sent'; messageIds: string[]; queued: number }
  /** botCanSend chặn (kênh mất kết nối / ngoài cửa sổ) ⇒ chỉ tạo tin system cho nhân viên. */
  | { status: 'blocked'; reason: string; systemMessageId: string };

/**
 * Nhân viên bấm nút "nhận" (handoffAckLabel) / "xong" (handoffResolveLabel) và lần bấm THẬT SỰ đổi trạng thái
 * (`handoffIds` không rỗng) ⇒ gửi khách tin handoff_ack_message / handoff_resolve_message của bot đang gắn
 * (`{ten_khach}` = tên khách). Tin đi như tin bot khác: sender 'bot' (ai_run_id null), tách bong bóng ≤ 1999 ký
 * tự, status 'queued' ⇒ enqueueOutbound (giãn bong bóng) ⇒ message.created. Đây là tin bot, không phải tin nhân
 * viên: không kích hoạt tạm dừng bot "khi nhân viên vào nhắn".
 * botCanSend chặn ⇒ không gửi, chỉ thêm tin system handoffActionBlockedText(...) để nhân viên biết.
 * Lỗi DB ném ra (API bắt và log — thao tác của nhân viên đã lưu); lỗi xếp hàng chỉ log.
 *
 * Thứ tự ở nút "xong": tin bot vừa tạo là tin cuối (không còn là của khách) ⇒ needsChatbotKick phải được tính
 * TRƯỚC khi gọi hàm này, và job kick đẩy SAU (tin của nút tới khách trước câu trả lời của bot).
 */
export async function sendHandoffActionMessage(
  db: Db,
  deps: HandoffActionMessageDeps,
  input: HandoffActionMessageInput,
): Promise<HandoffActionMessageResult> {
  if (input.handoffIds.length === 0) return { status: 'skipped' };
  const [conv] = await db
    .select({
      id: conversations.id,
      channelAccountId: conversations.channelAccountId,
      lastCustomerMessageAt: conversations.lastCustomerMessageAt,
      windowSource: conversations.windowSource,
      channelType: channelAccounts.type,
      channelStatus: channelAccounts.status,
      contactName: contacts.displayName,
      ackLabel: chatbots.handoffAckLabel,
      resolveLabel: chatbots.handoffResolveLabel,
      ackMessage: chatbots.handoffAckMessage,
      resolveMessage: chatbots.handoffResolveMessage,
    })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .innerJoin(channelAccounts, eq(channelAccounts.id, conversations.channelAccountId))
    .innerJoin(chatbots, eq(chatbots.id, conversations.chatbotId))
    .where(eq(conversations.id, input.conversationId));
  if (!conv) return { status: 'skipped' };
  const template = (input.action === 'ack' ? conv.ackMessage : conv.resolveMessage)?.trim();
  if (!template) return { status: 'skipped' };
  const text = fillHandoffActionMessage(template, conv.contactName);
  const label =
    input.action === 'ack'
      ? (conv.ackLabel ?? DEFAULT_HANDOFF_ACK_LABEL)
      : (conv.resolveLabel ?? DEFAULT_HANDOFF_RESOLVE_LABEL);

  const now = deps.ctx.now();
  const check = await botCanSend(db, conv, deps.ctx);
  if (!check.allowed) {
    const reason = check.reason ?? 'Không được phép gửi lúc này';
    const systemMessageId = await db.transaction(async (tx) => {
      const [system] = await tx
        .insert(messages)
        .values({
          conversationId: conv.id,
          channelAccountId: conv.channelAccountId,
          senderType: 'system',
          text: handoffActionBlockedText(label, reason),
          attachments: [],
          status: 'sent',
          sentAt: now,
        })
        .returning({ id: messages.id });
      await tx
        .update(conversations)
        .set({
          lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${now.toISOString()}::timestamptz)`,
        })
        .where(eq(conversations.id, conv.id));
      return system!.id;
    });
    deps.logger.info(
      { conversationId: conv.id, action: input.action, reason },
      'Bot không gửi được tin của nút banner Cần người',
    );
    await emitMessagesCreated(db, deps, [systemMessageId], conv.id);
    return { status: 'blocked', reason, systemMessageId };
  }

  const messageIds = await db.transaction((tx) => insertBotMessages(tx, conv, [text], null, now));
  // Xếp hàng lỗi không làm hỏng thao tác: tin còn 'queued' được requeueQueuedBotMessages gửi lại sau.
  const delays = bubbleDelays(messageIds.length, deps.random);
  let queued = 0;
  try {
    for (const [i, id] of messageIds.entries()) {
      await deps.scheduler.enqueueOutbound(id, delays[i] ?? 0);
      queued++;
    }
  } catch (error) {
    deps.logger.warn(
      { conversationId: conv.id, action: input.action, err: errorText(error) },
      'Không xếp hàng được tin của nút banner Cần người',
    );
  }
  await emitMessagesCreated(db, deps, messageIds, conv.id);
  return { status: 'sent', messageIds, queued };
}
