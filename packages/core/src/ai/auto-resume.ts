// Tự trả lại hội thoại cho bot khi AI hoạt động lại: hội thoại bị chuyển "Cần người" vì LỖI PHÍA AI (hết tiền Gemini
// 402, quá tải 429, hết thời gian chờ, 5xx, mạng… — handoffs.auto_resume) được worker quét định kỳ; AI trả lời được
// một lời gọi thử rẻ ⇒ trả lại cho bot (như nút "Đã xong, trả lại cho AI" nhưng không gửi tin của nút, không báo
// Lark), rồi đánh thức bot nếu khách đang chờ.
import {
  aiRuns,
  auditLogs,
  channelAccounts,
  chatbots,
  conversations,
  handoffs,
  messages,
  type Db,
} from '@dezon/db';
import { AI_MISSED_REPLY_MAX_AGE_HOURS, AI_MISSED_REPLY_MIN_AGE_MIN } from '@dezon/shared';
import { and, asc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';
import { resolveOpenHandoffs } from '../inbox/commands';
import type { DbLike } from '../inbox/read-model';
import type { InboxContext } from '../inbox/types';
import { notAutomatedEcho } from '../pipeline/automation-echo';
import { aiOutageResumableSql } from './auto-resume-sql';
import { botCanSend, emitConversationUpdated, emitMessagesCreated, errorText } from './delivery';
import { isLlmOutageErrorText, type LlmClient } from './llm';
import { type AiRuntimeDeps } from './runtime';
import { returnConversationToBot } from './service';
import { getAiSettings } from './settings';
import { CHATBOT_TOOLS } from './tools';
import { autoResumedHandoffSql, loadPendingMessages } from './turn-input';

export { AI_AUTO_RESUME_MAX_AGE_DAYS } from './auto-resume-sql';

/** Chu kỳ job quét (worker: job scheduler của hàng đợi ai-reply). */
export const AI_AUTO_RESUME_EVERY_MS = 3 * 60_000;
/** Tối đa số hội thoại trả lại mỗi lượt quét (còn lại ⇒ lượt sau). */
export const AI_AUTO_RESUME_BATCH = 50;
/**
 * Giãn cách giữa hai lượt bot được đánh thức (độ trễ của job ai-reply tăng dần theo thứ tự — job quét KHÔNG ngủ, không
 * giữ khe của hàng đợi ai-reply): bot không dồn cả loạt lời gọi AI cùng lúc ngay sau khi AI hồi phục.
 */
export const AI_AUTO_RESUME_SPACING_MS = 2_000;
/** Thời gian chờ của lời gọi thử AI. */
export const AI_AUTO_RESUME_PROBE_TIMEOUT_MS = 15_000;
/** Khóa Redis chống chạy chồng (nhiều worker / lượt trước chưa xong). */
export const AI_AUTO_RESUME_LOCK_KEY = 'ai-auto-resume:lock';
export const AI_AUTO_RESUME_LOCK_TTL_MS = 10 * 60_000;
/**
 * Chống vòng lặp "trả lại ⇒ AI lại lỗi ⇒ chuyển người ⇒ báo Lark ⇒ trả lại…" (gọi thử rẻ thì được nhưng lượt thật vẫn
 * hỏng, vd. timeout với lượt nhiều ảnh): hội thoại vừa được tự trả lại trong AI_AUTO_RESUME_COOLDOWN_MIN phút ⇒ chờ;
 * đã tự trả lại AI_AUTO_RESUME_MAX_PER_DAY lần trong 24 giờ ⇒ thôi, để nhân viên xử lý.
 */
export const AI_AUTO_RESUME_COOLDOWN_MIN = 60;
export const AI_AUTO_RESUME_MAX_PER_DAY = 3;
/**
 * Nút "Bật lại AI" (manual): tối đa số hội thoại trả lại trong MỘT lần bấm (một truy vấn — thực tế hiếm khi quá vài
 * chục; trần chỉ để job không chạy vô hạn).
 */
export const AI_MANUAL_RESUME_MAX = 1000;
/**
 * Lần bấm tay gặp khóa Redis (lượt quét định kỳ / lần bấm khác đang chạy) ⇒ thử lấy lại khóa mỗi
 * AI_MANUAL_RESUME_LOCK_POLL_MS, tối đa AI_MANUAL_RESUME_LOCK_WAIT_MS; vẫn không được ⇒ CHẠY LUÔN không giữ khóa (an
 * toàn: resumeAiOutageHandoff khóa dòng hội thoại và kiểm lại điều kiện trong transaction ⇒ lượt chạy song song chỉ
 * thấy "đã được trả lại" và bỏ qua). Không bao giờ âm thầm bỏ lần bấm của nhân viên.
 */
export const AI_MANUAL_RESUME_LOCK_WAIT_MS = 30_000;
export const AI_MANUAL_RESUME_LOCK_POLL_MS = 1_000;
/** Audit một lần bấm "Bật lại AI" (userId = người bấm). */
export const AI_MANUAL_RESUME_AUDIT_ACTION = 'ai.manual_resume';
/**
 * Lượt AI lỗi (ai_runs 'error' vì AI ngừng hoạt động) tạo trước handoff tối đa chừng này phút vẫn tính là lượt gây ra
 * handoff (lượt ghi ai_runs ngay sau lời gọi AI hỏng, rồi mới chuyển người).
 */
const OUTAGE_RUN_BEFORE_HANDOFF_MIN = 10;

/** Tin system (chỉ nhân viên thấy) khi hệ thống tự trả lại hội thoại cho bot. */
export const AI_AUTO_RESUME_SYSTEM_TEXT = 'AI đã hoạt động lại — tự trả lại hội thoại cho bot';

/** Lời gọi thử: prompt tí hon + chỉ tool `no_reply` (rẻ nhất có thể, vẫn đi đúng đường gọi thật của bot). */
const PROBE_SYSTEM_INSTRUCTION = 'Kiểm tra kết nối. Gọi no_reply với reason "ok".';
const PROBE_TOOLS = CHATBOT_TOOLS.filter((t) => t.name === 'no_reply');

export interface AiOutageResumeCandidate {
  handoffId: string;
  conversationId: string;
  /** Model của bot đang gắn (null ⇒ model mặc định). */
  model: string | null;
  handoffCreatedAt: Date;
}

/**
 * Điều kiện một handoff được tự trả lại (dùng cho cả lúc quét lẫn lúc kiểm lại dưới khóa): aiOutageResumableSql
 * (handoff đang mở, auto_resume, chưa ai "Nhận xử lý", tạo trong AI_AUTO_RESUME_MAX_AGE_DAYS ngày, còn gắn bot đang
 * bật, KHÔNG có tin nhân viên — trừ echo tự động của Page — từ lúc handoff tạo; cùng định nghĩa với banner/nhắc Lark);
 * hội thoại pending_human, không bị nhân viên tạm dừng AI; không có handoff mở KHÁC cần người (không auto_resume hoặc
 * đã có người nhận); chưa tự trả lại hội thoại trong AI_AUTO_RESUME_COOLDOWN_MIN phút và chưa quá
 * AI_AUTO_RESUME_MAX_PER_DAY lần trong 24 giờ. `manual` (nút "Bật lại AI") ⇒ BỎ hai giới hạn chống lặp sau cùng (nhân
 * viên chủ động bấm), mọi điều kiện khác giữ nguyên.
 */
function candidateWhere(now: Date, filter: CandidateFilter = {}) {
  const nowIso = now.toISOString();
  const { handoffId, manual } = filter;
  return and(
    handoffId ? eq(handoffs.id, handoffId) : undefined,
    isNull(handoffs.resolvedAt),
    eq(handoffs.autoResume, true),
    isNull(handoffs.acknowledgedBy),
    eq(conversations.status, 'pending_human'),
    eq(chatbots.isActive, true),
    aiOutageResumableSql('"handoffs"', sql`${nowIso}::timestamptz`),
    sql`(${conversations.aiPausedUntil} is null or ${conversations.aiPausedUntil} <= ${nowIso}::timestamptz)`,
    sql`not exists (select 1 from ${handoffs} o
      where o.conversation_id = ${handoffs.conversationId} and o.resolved_at is null and o.id <> ${handoffs.id}
        and (not o.auto_resume or o.acknowledged_by is not null))`,
    manual
      ? undefined
      : sql`not exists (select 1 from ${handoffs} p
      where p.conversation_id = ${handoffs.conversationId} and ${autoResumedHandoffSql('p')}
        and p.resolved_at > ${nowIso}::timestamptz - make_interval(mins => ${AI_AUTO_RESUME_COOLDOWN_MIN}))`,
    manual
      ? undefined
      : sql`(select count(*) from ${handoffs} p
      where p.conversation_id = ${handoffs.conversationId} and ${autoResumedHandoffSql('p')}
        and p.resolved_at > ${nowIso}::timestamptz - interval '24 hours') < ${AI_AUTO_RESUME_MAX_PER_DAY}`,
  );
}

interface CandidateFilter {
  /** Chỉ xét đúng handoff này (kiểm lại dưới khóa). */
  handoffId?: string;
  /** Nút "Bật lại AI": bỏ giới hạn chống lặp (cooldown / số lần mỗi ngày). */
  manual?: boolean;
}

function selectCandidates(db: DbLike, now: Date, limit: number, filter: CandidateFilter = {}) {
  return db
    .select({
      handoffId: handoffs.id,
      conversationId: handoffs.conversationId,
      model: chatbots.model,
      handoffCreatedAt: handoffs.createdAt,
    })
    .from(handoffs)
    .innerJoin(conversations, eq(conversations.id, handoffs.conversationId))
    .innerJoin(chatbots, eq(chatbots.id, conversations.chatbotId))
    .where(candidateWhere(now, filter))
    .orderBy(asc(handoffs.createdAt), asc(handoffs.id))
    .limit(limit);
}

/**
 * Handoff chờ tự trả lại cho bot (cũ trước). KHÔNG kiểm AI tổng (resumeAiOutageHandoffs kiểm trước). `manual` ⇒ bỏ
 * giới hạn chống lặp (nút "Bật lại AI").
 */
export function listAiOutageResumeCandidates(
  db: DbLike,
  now: Date,
  limit: number = AI_AUTO_RESUME_BATCH,
  options: { manual?: boolean } = {},
): Promise<AiOutageResumeCandidate[]> {
  return selectCandidates(db, now, limit, { manual: options.manual === true });
}

/**
 * Điều kiện "hội thoại đang Cần người vì AI lỗi" của nút "Bật lại AI" — cùng nghĩa banner vàng: handoff thỏa
 * aiOutageResumableSql + hội thoại pending_human. KHÔNG xét giới hạn chống lặp, tạm dừng AI hay handoff khác.
 */
function aiOutageWaitingWhere(now: Date) {
  return and(
    eq(conversations.status, 'pending_human'),
    aiOutageResumableSql('"handoffs"', sql`${now.toISOString()}::timestamptz`),
  );
}

/** Số hội thoại (mỗi hội thoại đếm một lần) đang "Cần người" vì AI lỗi mà còn trả lại cho bot được. */
export async function countAiOutageWaiting(db: DbLike, now: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${handoffs.conversationId})::int` })
    .from(handoffs)
    .innerJoin(conversations, eq(conversations.id, handoffs.conversationId))
    .where(aiOutageWaitingWhere(now));
  return row?.n ?? 0;
}

/**
 * Các model (không trùng) của bot đang gắn với những hội thoại countAiOutageWaiting đếm — để API gọi thử từng model
 * trước khi đẩy job. null ⇒ bot để trống model (bên gọi dùng model mặc định).
 */
export async function listAiOutageWaitingModels(db: DbLike, now: Date): Promise<(string | null)[]> {
  const rows = await db
    .selectDistinct({ model: chatbots.model })
    .from(handoffs)
    .innerJoin(conversations, eq(conversations.id, handoffs.conversationId))
    .innerJoin(chatbots, eq(chatbots.id, conversations.chatbotId))
    .where(aiOutageWaitingWhere(now));
  return [...new Set(rows.map((r) => r.model?.trim() || null))];
}

/**
 * Gọi thử AI một lần (prompt tí hon, tool no_reply, timeout ngắn, không thử lại). Không ném lỗi: model trả gì cũng
 * coi là AI hoạt động (kể cả không gọi tool) — chỉ lỗi gọi (LlmError…) mới là hỏng.
 */
export async function probeLlm(
  llm: LlmClient,
  model: string,
  timeoutMs: number = AI_AUTO_RESUME_PROBE_TIMEOUT_MS,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await llm.generate({
      model,
      systemInstruction: PROBE_SYSTEM_INSTRUCTION,
      contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
      tools: PROBE_TOOLS,
      temperature: 0,
      timeoutMs,
      thinking: 'minimal',
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

/**
 * Bỏ trigger_message_ids của các lượt AI lỗi vì AI ngừng hoạt động gây ra / xảy ra trong handoff (isLlmOutageErrorText
 * trên ai_runs.error): AI chưa hề trả lời các tin đó ⇒ để loadPendingMessages coi chúng là CHƯA xử lý và bot trả lời
 * khi được đánh thức. Trả id các lượt đã bỏ trigger.
 */
async function releaseOutageRunTriggers(
  tx: DbLike,
  conversationId: string,
  handoffCreatedAt: Date,
): Promise<string[]> {
  const since = new Date(handoffCreatedAt.getTime() - OUTAGE_RUN_BEFORE_HANDOFF_MIN * 60_000);
  const runs = await tx
    .select({ id: aiRuns.id, error: aiRuns.error })
    .from(aiRuns)
    .where(
      and(
        eq(aiRuns.conversationId, conversationId),
        eq(aiRuns.decision, 'error'),
        gte(aiRuns.createdAt, since),
        sql`cardinality(${aiRuns.triggerMessageIds}) > 0`,
      ),
    );
  const ids = runs.filter((r) => isLlmOutageErrorText(r.error)).map((r) => r.id);
  if (ids.length > 0) {
    await tx
      .update(aiRuns)
      .set({ triggerMessageIds: [] })
      .where(and(eq(aiRuns.conversationId, conversationId), inArray(aiRuns.id, ids)));
  }
  return ids;
}

/**
 * Khách còn chờ bot sau khi tự trả lại (chỉ đọc): hội thoại ai_mode 'auto', bot đang bật, không tạm dừng AI; còn tin
 * khách chưa xử lý (loadPendingMessages — sau khi releaseOutageRunTriggers trả tin lượt lỗi về "chưa xử lý"); và tin
 * cuối (bỏ system, echo tự động, VÀ tin bot của chính lượt AI lỗi — vd. handoffMessage "em chuyển nhân viên" gửi lúc
 * chuyển người) là của khách. Không dùng needsChatbotKick: tin chuyển người của lượt lỗi là tin cuối ⇒ tưởng khách hết
 * chờ, tin khách lượt lỗi không bao giờ được trả lời. Trả replyDelaySec của bot (null ⇒ không đánh thức).
 */
async function waitingReplyDelaySec(
  db: Db,
  conversationId: string,
  releasedRunIds: string[],
  now: Date,
): Promise<number | null> {
  const fromReleasedRun =
    releasedRunIds.length > 0
      ? sql`(m.sender_type = 'bot' and coalesce(m.ai_run_id in (${sql.join(
          releasedRunIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}), false))`
      : sql`false`;
  const [row] = await db
    .select({
      replyDelaySec: chatbots.replyDelaySec,
      aiPausedUntil: conversations.aiPausedUntil,
      lastSender: sql<string | null>`(
        select m.sender_type from ${messages} m
        where m.conversation_id = ${conversations.id} and m.sender_type <> 'system'
          and ${notAutomatedEcho(sql`m.raw`)} and not ${fromReleasedRun}
        order by m.sent_at desc, m.id desc
        limit 1
      )`,
    })
    .from(conversations)
    .innerJoin(chatbots, eq(chatbots.id, conversations.chatbotId))
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.aiMode, 'auto'),
        eq(chatbots.isActive, true),
      ),
    );
  if (!row || row.lastSender !== 'customer') return null;
  if (row.aiPausedUntil && row.aiPausedUntil > now) return null;
  if ((await loadPendingMessages(db, conversationId)).length === 0) return null;
  return row.replyDelaySec;
}

export type AiOutageResumeOutcome =
  { resumed: false } | { resumed: true; handoffIds: string[]; systemMessageId: string; kicked: boolean };

/**
 * Trả lại MỘT hội thoại cho bot. Transaction + khóa dòng hội thoại, kiểm lại mọi điều kiện (candidateWhere) — nhân
 * viên vừa nhận/nhắn/trả lại ⇒ { resumed: false }. Đạt ⇒ đóng các handoff mở (KHÔNG ghi người nhận), trạng thái như
 * nút "trả lại cho AI" (returnConversationToBot), bỏ trigger của lượt AI lỗi (releaseOutageRunTriggers), audit
 * 'handoff.auto_resume' { handoffId, handoffIds, aiMode, releasedRunIds } (user null), tin system
 * AI_AUTO_RESUME_SYSTEM_TEXT (raw.aiAutoResume). KHÔNG gửi tin "trả lại" của bot cho khách, KHÔNG báo Lark.
 * `manual` (nút "Bật lại AI") ⇒ kiểm lại KHÔNG xét giới hạn chống lặp; audit ghi thêm manual: true.
 * Sau commit: message.created + conversation.updated; khách đang chờ (waitingReplyDelaySec) và bot gửi được (cửa sổ
 * còn mở — botCanSend) ⇒ lên lịch job ai-reply sau replyDelaySec + `kickDelayMs` (giãn cách do job quét truyền vào).
 * Lỗi lên lịch chỉ log.
 */
export async function resumeAiOutageHandoff(
  db: Db,
  deps: AiRuntimeDeps,
  candidate: Pick<AiOutageResumeCandidate, 'handoffId' | 'conversationId'>,
  kickDelayMs = 0,
  options: { manual?: boolean } = {},
): Promise<AiOutageResumeOutcome> {
  const manual = options.manual === true;
  const now = deps.ctx.now();
  const done = await db.transaction(async (tx) => {
    const [conv] = await tx
      .select({
        id: conversations.id,
        chatbotId: conversations.chatbotId,
        channelAccountId: conversations.channelAccountId,
      })
      .from(conversations)
      .where(eq(conversations.id, candidate.conversationId))
      .for('update');
    if (!conv) return null;
    const [still] = await selectCandidates(tx, now, 1, { handoffId: candidate.handoffId, manual });
    if (!still || still.conversationId !== conv.id) return null;
    const handoffIds = await resolveOpenHandoffs(tx, conv.id, null, now);
    const aiMode = await returnConversationToBot(tx, conv, now);
    const releasedRunIds = await releaseOutageRunTriggers(tx, conv.id, still.handoffCreatedAt);
    await tx.insert(auditLogs).values({
      userId: null,
      action: 'handoff.auto_resume',
      entity: 'conversation',
      entityId: conv.id,
      data: {
        handoffId: candidate.handoffId,
        handoffIds,
        aiMode,
        releasedRunIds,
        ...(manual ? { manual: true } : {}),
      },
    });
    const [system] = await tx
      .insert(messages)
      .values({
        conversationId: conv.id,
        channelAccountId: conv.channelAccountId,
        senderType: 'system',
        text: AI_AUTO_RESUME_SYSTEM_TEXT,
        attachments: [],
        status: 'sent',
        raw: { aiAutoResume: { handoffIds } },
        sentAt: now,
      })
      .returning({ id: messages.id });
    await tx
      .update(conversations)
      .set({
        lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${now.toISOString()}::timestamptz)`,
      })
      .where(eq(conversations.id, conv.id));
    return { handoffIds, systemMessageId: system!.id, releasedRunIds };
  });
  if (!done) return { resumed: false };

  const conversationId = candidate.conversationId;
  await emitMessagesCreated(db, deps, [done.systemMessageId], conversationId);
  await emitConversationUpdated(db, deps, conversationId);
  let kicked = false;
  try {
    const replyDelaySec = await waitingReplyDelaySec(db, conversationId, done.releasedRunIds, now);
    if (replyDelaySec !== null) {
      const [info] = await db
        .select({
          id: conversations.id,
          channelType: channelAccounts.type,
          channelStatus: channelAccounts.status,
          lastCustomerMessageAt: conversations.lastCustomerMessageAt,
          windowSource: conversations.windowSource,
        })
        .from(conversations)
        .innerJoin(channelAccounts, eq(channelAccounts.id, conversations.channelAccountId))
        .where(eq(conversations.id, conversationId));
      if (info && (await botCanSend(db, info, deps.ctx)).allowed) {
        await deps.scheduler.scheduleReply(conversationId, replyDelaySec * 1000 + Math.max(0, kickDelayMs));
        kicked = true;
      }
    }
  } catch (error) {
    deps.logger.warn(
      { conversationId, err: errorText(error) },
      'Không đánh thức được bot sau khi tự trả lại hội thoại',
    );
  }
  deps.logger.info(
    { conversationId, handoffIds: done.handoffIds, kicked },
    'AI hoạt động lại: tự trả lại hội thoại cho bot',
  );
  return { resumed: true, handoffIds: done.handoffIds, systemMessageId: done.systemMessageId, kicked };
}

