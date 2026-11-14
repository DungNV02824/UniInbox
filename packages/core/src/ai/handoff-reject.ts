// Nút "Không đạt" trên banner "Cần người" (POST /conversations/:id/handoff/reject): nhân viên gõ lý do ⇒ AI (giọng văn
// của bot đang gắn: Hướng dẫn, Kiến thức, model, nhiệt độ, tốc độ) soạn 1–3 tin khéo léo báo khách lần gửi CHƯA ĐẠT +
// lý do, rồi GỬI THẲNG cho khách (tin bot, qua outbound — không xem trước). Yêu cầu chuyển người GIỮ NGUYÊN: không ack,
// không resolve, không đổi status / ai_mode / tạm dừng. Ví dụ: CTV gửi ảnh công trình cho bot "Vua Thầu", nhân viên
// từ chối "công trình mới làm móng, chưa lên tầng".
import {
  aiRuns,
  auditLogs,
  channelAccounts,
  chatbots,
  conversations,
  handoffs,
  messages,
  users,
  type Db,
} from '@dezon/db';
import { HANDOFF_REJECT_LABEL, HANDOFF_REJECT_LIMITS } from '@dezon/shared';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { CONVERSATION_NOT_FOUND, canViewConversation } from '../inbox/access';
import type { UpdateConversationResult } from '../inbox/commands';
import {
  InboxForbiddenError,
  InboxNotFoundError,
  InboxValidationError,
  SendNotAllowedError,
} from '../inbox/errors';
import type { DbLike } from '../inbox/read-model';
import type { Viewer } from '../inbox/types';
import { toChatbotConfig } from './config';
import { botCanSend, bubbleDelays, emitMessagesCreated, errorText, insertBotMessages } from './delivery';
import { ChatbotComposeError } from './errors';
import { handoffActionBlockedText, type HandoffActionMessageDeps } from './handoff-action';
import type { LlmClient } from './llm';
import { runChatbotTurn } from './orchestrator';
import { withConversation } from './service';
import { getAiSettings, getBusinessHours } from './settings';
import { loadPendingMessages, loadTurnHistory } from './turn-input';
import type { ChatbotTurnResult } from './types';

export const HANDOFF_REJECT_NO_OPEN = 'Hội thoại không có yêu cầu chuyển người nào đang mở';
export const HANDOFF_REJECT_NO_BOT = `Hội thoại chưa gắn chatbot nên AI không soạn được tin «${HANDOFF_REJECT_LABEL}»`;
export const HANDOFF_REJECT_BOT_INACTIVE = `Chatbot đang tắt, hãy bật bot trước khi dùng nút «${HANDOFF_REJECT_LABEL}»`;
export const HANDOFF_REJECT_AI_DISABLED = `AI tổng đang tắt (Cài đặt), hãy bật lại trước khi dùng nút «${HANDOFF_REJECT_LABEL}»`;
export const HANDOFF_REJECT_BOT_CHANGED = 'Chatbot của hội thoại vừa thay đổi, vui lòng thử lại';
/** Tên mục đầu tiên của ai_runs.tool_calls cho lượt "Không đạt" (args: handoffId, reasonChars — KHÔNG ghi lý do). */
export const STAFF_REJECT_TOOL_LOG = 'staff_reject';

export interface RejectHandoffDeps extends HandoffActionMessageDeps {
  llm: LlmClient;
  /** GEMINI_MODEL — dùng khi bot để trống model. */
  defaultModel: string;
  /** Chờ giữa các lần thử lại LLM (test truyền hàm không chờ). */
  sleep?: (ms: number) => Promise<void>;
  /** Timeout mỗi lần gọi LLM (mặc định LLM_TIMEOUT_MS). */
  timeoutMs?: number;
}

export interface RejectHandoffResult extends UpdateConversationResult {
  /** Handoff đang mở được đánh dấu "Không đạt" (vẫn mở). */
  handoffId: string;
  /** ai_runs của lượt soạn tin (hiện ở "Nhật ký AI"). */
  aiRunId: string;
  /** Tin system cho nhân viên ("Nhân viên … đánh dấu Không đạt: …"). */
  systemMessageId: string;
  /** Tin bot đã tạo (status 'queued'), theo thứ tự gửi. */
  messageIds: string[];
  /** Số tin đã đẩy vào hàng đợi outbound (lỗi Redis ⇒ sweeper requeueQueuedBotMessages gửi lại). */
  queued: number;
}

/** Tin system (chỉ nhân viên thấy) ghi ai đã bấm "Không đạt" và lý do — để tra lại sau. */
export function handoffRejectSystemText(actorName: string, reason: string): string {
  return `Nhân viên ${actorName} đánh dấu ${HANDOFF_REJECT_LABEL}: ${reason}`;
}

