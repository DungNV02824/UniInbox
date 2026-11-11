// Chuyển người thật (escalate) + nhắc lại khi chưa ai "Nhận xử lý".
import { channelAccounts, chatbots, contacts, conversations, handoffs, messages, type Db } from '@dezon/db';
import { HANDOFF_REASON_LABELS, type HandoffReasonCode } from '@dezon/shared';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { CONVERSATION_NOT_FOUND } from '../inbox/access';
import { InboxNotFoundError } from '../inbox/errors';
import type { HandoffReminderJobData } from '../jobs';
import { roomsForConversation } from '../realtime';
import {
  botCanSend,
  bubbleDelays,
  emitConversationUpdated,
  emitMessagesCreated,
  errorText,
  insertBotMessages,
} from './delivery';
import { buildHandoffLarkCard, notifyLark } from './lark';
import type { AiRuntimeDeps } from './runtime';
import { getLarkConfig } from './settings';

export interface EscalateInput {
  reasonCode: HandoffReasonCode;
  summary: string;
  createdBy: 'ai' | 'user';
  /** Bắt buộc khi createdBy 'user'. */
  createdByUserId?: string | null;
  /** Gửi bot.handoffMessage (nếu có và canSend by 'bot') trước khi chuyển. Mặc định true khi createdBy 'ai'. */
  sendHandoffMessage?: boolean;
  /**
   * Tin bot gửi người nhắn lúc chuyển (`messages_to_customer` của tool escalate — vd. báo thù lao dự kiến — hoặc
   * bong bóng reply tự nói "đã chuyển"). Có ít nhất một tin không rỗng ⇒ gửi các tin này THAY cho bot.handoffMessage
   * (cùng đường gửi với reply: bong bóng giãn cách, sender 'bot', ai_run_id). Cùng điều kiện botCanSend; không gửi
   * được thì bỏ, vẫn chuyển người.
   */
  messages?: readonly string[];
  /** Lần chạy AI dẫn tới escalate (gắn vào tin giữ chỗ để hiện tên bot). */
  aiRunId?: string | null;
}

export interface EscalateResult {
  handoffId: string;
  /** Số tin bot đã xếp hàng gửi (messages hoặc handoffMessage); 0 khi không gửi gì hoặc created false. */
  botMessagesQueued: number;
  /**
   * false nếu hội thoại đã pending_human với handoff mở (không tạo trùng). Handoff mở sót lại khi hội thoại
   * KHÔNG ở pending_human bị đóng rồi tạo handoff mới (tối đa một handoff mở / hội thoại).
   */
  created: boolean;
}

/** Tiền tố tin system khi AI chuyển hội thoại. */
export const HANDOFF_SYSTEM_PREFIX = 'AI đã chuyển cho người thật: ';

async function loadConversationInfo(db: Db, conversationId: string) {
  const [row] = await db
    .select({
      id: conversations.id,
      channelAccountId: conversations.channelAccountId,
      lastCustomerMessageAt: conversations.lastCustomerMessageAt,
      windowSource: conversations.windowSource,
      channelType: channelAccounts.type,
      channelStatus: channelAccounts.status,
      channelName: channelAccounts.displayName,
      contactName: contacts.displayName,
      handoffMessage: chatbots.handoffMessage,
      /** null khi hội thoại không gắn bot (leftJoin). */
      botId: chatbots.id,
      botReminderMin: chatbots.handoffReminderMin,
    })
    .from(conversations)
    .innerJoin(channelAccounts, eq(channelAccounts.id, conversations.channelAccountId))
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .leftJoin(chatbots, eq(chatbots.id, conversations.chatbotId))
    .where(eq(conversations.id, conversationId));
  return row;
}

const conversationUrl = (appUrl: string, conversationId: string) =>
  `${appUrl.replace(/\/+$/, '')}/inbox/${conversationId}`;