// ---------- Hội thoại "bị bỏ sót" (nút "Bật lại AI", mục 3 của hợp đồng AiOutageStatus) ----------

/** Tối đa số hội thoại bị bỏ sót xét trong một lần bấm (còn lại ⇒ log số bị bỏ, lần bấm sau xét tiếp). */
export const AI_MISSED_REPLY_MAX = 500;
/** Số hội thoại kiểm song song khi lọc (loadPendingMessages / botCanSend mỗi hội thoại một truy vấn). */
const MISSED_FILTER_CONCURRENCY = 10;

export interface AiMissedReplyCandidate {
  conversationId: string;
  /** Model của bot đang gắn (null ⇒ model mặc định). */
  model: string | null;
  replyDelaySec: number;
}

/**
 * Điều kiện SQL (lọc thô) của hội thoại "bị bỏ sót": bot đang gắn + bật, ai_mode 'auto', KHÔNG pending_human, không
 * tạm dừng AI; tin cuối (bỏ system và echo tự động của Page) là của khách, gửi trong AI_MISSED_REPLY_MAX_AGE_HOURS
 * giờ và cũ hơn AI_MISSED_REPLY_MIN_AGE_MIN phút (tránh lượt đang chờ debounce), chưa nằm trong trigger của lượt AI
 * nào. listAiMissedReplies kiểm thêm loadPendingMessages + botCanSend.
 */