/** Trim; rỗng / dài hơn HANDOFF_REJECT_LIMITS.reasonMaxChars ký tự (code point) ⇒ InboxValidationError. */
function normalizeReason(reason: string): string {
  const text = reason.trim();
  if (!text) throw new InboxValidationError('Nhập lý do không đạt');
  if (Array.from(text).length > HANDOFF_REJECT_LIMITS.reasonMaxChars) {
    throw new InboxValidationError(`Lý do tối đa ${HANDOFF_REJECT_LIMITS.reasonMaxChars} ký tự`);
  }
  return text;
}

async function loadTarget(db: Db, conversationId: string) {
  const [row] = await db
    .select({
      id: conversations.id,
      channelAccountId: conversations.channelAccountId,
      assignedUserId: conversations.assignedUserId,
      status: conversations.status,
      lastCustomerMessageAt: conversations.lastCustomerMessageAt,
      windowSource: conversations.windowSource,
      channelType: channelAccounts.type,
      channelStatus: channelAccounts.status,
      channelName: channelAccounts.displayName,
      bot: chatbots,
    })
    .from(conversations)
    .innerJoin(channelAccounts, eq(channelAccounts.id, conversations.channelAccountId))
    .leftJoin(chatbots, eq(chatbots.id, conversations.chatbotId))
    .where(eq(conversations.id, conversationId));
  return row;
}

/** Handoff mở mới nhất (resolved_at null) — cùng quy tắc với ackHandoff. */
async function latestOpenHandoffId(db: DbLike, conversationId: string): Promise<string | null> {
  const [open] = await db
    .select({ id: handoffs.id })
    .from(handoffs)
    .where(and(eq(handoffs.conversationId, conversationId), isNull(handoffs.resolvedAt)))
    .orderBy(desc(handoffs.createdAt))
    .limit(1);
  return open?.id ?? null;
}

interface SavedReject {
  handoffId: string;
  aiRunId: string;
  systemMessageId: string;
  messageIds: string[];
}

interface RunInsert {
  conversationId: string;
  chatbotId: string;
  model: string;
  result: ChatbotTurnResult;
  handoffId: string;
  reasonChars: number;
  decision: 'reply' | 'error';
  error: string | null;
  /** Tin khách được coi là đã xử lý (chỉ lượt 'reply' đã gửi; lượt lỗi để rỗng). */
  triggerMessageIds?: string[];
}

/**
 * ai_runs của lượt "Không đạt" (như lượt bot thường, để "Nhật ký AI" hiện model/token/độ trễ/tin đã soạn). Lượt 'error'
 * trigger rỗng ⇒ không đụng mốc tin khách chưa xử lý (loadPendingMessages) và không bị escalate bù
 * (recoverLostSideEffects — chỉ xét escalate/error có trigger). Lượt 'reply' trigger = tin khách chưa xử lý mà AI đã
 * thấy lúc soạn ⇒ lượt ai-reply của bot 'continue' đang chạy song song bị hủy ("Lần chạy khác đã xử lý các tin này")
 * thay vì gửi câu kiểu "em đã nhận ảnh, đang chờ duyệt" xen giữa tin "Không đạt".
 */
async function insertRejectRun(db: DbLike, r: RunInsert): Promise<string> {
  const [row] = await db
    .insert(aiRuns)
    .values({
      conversationId: r.conversationId,
      chatbotId: r.chatbotId,
      triggerMessageIds: r.triggerMessageIds ?? [],
      model: r.result.model || r.model,
      inputTokens: r.result.usage.inputTokens,
      outputTokens: r.result.usage.outputTokens,
      latencyMs: Math.max(0, Math.round(r.result.latencyMs)),
      decision: r.decision,
      toolCalls: [
        { name: STAFF_REJECT_TOOL_LOG, args: { handoffId: r.handoffId, reasonChars: r.reasonChars } },
        ...r.result.toolCalls,
      ],
      reasoningSummary: `Nhân viên bấm «${HANDOFF_REJECT_LABEL}» — bot soạn tin báo khách`,
      error: r.error,
    })
    .returning({ id: aiRuns.id });
  return row!.id;
}

