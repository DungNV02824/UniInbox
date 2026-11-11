// Chuyển người thật (escalate) + nhắc lại khi chưa ai "Nhận xử lý".
import { channelAccounts, chatbots, contacts, conversations, handoffs, messages, type Db } from '@dezon/db';
import { HANDOFF_REASON_LABELS, type HandoffReasonCode } from '@dezon/shared';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { CONVERSATION_NOT_FOUND } from '../inbox/access';
import { InboxNotFoundError } from '../inbox/errors';
import type { DbLike } from '../inbox/read-model';
import type { HandoffReminderJobData } from '../jobs';
import { roomsForConversation } from '../realtime';
import {
  botCanSend,
  bubbleDelays,
  countBotTurnsLastHour,
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
  /**
   * Từ khóa chuyển người (chatbot.handoffKeywords, pre-filter) đã khớp ⇒ LUÔN dừng bot (ai_mode 'off'), bất kể
   * aiHandoffMode của bot. Không có ⇒ AI tự chuyển (tool escalate, độ tự tin thấp, bộ chặn "đã chuyển", lỗi): bot
   * đặt aiHandoffMode 'continue' thì giữ ai_mode 'auto' (xem escalateConversation).
   */
  matchedKeyword?: string | null;
}

export interface EscalateResult {
  handoffId: string;
  /** Số tin bot đã xếp hàng gửi (messages hoặc handoffMessage); 0 khi không gửi gì hoặc created false. */
  botMessagesQueued: number;
  /**
   * false nếu hội thoại đã pending_human với handoff mở (không tạo trùng — xem staffNotified), hoặc lần chạy đã xử
   * lý (chống trùng theo aiRunId). Handoff mở sót lại khi hội thoại KHÔNG ở pending_human bị đóng rồi tạo handoff mới
   * (tối đa một handoff mở / hội thoại).
   */
  created: boolean;
  /**
   * true = AI tự chuyển với bot aiHandoffMode 'continue': ai_mode GIỮ 'auto', bot vẫn trả lời các tin sau trong lúc
   * pending_human. false = bot dừng (ai_mode 'off') như trước, hoặc createdBy 'user' / từ khóa.
   */
  botContinues: boolean;
  /**
   * Lượt này đã báo nhân viên (tin system + handoff.created + Lark): true khi tạo handoff, hoặc khi bot đang trả lời
   * trong lúc chờ người (bot 'continue') escalate thêm yêu cầu mới với handoff đã mở. false = không làm gì (đã chờ
   * người với bot dừng, hoặc lần chạy đã xử lý — chống trùng theo aiRunId).
   */
  staffNotified: boolean;
}

/** Tiền tố tin system khi AI chuyển hội thoại. */
export const HANDOFF_SYSTEM_PREFIX = 'AI đã chuyển cho người thật: ';
/**
 * Tiền tố tin system khi bot aiHandoffMode 'continue' (đang trả lời trong lúc chờ người) escalate thêm một yêu cầu
 * MỚI trong khi handoff vẫn mở: không tạo handoff mới, chỉ báo thêm cho nhân viên.
 */
export const HANDOFF_REPEAT_PREFIX = 'AI báo thêm yêu cầu cho nhân viên: ';
/**
 * Bot 'continue' báo thêm CÙNG lý do trong vòng chừng này phút ⇒ không báo nhân viên lại (không tin system,
 * handoff.created, Lark) — chống spam khi AI lỗi / không chắc nhiều lượt liền. Tin gửi khách vẫn gửi bình thường.
 */
export const HANDOFF_REPEAT_NOTIFY_THROTTLE_MIN = 10;
/** Hậu tố tin system khi từ khóa chuyển người / nhân viên chuyển tay DỪNG bot đang trả lời trong lúc chờ người. */
export const HANDOFF_BOT_STOPPED_SUFFIX = ' — bot dừng trả lời';

/**
 * Dấu trong messages.raw của tin system chuyển người: `handoffBotContinues` = handoff tạo mà bot VẪN trả lời
 * (aiHandoffMode 'continue'); `handoffBotStopped` = sau đó bot bị dừng trong cùng handoff (từ khóa chuyển người…).
 * loadPendingMessages dựa vào đây: "trả lại cho AI" một handoff mà bot vẫn đang trả lời KHÔNG coi tin khách trước
 * đó là nhân viên đã lo (bot đang/ sắp trả lời các tin đó).
 */
export interface HandoffSystemRaw {
  handoffBotContinues?: { handoffId: string };
  handoffBotStopped?: { handoffId: string };
}
export const handoffBotContinuesRaw = (handoffId: string): HandoffSystemRaw => ({
  handoffBotContinues: { handoffId },
});
export const handoffBotStoppedRaw = (handoffId: string): HandoffSystemRaw => ({
  handoffBotStopped: { handoffId },
});