function missedWhere(now: Date) {
  const nowIso = now.toISOString();
  return and(
    eq(conversations.aiMode, 'auto'),
    eq(chatbots.isActive, true),
    ne(conversations.status, 'pending_human'),
    sql`(${conversations.aiPausedUntil} is null or ${conversations.aiPausedUntil} <= ${nowIso}::timestamptz)`,
    sql`${conversations.lastCustomerMessageAt} > ${nowIso}::timestamptz - make_interval(hours => ${AI_MISSED_REPLY_MAX_AGE_HOURS})`,
    sql`exists (select 1 from (
        select m.id, m.sender_type, m.sent_at from ${messages} m
        where m.conversation_id = ${conversations.id} and m.sender_type <> 'system' and ${notAutomatedEcho(sql`m.raw`)}
        order by m.sent_at desc, m.id desc
        limit 1
      ) l
      where l.sender_type = 'customer'
        and l.sent_at > ${nowIso}::timestamptz - make_interval(hours => ${AI_MISSED_REPLY_MAX_AGE_HOURS})
        and l.sent_at <= ${nowIso}::timestamptz - make_interval(mins => ${AI_MISSED_REPLY_MIN_AGE_MIN})
        and not exists (select 1 from ${aiRuns} r
          where r.conversation_id = ${conversations.id} and l.id = any(r.trigger_message_ids)))`,
  );
}