/**
 * POST /conversations/:id/handoff/reject ("Không đạt"). Thứ tự:
 * 1. Lý do: trim, 1..HANDOFF_REJECT_LIMITS.reasonMaxChars ký tự ⇒ không thì InboxValidationError.
 * 2. Hội thoại không có ⇒ InboxNotFoundError; viewer không xem được (canViewConversation, như ackHandoff) ⇒
 *    InboxForbiddenError. Không ở pending_human hoặc không có handoff mở ⇒ InboxValidationError(HANDOFF_REJECT_NO_OPEN).
 *    Không gắn bot / bot tắt / AI tổng tắt ⇒ InboxValidationError.
 * 3. botCanSend chặn (kênh mất kết nối / ngoài cửa sổ) ⇒ KHÔNG gọi AI: thêm tin system
 *    handoffActionBlockedText(HANDOFF_REJECT_LABEL, lý do chặn) cho nhân viên (message.created) rồi ném
 *    SendNotAllowedError(cùng câu đó).
 * 4. runChatbotTurn với bot đang gắn + lịch sử (loadTurnHistory, không có tin mới) + staffRejectReason ⇒ chỉ tool
 *    `reply`, không escalate. Không ra 'reply' có bong bóng ⇒ ghi ai_runs 'error' rồi ném ChatbotComposeError — KHÔNG
 *    gửi gì.
 * 5. Một transaction (withConversation: khóa dòng + kiểm quyền lại): vẫn pending_human + còn handoff mở (không ⇒
 *    HANDOFF_REJECT_NO_OPEN, không gửi gì), vẫn đúng bot (không ⇒ HANDOFF_REJECT_BOT_CHANGED); ghi ai_runs 'reply'
 *    (trigger = tin khách chưa xử lý đọc TRƯỚC khi gọi AI và vẫn chưa xử lý dưới khóa — cùng khóa dòng với chống đua
 *    của runtime ⇒ lượt ai-reply song song (bot 'continue') thấy tin đã được xử lý và hủy; tin khách đến SAU lúc đọc
 *    vẫn chờ, debounce của chính nó trả lời. Lượt ai-reply commit TRƯỚC thì tin của nó đã gửi — chấp nhận; tool_calls mở đầu { name: 'staff_reject', args: { handoffId, reasonChars } }), tin system
 *    handoffRejectSystemText(tên nhân viên, lý do), tin bot (insertBotMessages: sender 'bot', queued, ai_run_id, cập
 *    nhật last_message_at), audit 'handoff.reject' { handoffId, reasonChars, aiRunId, bubbles } — KHÔNG ghi lý do.
 *    KHÔNG đổi handoff / status / ai_mode / ai_paused_until (tin bot không kích hoạt "nhân viên nhắn ⇒ tạm dừng bot").
 * 6. Sau commit: enqueueOutbound từng tin (bubbleDelays; lỗi chỉ log — sweeper gửi lại), message.created cho tin system
 *    + tin bot. Trả summary mới (API phát conversation.updated) + id.
 */