/** Độ dài tối đa tóm tắt handoff khi nối thêm yêu cầu mới (quá thì giữ tóm tắt cũ; tin system + Lark vẫn có). */
export const HANDOFF_SUMMARY_MAX = 4000;

/** Nối tóm tắt yêu cầu mới vào tóm tắt handoff đang mở (bỏ qua nếu rỗng, trùng, hoặc quá dài). */
export function appendHandoffSummary(current: string, next: string): string {
  const add = next.trim();
  if (!add || current.includes(add)) return current;
  const combined = current.trim() ? `${current}\n+ ${add}` : add;
  return combined.length > HANDOFF_SUMMARY_MAX ? current : combined;
}

/** Tin system chuyển người (status 'sent') + đẩy last_message_at. Trả id. */
async function insertHandoffSystemMessage(
  tx: DbLike,
  info: { id: string; channelAccountId: string },
  input: { text: string; aiRunId: string | null; at: Date; raw: HandoffSystemRaw | null },
): Promise<string> {
  const [system] = await tx
    .insert(messages)
    .values({
      conversationId: info.id,
      channelAccountId: info.channelAccountId,
      senderType: 'system',
      text: input.text,
      attachments: [],
      status: 'sent',
      aiRunId: input.aiRunId,
      ...(input.raw ? { raw: input.raw } : {}),
      sentAt: input.at,
    })
    .returning({ id: messages.id });
  await tx
    .update(conversations)
    .set({
      lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${input.at.toISOString()}::timestamptz)`,
    })
    .where(eq(conversations.id, info.id));
  return system!.id;
}

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
 * AI tự chuyển người (createdBy 'ai', không phải từ khóa chuyển người) và bot đang gắn đặt aiHandoffMode 'continue' và
 * hội thoại đang ai_mode 'auto' ⇒ bot vẫn trả lời sau khi chuyển (không tắt ai_mode).
 */
export function aiHandoffKeepsBot(input: {
  createdBy: EscalateInput['createdBy'];
  matchedKeyword?: string | null;
  aiMode: string;
  aiHandoffMode: string | null | undefined;
}): boolean {
  return (
    input.createdBy === 'ai' &&
    !input.matchedKeyword &&
    input.aiMode === 'auto' &&
    input.aiHandoffMode === 'continue'
  );
}

/**
 * Chuyển người thật (mục 7 của brief): [gửi `messages` (nếu có) HOẶC handoff_message] ⇒ transaction: status 'pending_human',
 * ai_mode 'off' (GIỮ chatbot_id) — TRỪ khi aiHandoffKeepsBot (AI tự chuyển + bot aiHandoffMode 'continue', đọc dưới
 * khóa): ai_mode giữ 'auto', mọi thứ khác y hệt (handoff, tin system, realtime, Lark, nhắc lại); handoff_reason, handoff_at = now; insert handoffs; insert message
 * sender 'system' text "AI đã chuyển cho người thật: <HANDOFF_REASON_LABELS[code]>" (status 'sent').
 * Sau commit: phát message.created (tin system) + conversation.updated + handoff.created
 * { conversationId, reasonCode, summary, contactName, channelName } tới roomsForConversation;
 * Lark (getLarkConfig có webhookUrl) ⇒ notifyLark(buildHandoffLarkCard(...)) — lỗi Lark chỉ log warn;
 * scheduler.scheduleHandoffReminder({ conversationId, handoffId }, N phút) với N = handoffReminderMinutes: bot của
 * hội thoại (chatbots.handoff_reminder_min) hoặc env khi không có bot; N = 0 ⇒ không lên lịch nhắc.
 * Đã pending_human với handoff mở ⇒ created false, KHÔNG tạo handoff trùng:
 * - bot đã dừng (ai_mode off — mặc định 'stop') ⇒ không làm gì (staffNotified false);
 * - bot đang trả lời trong lúc chờ người (ai_mode 'auto', bot 'continue') ⇒ đây là yêu cầu MỚI: tóm tắt nối vào
 *   handoff đang mở (appendHandoffSummary), tin system, conversation.updated, handoff.created, Lark (không lên lịch
 *   nhắc mới). aiHandoffKeepsBot ⇒ gửi `messages` (messages_to_customer; không gửi lại handoffMessage) trong giới hạn
 *   maxRepliesPerHour (countBotTurnsLastHour); không (từ khóa chuyển người / nhân viên chuyển tay) ⇒ ai_mode 'off'
 *   (bot dừng) + gửi messages hoặc handoffMessage như lần chuyển đầu.
 * Chống trùng theo aiRunId: lần chạy đã có tin bot/system (trừ tin "Đã báo nhân viên") ⇒ không làm gì.
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
      .select({
        status: conversations.status,
        aiMode: conversations.aiMode,
        chatbotId: conversations.chatbotId,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .for('update');
    if (!conv) throw new InboxNotFoundError(CONVERSATION_NOT_FOUND);
    // Đọc cài đặt bot NGAY LÚC chuyển (dưới khóa hội thoại): admin vừa đổi 'continue' ⇒ 'stop' thì dừng bot.
    const [bot] = conv.chatbotId
      ? await tx
          .select({ aiHandoffMode: chatbots.aiHandoffMode, maxRepliesPerHour: chatbots.maxRepliesPerHour })
          .from(chatbots)
          .where(eq(chatbots.id, conv.chatbotId))
      : [];
    const keepBot = aiHandoffKeepsBot({
      createdBy: input.createdBy,
      matchedKeyword: input.matchedKeyword ?? null,
      aiMode: conv.aiMode,
      aiHandoffMode: bot?.aiHandoffMode,
    });
    // Chống trùng theo lần chạy (escalate bù đua với lượt gốc — hai job cùng hội thoại có thể chạy chồng nhau): lần
    // chạy đã có tin bot / tin system chuyển người (không tính tin "Đã báo nhân viên" của notifyStaffKeyword) ⇒ tác
    // dụng phụ đã xong, không gửi lại.
    if (input.aiRunId) {
      const [done] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            eq(messages.aiRunId, input.aiRunId),
            inArray(messages.senderType, ['system', 'bot']),
            sql`(${messages.raw} -> 'notifyStaff') is null`,
          ),
        )
        .limit(1);
      if (done) {
        const [latest] = await tx
          .select({ id: handoffs.id })
          .from(handoffs)
          .where(eq(handoffs.conversationId, conversationId))
          .orderBy(desc(handoffs.createdAt))
          .limit(1);
        return { kind: 'noop' as const, handoffId: latest?.id ?? '', keepBot };
      }
    }
    const [open] = await tx
      .select({ id: handoffs.id, summary: handoffs.summary })
      .from(handoffs)
      .where(and(eq(handoffs.conversationId, conversationId), isNull(handoffs.resolvedAt)))
      .orderBy(desc(handoffs.createdAt))
      .limit(1);
    if (open) {
      if (conv.status === 'pending_human') {
        // Đang chờ người, bot đã dừng (ai_mode off) ⇒ dùng lại handoff, không làm gì thêm (như trước).
        if (conv.aiMode !== 'auto') return { kind: 'noop' as const, handoffId: open.id, keepBot };
        // Bot đang trò chuyện trong lúc chờ người (bot 'continue') ⇒ yêu cầu MỚI của lượt này: không tạo handoff
        // trùng nhưng vẫn báo nhân viên (tin system + tóm tắt nối vào handoff + handoff.created + Lark).
        // keepBot ⇒ gửi messages_to_customer (trong giới hạn lượt/giờ); không (từ khóa chuyển người / nhân viên tự
        // chuyển) ⇒ DỪNG bot (ai_mode 'off') và gửi tin chuyển người như lần chuyển đầu.
        const capped =
          keepBot && bot ? (await countBotTurnsLastHour(tx, conversationId)) >= bot.maxRepliesPerHour : false;
        const bubbles = keepBot ? customerMessages : outgoing;
        const messageIds =
          canSendBot && !capped && bubbles.length > 0
            ? await insertBotMessages(tx, info, bubbles, input.aiRunId ?? null, now)
            : [];
        const summary = appendHandoffSummary(open.summary, input.summary);
        if (summary !== open.summary) {
          await tx.update(handoffs).set({ summary, updatedAt: now }).where(eq(handoffs.id, open.id));
        }
        if (!keepBot) {
          await tx
            .update(conversations)
            .set({ aiMode: 'off', updatedAt: now })
            .where(eq(conversations.id, conversationId));
        }
        const label = HANDOFF_REASON_LABELS[input.reasonCode];
        const repeatText = `${HANDOFF_REPEAT_PREFIX}${label}`;
        // Đã báo thêm cùng lý do gần đây ⇒ lượt này im lặng với nhân viên (chỉ gửi tin cho khách nếu có).
        const [recent] = keepBot
          ? await tx
              .select({ id: messages.id })
              .from(messages)
              .where(
                and(
                  eq(messages.conversationId, conversationId),
                  eq(messages.senderType, 'system'),
                  eq(messages.text, repeatText),
                  gt(
                    messages.createdAt,
                    new Date(now.getTime() - HANDOFF_REPEAT_NOTIFY_THROTTLE_MIN * 60_000),
                  ),
                ),
              )
              .limit(1)
          : [];
        const quiet = Boolean(recent);
        const systemId = quiet
          ? null
          : await insertHandoffSystemMessage(tx, info, {
              text: keepBot ? repeatText : `${HANDOFF_SYSTEM_PREFIX}${label}${HANDOFF_BOT_STOPPED_SUFFIX}`,
              aiRunId: input.aiRunId ?? null,
              at: new Date(now.getTime() + messageIds.length),
              raw: keepBot ? null : handoffBotStoppedRaw(open.id),
            });
        return {
          kind: 'repeat' as const,
          handoffId: open.id,
          handoffMessageIds: messageIds,
          systemMessageId: systemId,
          keepBot,
          capped,
          quiet,
        };
      }
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
        // 'continue' ⇒ không đụng ai_mode (đang 'auto'): bot vẫn trả lời trong lúc chờ nhân viên.
        ...(keepBot ? {} : { aiMode: 'off' as const }),
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
    const systemMessageId = await insertHandoffSystemMessage(tx, info, {
      text: `${HANDOFF_SYSTEM_PREFIX}${HANDOFF_REASON_LABELS[input.reasonCode]}`,
      aiRunId: input.aiRunId ?? null,
      at: new Date(now.getTime() + handoffMessageIds.length),
      // Bot vẫn trả lời ⇒ "trả lại cho AI" không coi tin khách trước đó là nhân viên đã lo (loadPendingMessages).
      raw: keepBot ? handoffBotContinuesRaw(handoff.id) : null,
    });
    return {
      kind: 'created' as const,
      handoffId: handoff.id,
      handoffMessageIds,
      systemMessageId,
      keepBot,
    };
  });

  // Xếp hàng gửi lỗi không chặn chuyển người: tin còn 'queued' được requeueQueuedBotMessages gửi lại sau.
  const enqueue = async (ids: readonly string[]): Promise<number> => {
    const delays = bubbleDelays(ids.length, deps.random);
    let n = 0;
    try {
      for (const [i, id] of ids.entries()) {
        await deps.scheduler.enqueueOutbound(id, delays[i] ?? 0);
        n++;
      }
    } catch (error) {
      deps.logger.warn({ conversationId, err: errorText(error) }, 'Không xếp hàng được tin chuyển người');
    }
    return n;
  };
  if (tx.kind === 'noop') {
    return {
      handoffId: tx.handoffId,
      created: false,
      botMessagesQueued: 0,
      botContinues: tx.keepBot,
      staffNotified: false,
    };
  }

  const queued = await enqueue(tx.handoffMessageIds);
  await emitMessagesCreated(
    db,
    deps,
    tx.systemMessageId ? [...tx.handoffMessageIds, tx.systemMessageId] : tx.handoffMessageIds,
    conversationId,
  );
  const summary = await emitConversationUpdated(db, deps, conversationId);
  if (tx.kind === 'repeat' && tx.quiet) {
    deps.logger.info(
      { conversationId, reasonCode: input.reasonCode, capped: tx.capped },
      'Báo thêm cùng lý do gần đây ⇒ không báo nhân viên lại',
    );
    return {
      handoffId: tx.handoffId,
      created: false,
      botMessagesQueued: queued,
      botContinues: tx.keepBot,
      // Nhân viên đã được báo cùng lý do trong HANDOFF_REPEAT_NOTIFY_THROTTLE_MIN phút.
      staffNotified: true,
    };
  }
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
  const repeat = tx.kind === 'repeat';
  deps.logger.info(
    {
      conversationId,
      reasonCode: input.reasonCode,
      createdBy: input.createdBy,
      botContinues: tx.keepBot,
      ...(repeat ? { repeat: true, capped: tx.capped } : {}),
    },
    repeat
      ? 'Báo thêm yêu cầu cho nhân viên (hội thoại đang chờ người)'
      : 'Đã chuyển hội thoại cho người thật',
  );

  await notifyLarkSafe(db, deps, {
    conversationId,
    contactName: info.contactName,
    channelName: info.channelName,
    reasonCode: input.reasonCode,
    summary: input.summary,
  });
  // Handoff đã mở từ trước (nhắc lại đã lên lịch theo handoff đó) ⇒ không lên lịch nhắc mới.
  if (repeat) {
    return {
      handoffId: tx.handoffId,
      created: false,
      botMessagesQueued: queued,
      botContinues: tx.keepBot,
      staffNotified: true,
    };
  }
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
  return {
    handoffId: tx.handoffId,
    created: true,
    botMessagesQueued: queued,
    botContinues: tx.keepBot,
    staffNotified: true,
  };
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