/**
 * Hội thoại khách nhắn mà bot chưa trả lời (bỏ lỡ lúc AI lỗi / công tắc AI chung tắt), cũ trước (khung nhắn tin đóng
 * sớm hơn). Lọc thô bằng SQL (≤ limit dòng) rồi giữ hội thoại còn tin khách chưa xử lý (loadPendingMessages) và bot
 * còn gửi được (botCanSend — cửa sổ nhắn tin, kênh đang kết nối). `total` = số dòng lọc thô (kể cả phần vượt limit).
 */
export async function listAiMissedReplies(
  db: DbLike,
  ctx: InboxContext,
  now: Date,
  limit: number = AI_MISSED_REPLY_MAX,
): Promise<{ items: AiMissedReplyCandidate[]; total: number }> {
  const rows = await db
    .select({
      id: conversations.id,
      model: chatbots.model,
      replyDelaySec: chatbots.replyDelaySec,
      channelType: channelAccounts.type,
      channelStatus: channelAccounts.status,
      lastCustomerMessageAt: conversations.lastCustomerMessageAt,
      windowSource: conversations.windowSource,
    })
    .from(conversations)
    .innerJoin(chatbots, eq(chatbots.id, conversations.chatbotId))
    .innerJoin(channelAccounts, eq(channelAccounts.id, conversations.channelAccountId))
    .where(missedWhere(now))
    .orderBy(asc(conversations.lastCustomerMessageAt), asc(conversations.id))
    .limit(limit + 1);
  let total = rows.length;
  if (rows.length > limit) {
    rows.length = limit;
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(conversations)
      .innerJoin(chatbots, eq(chatbots.id, conversations.chatbotId))
      .where(missedWhere(now));
    total = row?.n ?? total;
  }
  const items: AiMissedReplyCandidate[] = [];
  for (let i = 0; i < rows.length; i += MISSED_FILTER_CONCURRENCY) {
    const chunk = rows.slice(i, i + MISSED_FILTER_CONCURRENCY);
    const keep = await Promise.all(
      chunk.map(
        async (r) =>
          (await loadPendingMessages(db, r.id)).length > 0 && (await botCanSend(db, r, ctx)).allowed,
      ),
    );
    chunk.forEach((r, k) => {
      if (keep[k]) {
        items.push({ conversationId: r.id, model: r.model?.trim() || null, replyDelaySec: r.replyDelaySec });
      }
    });
  }
  return { items, total };
}