export async function rejectHandoffWithAiReply(
  db: Db,
  viewer: Viewer,
  conversationId: string,
  reason: string,
  deps: RejectHandoffDeps,
): Promise<RejectHandoffResult> {
  const text = normalizeReason(reason);
  const target = await loadTarget(db, conversationId);
  if (!target) throw new InboxNotFoundError(CONVERSATION_NOT_FOUND);
  if (!canViewConversation(viewer, target)) {
    throw new InboxForbiddenError('Bạn không có quyền thao tác trên hội thoại này');
  }
  if (target.status !== 'pending_human' || !(await latestOpenHandoffId(db, conversationId))) {
    throw new InboxValidationError(HANDOFF_REJECT_NO_OPEN);
  }
  const bot = target.bot;
  if (!bot) throw new InboxValidationError(HANDOFF_REJECT_NO_BOT);
  if (!bot.isActive) throw new InboxValidationError(HANDOFF_REJECT_BOT_INACTIVE);
  if (!(await getAiSettings(db)).enabled) throw new InboxValidationError(HANDOFF_REJECT_AI_DISABLED);

  // 3. Kiểm quyền gửi TRƯỚC khi gọi AI (không tốn token cho tin không gửi được).
  const check = await botCanSend(db, target, deps.ctx);
  if (!check.allowed) {
    const blockedText = handoffActionBlockedText(
      HANDOFF_REJECT_LABEL,
      check.reason ?? 'Không được phép gửi lúc này',
    );
    const now = deps.ctx.now();
    const systemMessageId = await db.transaction(async (tx) => {
      const [system] = await tx
        .insert(messages)
        .values({
          conversationId: target.id,
          channelAccountId: target.channelAccountId,
          senderType: 'system',
          text: blockedText,
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
        .where(eq(conversations.id, target.id));
      return system!.id;
    });
    deps.logger.info(
      { conversationId, reason: check.reason },
      `Bot không gửi được tin «${HANDOFF_REJECT_LABEL}» — không gọi AI`,
    );
    await emitMessagesCreated(db, deps, [systemMessageId], conversationId);
    throw new SendNotAllowedError(blockedText);
  }

  // 4. AI soạn tin theo bot đang gắn.
  // Tin khách chưa xử lý đọc TRƯỚC lịch sử ⇒ chắc chắn nằm trong lịch sử AI thấy; bước 5 đánh dấu đã xử lý.
  const pendingBefore = await loadPendingMessages(db, conversationId);
  const [{ history }, businessHours] = await Promise.all([
    loadTurnHistory(db, conversationId, []),
    getBusinessHours(db),
  ]);
  const model = bot.model ?? deps.defaultModel;
  const result = await runChatbotTurn(
    {
      llm: deps.llm,
      now: deps.ctx.now,
      defaultModel: deps.defaultModel,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    },
    {
      chatbot: toChatbotConfig(bot),
      history,
      newMessages: [],
      channelName: target.channelName,
      businessHours,
      staffRejectReason: text,
    },
  );
  const reasonChars = Array.from(text).length;
  const bubbles = result.decision === 'reply' ? (result.messages ?? []) : [];
  if (bubbles.length === 0) {
    const error =
      result.decision === 'error'
        ? (result.reason ?? 'Lỗi AI')
        : `AI không gọi reply (decision ${result.decision})`;
    try {
      const handoffId = (await latestOpenHandoffId(db, conversationId)) ?? '';
      await insertRejectRun(db, {
        conversationId,
        chatbotId: bot.id,
        model,
        result,
        handoffId,
        reasonChars,
        decision: 'error',
        error,
      });
    } catch (logError) {
      deps.logger.warn({ conversationId, err: errorText(logError) }, 'Không ghi được ai_runs lượt Không đạt');
    }
    deps.logger.warn(
      { conversationId, decision: result.decision, error },
      `AI không soạn được tin «${HANDOFF_REJECT_LABEL}» — không gửi gì`,
    );
    throw new ChatbotComposeError();
  }

  // 5. Ghi trong một transaction; kiểm lại dưới khóa (nhân viên khác có thể vừa bấm "xong" trong lúc AI soạn).
  const saved: { value?: SavedReject } = {};
  const updated = await withConversation(db, viewer, conversationId, deps.ctx, async (tx, conv) => {
    const handoffId = conv.status === 'pending_human' ? await latestOpenHandoffId(tx, conv.id) : null;
    if (!handoffId) throw new InboxValidationError(HANDOFF_REJECT_NO_OPEN);
    if (conv.chatbotId !== bot.id) throw new InboxValidationError(HANDOFF_REJECT_BOT_CHANGED);
    const now = deps.ctx.now();
    const [actor] = await tx.select({ name: users.name }).from(users).where(eq(users.id, viewer.id));
    // Chỉ tin AI đã thấy VÀ vẫn chưa xử lý dưới khóa (lượt ai-reply vừa commit đã nhận tin nào thì thôi).
    const seen = new Set(pendingBefore.map((m) => m.id));
    const triggerMessageIds = (await loadPendingMessages(tx, conv.id))
      .filter((m) => seen.has(m.id))
      .map((m) => m.id);
    const aiRunId = await insertRejectRun(tx, {
      conversationId: conv.id,
      chatbotId: bot.id,
      model,
      result,
      handoffId,
      reasonChars,
      decision: 'reply',
      error: null,
      triggerMessageIds,
    });
    const [system] = await tx
      .insert(messages)
      .values({
        conversationId: conv.id,
        channelAccountId: target.channelAccountId,
        senderType: 'system',
        text: handoffRejectSystemText(actor?.name?.trim() || 'Nhân viên', text),
        attachments: [],
        status: 'sent',
        raw: { handoffReject: { handoffId, aiRunId } },
        sentAt: now,
      })
      .returning({ id: messages.id });
    // Tin bot ngay sau tin system (sent_at +1 ms) ⇒ nhân viên đọc lý do trước các tin bot.
    const messageIds = await insertBotMessages(
      tx,
      { id: conv.id, channelAccountId: target.channelAccountId },
      bubbles,
      aiRunId,
      new Date(now.getTime() + 1),
    );
    await tx.insert(auditLogs).values({
      userId: viewer.id,
      action: 'handoff.reject',
      entity: 'conversation',
      entityId: conv.id,
      // Chỉ độ dài lý do — không ghi nội dung.
      data: { handoffId, reasonChars, aiRunId, bubbles: messageIds.length },
    });
    saved.value = { handoffId, aiRunId, systemMessageId: system!.id, messageIds };
  });
  const done = saved.value!;

  // 6. Xếp hàng gửi; lỗi không làm hỏng thao tác: tin còn 'queued' được requeueQueuedBotMessages gửi lại sau.
  const delays = bubbleDelays(done.messageIds.length, deps.random);
  let queued = 0;
  try {
    for (const [i, id] of done.messageIds.entries()) {
      await deps.scheduler.enqueueOutbound(id, delays[i] ?? 0);
      queued++;
    }
  } catch (error) {
    deps.logger.warn(
      { conversationId, err: errorText(error) },
      `Không xếp hàng được tin «${HANDOFF_REJECT_LABEL}»`,
    );
  }
  await emitMessagesCreated(db, deps, [done.systemMessageId, ...done.messageIds], conversationId);
  return { ...updated, ...done, queued };
}