/**
 * Số phút nhắc lại "chưa ai nhận hội thoại": hội thoại có bot ⇒ chatbots.handoff_reminder_min của bot đó
 * (0 = tắt, mặc định); không có bot (đã gỡ, chuyển tay) ⇒ HANDOFF_ESCALATE_AFTER_MIN (env, 0 = tắt).
 */
export function handoffReminderMinutes(
  bot: { id: string | null; handoffReminderMin: number | null } | null,
  envMinutes: number,
): number {
  if (bot?.id) return Math.max(0, bot.handoffReminderMin ?? 0);
  return Math.max(0, envMinutes);
}

/** Gửi thẻ Lark nếu đã cấu hình webhook. Lỗi (kể cả đọc cấu hình) chỉ log warn — không làm hỏng escalate. */
export async function notifyLarkSafe(
  db: Db,
  deps: AiRuntimeDeps,
  input: {
    conversationId: string;
    contactName: string;
    channelName: string;
    reasonCode: HandoffReasonCode;
    summary: string;
    reminder?: boolean;
    /** Thẻ "chỉ báo nhân viên — bot vẫn trả lời" (notifyKeywords). */
    botContinues?: boolean;
  },
): Promise<void> {
  try {
    const config = await getLarkConfig(db, deps.cipher, deps.larkFallback ?? undefined);
    if (!config) return;
    const card = buildHandoffLarkCard({
      contactName: input.contactName,
      channelName: input.channelName,
      reasonLabel: HANDOFF_REASON_LABELS[input.reasonCode],
      summary: input.summary,
      conversationUrl: conversationUrl(deps.config.appUrl, input.conversationId),
      ...(input.reminder ? { reminder: true } : {}),
      ...(input.botContinues ? { botContinues: true } : {}),
    });
    await notifyLark(config, card, { ...(deps.fetch ? { fetch: deps.fetch } : {}), now: deps.ctx.now });
  } catch (error) {
    deps.logger.warn(
      { conversationId: input.conversationId, err: errorText(error) },
      'Không gửi được thông báo Lark',
    );
  }
}

/**
 * Chuyển người thật (mục 7 của brief): [gửi `messages` (nếu có) HOẶC handoff_message] ⇒ transaction: status 'pending_human',
 * ai_mode 'off' (GIỮ chatbot_id), handoff_reason, handoff_at = now; insert handoffs; insert message
 * sender 'system' text "AI đã chuyển cho người thật: <HANDOFF_REASON_LABELS[code]>" (status 'sent').
 * Sau commit: phát message.created (tin system) + conversation.updated + handoff.created
 * { conversationId, reasonCode, summary, contactName, channelName } tới roomsForConversation;
 * Lark (getLarkConfig có webhookUrl) ⇒ notifyLark(buildHandoffLarkCard(...)) — lỗi Lark chỉ log warn;
 * scheduler.scheduleHandoffReminder({ conversationId, handoffId }, N phút) với N = handoffReminderMinutes: bot của
 * hội thoại (chatbots.handoff_reminder_min) hoặc env khi không có bot; N = 0 ⇒ không lên lịch nhắc.
 */