/** Số hội thoại bị bỏ sót (cùng điều kiện listAiMissedReplies, tối đa AI_MISSED_REPLY_MAX). */
export async function countAiMissedReplies(db: DbLike, ctx: InboxContext, now: Date): Promise<number> {
  return (await listAiMissedReplies(db, ctx, now)).items.length;
}

// ---------- Job "ai-auto-resume" (định kỳ + nút "Bật lại AI") ----------

export interface AiOutageResumeOptions {
  limit?: number;
  spacingMs?: number;
  probeTimeoutMs?: number;
  /**
   * Nút "Bật lại AI" (API đẩy job với data.manual): bỏ giới hạn chống lặp, xử lý MỌI ứng viên (≤ AI_MANUAL_RESUME_MAX,
   * một truy vấn), rồi đánh thức bot cho hội thoại "bị bỏ sót" (listAiMissedReplies); chờ khóa thay vì bỏ lượt; ghi
   * audit AI_MANUAL_RESUME_AUDIT_ACTION.
   */
  manual?: boolean;
  /** Người bấm (audit.userId). */
  actorUserId?: string | null;
  /** Chỉ manual: thời gian chờ khóa tối đa / chu kỳ thử lại (mặc định AI_MANUAL_RESUME_LOCK_*). */
  lockWaitMs?: number;
  lockPollMs?: number;
  /** Chỉ manual: tối đa hội thoại bị bỏ sót (mặc định AI_MISSED_REPLY_MAX). */
  missedLimit?: number;
}

export interface AiOutageResumeResult {
  /** true = lượt khác đang chạy (khóa Redis) ⇒ không làm gì (chỉ lượt định kỳ — lượt bấm tay không bỏ). */
  locked?: true;
  candidates: number;
  /** Model đã gọi thử thành công / thất bại. */
  probedOk: string[];
  probeFailed: string[];
  resumed: number;
  /** Ứng viên bị loại khi kiểm lại dưới khóa (nhân viên vừa can thiệp). */
  skipped: number;
  kicked: number;
  /** Chỉ manual: số hội thoại bị bỏ sót tìm thấy / đã đánh thức bot / bị bỏ vì vượt AI_MISSED_REPLY_MAX. */
  missed?: number;
  missedKicked?: number;
  missedDropped?: number;
}

type ProbeResult = Awaited<ReturnType<typeof probeLlm>>;

/** SET NX PX; waitMs > 0 ⇒ thử lại mỗi pollMs tới waitMs. true = đã giữ khóa. */
async function acquireResumeLock(
  deps: AiRuntimeDeps,
  token: string,
  waitMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const acquired = await deps.redis.set(
      AI_AUTO_RESUME_LOCK_KEY,
      token,
      'PX',
      AI_AUTO_RESUME_LOCK_TTL_MS,
      'NX',
    );
    if (acquired === 'OK') return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(1, pollMs), left)));
  }
}