export async function escalateConversation(
  db: Db,
  deps: AiRuntimeDeps,
  conversationId: string,
  input: EscalateInput,
): Promise<EscalateResult> {
  const info = await loadConversationInfo(db, conversationId);
  if (!info) throw new InboxNotFoundError(CONVERSATION_NOT_FOUND);
  const now = deps.ctx.now();
  const customerMessages = (input.messages ?? []).map((m) => m.trim()).filter(Boolean);
  const sendHandoff = (input.sendHandoffMessage ?? input.createdBy === 'ai') && Boolean(info.handoffMessage);
  const outgoing =
    customerMessages.length > 0
      ? customerMessages
      : sendHandoff && info.handoffMessage
        ? [info.handoffMessage]
        : [];
  // Lỗi kiểm quyền gửi không được chặn việc chuyển người: coi như không gửi được.
  const canSendBot =
    outgoing.length > 0 &&
    (await botCanSend(db, info, deps.ctx).then(
      (r) => r.allowed,
      (error: unknown) => {
        deps.logger.warn(
          { conversationId, err: errorText(error) },
          'Không kiểm được quyền gửi tin chuyển người',
        );
        return false;
      },
    ));

  const tx = await db.transaction(async (tx) => {
    const [conv] = await tx
      .select({ status: conversations.status })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .for('update');
    if (!conv) throw new InboxNotFoundError(CONVERSATION_NOT_FOUND);
    const [open] = await tx
      .select({ id: handoffs.id })
      .from(handoffs)
      .where(and(eq(handoffs.conversationId, conversationId), isNull(handoffs.resolvedAt)))
      .orderBy(desc(handoffs.createdAt))
      .limit(1);
    if (open) {
      // Đang chờ người với handoff mở ⇒ dùng lại, không tạo trùng.
      if (conv.status === 'pending_human') return { handoffId: open.id, created: false as const };
      // Handoff mở sót lại trong khi hội thoại đã rời pending_human (dữ liệu cũ) ⇒ đóng nó trước khi tạo
      // handoff mới, để mỗi hội thoại có tối đa MỘT handoff mở.
      await tx
        .update(handoffs)
        .set({ resolvedAt: now, updatedAt: now })
        .where(and(eq(handoffs.conversationId, conversationId), isNull(handoffs.resolvedAt)));
    }

    const handoffMessageIds = canSendBot
      ? await insertBotMessages(tx, info, outgoing, input.aiRunId ?? null, now)
      : [];
    await tx
      .update(conversations)
      .set({
        status: 'pending_human',
        aiMode: 'off',
        handoffReason: input.reasonCode,
        handoffAt: now,
        updatedAt: now,
      })
      .where(eq(conversations.id, conversationId));
    const [handoff] = await tx
      .insert(handoffs)
      .values({
        conversationId,
        reasonCode: input.reasonCode,
        summary: input.summary,
        createdBy: input.createdBy,
        createdByUserId: input.createdBy === 'user' ? (input.createdByUserId ?? null) : null,
      })
      .returning({ id: handoffs.id });
    if (!handoff) throw new Error('Không tạo được handoff');
    const systemAt = new Date(now.getTime() + handoffMessageIds.length);
    const [system] = await tx
      .insert(messages)
      .values({
        conversationId,
        channelAccountId: info.channelAccountId,
        senderType: 'system',
        text: `${HANDOFF_SYSTEM_PREFIX}${HANDOFF_REASON_LABELS[input.reasonCode]}`,
        attachments: [],
        status: 'sent',
        aiRunId: input.aiRunId ?? null,
        sentAt: systemAt,
      })
      .returning({ id: messages.id });
    await tx
      .update(conversations)
      .set({
        lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${systemAt.toISOString()}::timestamptz)`,
      })
      .where(eq(conversations.id, conversationId));
    return {
      handoffId: handoff.id,
      created: true as const,
      handoffMessageIds,
      systemMessageId: system!.id,
    };
  });
  if (!tx.created) return { handoffId: tx.handoffId, created: false, botMessagesQueued: 0 };

  // Xếp hàng gửi lỗi không chặn chuyển người: tin còn 'queued' được requeueQueuedBotMessages gửi lại sau.
  const delays = bubbleDelays(tx.handoffMessageIds.length, deps.random);
  let queued = 0;
  try {
    for (const [i, id] of tx.handoffMessageIds.entries()) {
      await deps.scheduler.enqueueOutbound(id, delays[i] ?? 0);
      queued++;
    }
  } catch (error) {
    deps.logger.warn({ conversationId, err: errorText(error) }, 'Không xếp hàng được tin chuyển người');
  }
  await emitMessagesCreated(db, deps, [...tx.handoffMessageIds, tx.systemMessageId], conversationId);
  const summary = await emitConversationUpdated(db, deps, conversationId);
  deps.publisher.emit(
    roomsForConversation({ assignedUserId: summary?.assignedUser?.id ?? null }),
    'handoff.created',
    {
      conversationId,
      reasonCode: input.reasonCode,
      summary: input.summary,
      contactName: info.contactName,
      channelName: info.channelName,
    },
  );
  deps.logger.info(
    { conversationId, reasonCode: input.reasonCode, createdBy: input.createdBy },
    'Đã chuyển hội thoại cho người thật',
  );

  await notifyLarkSafe(db, deps, {
    conversationId,
    contactName: info.contactName,
    channelName: info.channelName,
    reasonCode: input.reasonCode,
    summary: input.summary,
  });
  // Cài đặt nhắc lại theo bot (0 = tắt); không có bot ⇒ HANDOFF_ESCALATE_AFTER_MIN (0 = tắt).
  const reminderMin = handoffReminderMinutes(
    { id: info.botId, handoffReminderMin: info.botReminderMin },
    deps.config.handoffReminderMin,
  );
  if (reminderMin > 0) {
    try {
      await deps.scheduler.scheduleHandoffReminder(
        { conversationId, handoffId: tx.handoffId },
        reminderMin * 60_000,
      );
    } catch (error) {
      deps.logger.warn({ conversationId, err: errorText(error) }, 'Không lên lịch nhắc handoff được');
    }
  }
  return { handoffId: tx.handoffId, created: true, botMessagesQueued: queued };
}

/**
 * Job "handoff-reminder": handoff còn mở (resolved_at null) và chưa ack ⇒ notifyLark thẻ reminder +
 * phát handoff.created { ..., reminder: true }. Ngược lại không làm gì. Trả true nếu đã nhắc.
 * Kiểm lại cài đặt LÚC CHẠY: bot hiện tại của hội thoại tắt nhắc lại (handoff_reminder_min = 0) — hoặc không có bot
 * và env = 0 — ⇒ không nhắc (job đã xếp từ trước khi đổi cài đặt).
 */
export async function processHandoffReminderJob(
  db: Db,
  deps: AiRuntimeDeps,
  data: HandoffReminderJobData,
): Promise<boolean> {
  const [row] = await db
    .select({
      reasonCode: handoffs.reasonCode,
      summary: handoffs.summary,
      acknowledgedAt: handoffs.acknowledgedAt,
      resolvedAt: handoffs.resolvedAt,
      status: conversations.status,
      assignedUserId: conversations.assignedUserId,
      contactName: contacts.displayName,
      channelName: channelAccounts.displayName,
      botId: chatbots.id,
      botReminderMin: chatbots.handoffReminderMin,
    })
    .from(handoffs)
    .innerJoin(conversations, eq(conversations.id, handoffs.conversationId))
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .innerJoin(channelAccounts, eq(channelAccounts.id, conversations.channelAccountId))
    .leftJoin(chatbots, eq(chatbots.id, conversations.chatbotId))
    .where(and(eq(handoffs.id, data.handoffId), eq(handoffs.conversationId, data.conversationId)));
  if (!row || row.resolvedAt || row.acknowledgedAt || row.status !== 'pending_human') return false;
  const reminderMin = handoffReminderMinutes(
    { id: row.botId, handoffReminderMin: row.botReminderMin },
    deps.config.handoffReminderMin,
  );
  if (reminderMin <= 0) return false;

  await notifyLarkSafe(db, deps, {
    conversationId: data.conversationId,
    contactName: row.contactName,
    channelName: row.channelName,
    reasonCode: row.reasonCode,
    summary: row.summary,
    reminder: true,
  });
  deps.publisher.emit(roomsForConversation(row), 'handoff.created', {
    conversationId: data.conversationId,
    reasonCode: row.reasonCode,
    summary: row.summary,
    contactName: row.contactName,
    channelName: row.channelName,
    reminder: true,
  });
  return true;
}