/**
 * Job "ai-auto-resume".
 * Định kỳ (AI_AUTO_RESUME_EVERY_MS): khóa Redis (SET NX PX — một lượt trên mọi worker; đang khóa ⇒ { locked }) ⇒ AI
 * tổng tắt ⇒ không làm gì; listAiOutageResumeCandidates (≤ limit) rỗng ⇒ không gọi AI. Có ⇒ gọi thử AI MỘT lần mỗi
 * model (bot.model ?? defaultModel): hỏng ⇒ bỏ các hội thoại của model đó (lượt sau thử lại; log một dòng mỗi lượt);
 * được ⇒ resumeAiOutageHandoff từng hội thoại liền nhau (KHÔNG ngủ trong job — không giữ khe hàng đợi ai-reply); bot
 * được đánh thức thứ i chạy trễ thêm i × spacingMs. Lỗi DB của một hội thoại chỉ log (hội thoại khác vẫn chạy).
 * Idempotent: chạy lại không còn ứng viên.
 * Bấm tay (`manual` — nút "Bật lại AI"): như trên nhưng bỏ giới hạn chống lặp, lấy tối đa AI_MANUAL_RESUME_MAX ứng
 * viên; sau đó hội thoại "bị bỏ sót" (listAiMissedReplies, ≤ missedLimit; phần vượt chỉ log) ⇒ lên lịch bot trả lời
 * (replyDelaySec + tiếp tục giãn cách i × spacingMs), cũng chỉ khi model của bot gọi thử được (mỗi model gọi thử
 * một lần cho cả lượt). Khóa đang bị giữ ⇒ chờ (AI_MANUAL_RESUME_LOCK_WAIT_MS) rồi chạy luôn không giữ khóa — xem
 * AI_MANUAL_RESUME_LOCK_WAIT_MS. Xong ⇒ một dòng audit AI_MANUAL_RESUME_AUDIT_ACTION (userId = actorUserId).
 */
export async function resumeAiOutageHandoffs(
  db: Db,
  deps: AiRuntimeDeps,
  options: AiOutageResumeOptions = {},
): Promise<AiOutageResumeResult> {
  const manual = options.manual === true;
  const result: AiOutageResumeResult = {
    candidates: 0,
    probedOk: [],
    probeFailed: [],
    resumed: 0,
    skipped: 0,
    kicked: 0,
    ...(manual ? { missed: 0, missedKicked: 0, missedDropped: 0 } : {}),
  };
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const holdsLock = await acquireResumeLock(
    deps,
    token,
    manual ? (options.lockWaitMs ?? AI_MANUAL_RESUME_LOCK_WAIT_MS) : 0,
    options.lockPollMs ?? AI_MANUAL_RESUME_LOCK_POLL_MS,
  );
  if (!holdsLock) {
    if (!manual) return { ...result, locked: true };
    deps.logger.warn(
      { lockKey: AI_AUTO_RESUME_LOCK_KEY },
      'Bật lại AI: lượt khác vẫn giữ khóa sau thời gian chờ — chạy luôn (mỗi hội thoại vẫn kiểm lại dưới khóa dòng)',
    );
  }
  try {
    await runResume(db, deps, options, manual, result);
    if (manual) await writeManualResumeAudit(db, deps, options.actorUserId ?? null, result, holdsLock);
    return result;
  } finally {
    if (holdsLock) {
      try {
        if ((await deps.redis.get(AI_AUTO_RESUME_LOCK_KEY)) === token)
          await deps.redis.del(AI_AUTO_RESUME_LOCK_KEY);
      } catch (error) {
        deps.logger.warn({ err: errorText(error) }, 'Không gỡ được khóa tự trả lại hội thoại');
      }
    }
  }
}

async function runResume(
  db: Db,
  deps: AiRuntimeDeps,
  options: AiOutageResumeOptions,
  manual: boolean,
  result: AiOutageResumeResult,
): Promise<void> {
  if (!(await getAiSettings(db)).enabled) return;
  const now = deps.ctx.now();
  const limit = options.limit ?? (manual ? AI_MANUAL_RESUME_MAX : AI_AUTO_RESUME_BATCH);
  const candidates = await listAiOutageResumeCandidates(db, now, limit, { manual });
  result.candidates = candidates.length;

  // Gọi thử mỗi model MỘT lần cho cả lượt (dùng chung cho phần handoff và phần bị bỏ sót).
  const probes = new Map<string, ProbeResult>();
  const probeErrors: string[] = [];
  const probe = async (model: string): Promise<boolean> => {
    let out = probes.get(model);
    if (!out) {
      out = await probeLlm(deps.llm, model, options.probeTimeoutMs);
      probes.set(model, out);
      if (out.ok) result.probedOk.push(model);
      else {
        result.probeFailed.push(model);
        probeErrors.push(out.error);
      }
    }
    return out.ok;
  };
  const modelOf = (m: string | null) => m?.trim() || deps.config.defaultModel;
  const spacingMs = Math.max(0, options.spacingMs ?? AI_AUTO_RESUME_SPACING_MS);
  /** Số bot đã đánh thức trong lượt (cả hai phần) × giãn cách. */
  const offsetMs = () => (result.kicked + (result.missedKicked ?? 0)) * spacingMs;

  if (candidates.length > 0) {
    const byModel = new Map<string, AiOutageResumeCandidate[]>();
    for (const c of candidates) {
      const model = modelOf(c.model);
      byModel.set(model, [...(byModel.get(model) ?? []), c]);
    }
    for (const [model, list] of byModel) {
      if (!(await probe(model))) continue;
      for (const c of list) {
        try {
          const out = await resumeAiOutageHandoff(db, deps, c, offsetMs(), { manual });
          if (out.resumed) {
            result.resumed += 1;
            if (out.kicked) result.kicked += 1;
          } else {
            result.skipped += 1;
          }
        } catch (error) {
          result.skipped += 1;
          deps.logger.warn(
            { conversationId: c.conversationId, err: errorText(error) },
            'Không tự trả lại được hội thoại cho bot',
          );
        }
      }
    }
  }

  if (manual) await kickMissedReplies(db, deps, options, result, probe, modelOf, offsetMs);

  if (result.probeFailed.length > 0) {
    deps.logger.warn(
      {
        models: result.probeFailed,
        waiting: result.candidates - result.resumed,
        manual,
        err: probeErrors[0],
      },
      'AI vẫn lỗi — chưa tự trả lại hội thoại cho bot (thử lại lượt sau)',
    );
  }
}

/**
 * Phần "bị bỏ sót" của lượt bấm tay: lên lịch bot trả lời (độ trễ replyDelaySec + giãn cách tiếp nối phần handoff).
 * Lỗi lên lịch của từng hội thoại chỉ log.
 */
async function kickMissedReplies(
  db: Db,
  deps: AiRuntimeDeps,
  options: AiOutageResumeOptions,
  result: AiOutageResumeResult,
  probe: (model: string) => Promise<boolean>,
  modelOf: (m: string | null) => string,
  offsetMs: () => number,
): Promise<void> {
  const limit = options.missedLimit ?? AI_MISSED_REPLY_MAX;
  const { items, total } = await listAiMissedReplies(db, deps.ctx, deps.ctx.now(), limit);
  result.missed = items.length;
  result.missedKicked = 0;
  result.missedDropped = Math.max(0, total - limit);
  if (result.missedDropped > 0) {
    deps.logger.warn(
      { limit, total, dropped: result.missedDropped },
      'Bật lại AI: quá nhiều hội thoại bị bỏ sót — phần vượt giới hạn chưa được đánh thức (bấm lại để xử lý tiếp)',
    );
  }
  for (const m of items) {
    if (!(await probe(modelOf(m.model)))) continue;
    try {
      await deps.scheduler.scheduleReply(m.conversationId, m.replyDelaySec * 1000 + offsetMs());
      result.missedKicked += 1;
    } catch (error) {
      deps.logger.warn(
        { conversationId: m.conversationId, err: errorText(error) },
        'Bật lại AI: không đánh thức được bot cho hội thoại bị bỏ sót',
      );
    }
  }
}

/** Một dòng audit cho lần bấm "Bật lại AI". Lỗi chỉ log (việc đã làm xong). */
async function writeManualResumeAudit(
  db: Db,
  deps: AiRuntimeDeps,
  actorUserId: string | null,
  result: AiOutageResumeResult,
  lockHeld: boolean,
): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      userId: actorUserId,
      action: AI_MANUAL_RESUME_AUDIT_ACTION,
      entity: 'ai',
      entityId: null,
      data: {
        resumed: result.resumed,
        kicked: result.kicked,
        probeFailed: result.probeFailed,
        candidates: result.candidates,
        skipped: result.skipped,
        missed: result.missed ?? 0,
        missedKicked: result.missedKicked ?? 0,
        missedDropped: result.missedDropped ?? 0,
        lockHeld,
      },
    });
  } catch (error) {
    deps.logger.warn({ err: errorText(error) }, 'Bật lại AI: không ghi được audit');
  }
}
