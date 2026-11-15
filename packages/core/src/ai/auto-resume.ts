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
import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { resolveOpenHandoffs } from '../inbox/commands';
import type { DbLike } from '../inbox/read-model';
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
 * AI_AUTO_RESUME_MAX_PER_DAY lần trong 24 giờ.
 */
function candidateWhere(now: Date, handoffId?: string) {
  const nowIso = now.toISOString();
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
    sql`not exists (select 1 from ${handoffs} p
      where p.conversation_id = ${handoffs.conversationId} and ${autoResumedHandoffSql('p')}
        and p.resolved_at > ${nowIso}::timestamptz - make_interval(mins => ${AI_AUTO_RESUME_COOLDOWN_MIN}))`,
    sql`(select count(*) from ${handoffs} p
      where p.conversation_id = ${handoffs.conversationId} and ${autoResumedHandoffSql('p')}
        and p.resolved_at > ${nowIso}::timestamptz - interval '24 hours') < ${AI_AUTO_RESUME_MAX_PER_DAY}`,
  );
}

function selectCandidates(db: DbLike, now: Date, limit: number, handoffId?: string) {
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
    .where(candidateWhere(now, handoffId))
    .orderBy(asc(handoffs.createdAt), asc(handoffs.id))
    .limit(limit);
}

/** Handoff chờ tự trả lại cho bot (cũ trước). KHÔNG kiểm AI tổng (resumeAiOutageHandoffs kiểm trước). */
export function listAiOutageResumeCandidates(
  db: DbLike,
  now: Date,
  limit: number = AI_AUTO_RESUME_BATCH,
): Promise<AiOutageResumeCandidate[]> {
  return selectCandidates(db, now, limit);
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
 * Sau commit: message.created + conversation.updated; khách đang chờ (waitingReplyDelaySec) và bot gửi được (cửa sổ
 * còn mở — botCanSend) ⇒ lên lịch job ai-reply sau replyDelaySec + `kickDelayMs` (giãn cách do job quét truyền vào).
 * Lỗi lên lịch chỉ log.
 */
export async function resumeAiOutageHandoff(
  db: Db,
  deps: AiRuntimeDeps,
  candidate: Pick<AiOutageResumeCandidate, 'handoffId' | 'conversationId'>,
  kickDelayMs = 0,
): Promise<AiOutageResumeOutcome> {
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
    const [still] = await selectCandidates(tx, now, 1, candidate.handoffId);
    if (!still || still.conversationId !== conv.id) return null;
    const handoffIds = await resolveOpenHandoffs(tx, conv.id, null, now);
    const aiMode = await returnConversationToBot(tx, conv, now);
    const releasedRunIds = await releaseOutageRunTriggers(tx, conv.id, still.handoffCreatedAt);
    await tx.insert(auditLogs).values({
      userId: null,
      action: 'handoff.auto_resume',
      entity: 'conversation',
      entityId: conv.id,
      data: { handoffId: candidate.handoffId, handoffIds, aiMode, releasedRunIds },
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

export interface AiOutageResumeOptions {
  limit?: number;
  spacingMs?: number;
  probeTimeoutMs?: number;
}

export interface AiOutageResumeResult {
  /** true = lượt khác đang chạy (khóa Redis) ⇒ không làm gì. */
  locked?: true;
  candidates: number;
  /** Model đã gọi thử thành công / thất bại. */
  probedOk: string[];
  probeFailed: string[];
  resumed: number;
  /** Ứng viên bị loại khi kiểm lại dưới khóa (nhân viên vừa can thiệp). */
  skipped: number;
  kicked: number;
}

/**
 * Job định kỳ "ai-auto-resume" (AI_AUTO_RESUME_EVERY_MS): khóa Redis (SET NX PX — một lượt trên mọi worker) ⇒ AI
 * tổng tắt ⇒ không làm gì; listAiOutageResumeCandidates (≤ limit) rỗng ⇒ không gọi AI. Có ⇒ gọi thử AI MỘT lần mỗi
 * model (bot.model ?? defaultModel): hỏng ⇒ bỏ các hội thoại của model đó (lượt sau thử lại; log một dòng mỗi lượt);
 * được ⇒ resumeAiOutageHandoff từng hội thoại liền nhau (KHÔNG ngủ trong job — không giữ khe hàng đợi ai-reply); bot
 * được đánh thức thứ i chạy trễ thêm i × spacingMs. Lỗi DB của một hội thoại chỉ log (hội thoại khác vẫn chạy).
 * Idempotent: chạy lại không còn ứng viên.
 */
export async function resumeAiOutageHandoffs(
  db: Db,
  deps: AiRuntimeDeps,
  options: AiOutageResumeOptions = {},
): Promise<AiOutageResumeResult> {
  const result: AiOutageResumeResult = {
    candidates: 0,
    probedOk: [],
    probeFailed: [],
    resumed: 0,
    skipped: 0,
    kicked: 0,
  };
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const acquired = await deps.redis.set(
    AI_AUTO_RESUME_LOCK_KEY,
    token,
    'PX',
    AI_AUTO_RESUME_LOCK_TTL_MS,
    'NX',
  );
  if (acquired !== 'OK') return { ...result, locked: true };
  try {
    if (!(await getAiSettings(db)).enabled) return result;
    const now = deps.ctx.now();
    const candidates = await listAiOutageResumeCandidates(db, now, options.limit ?? AI_AUTO_RESUME_BATCH);
    result.candidates = candidates.length;
    if (candidates.length === 0) return result;

    const byModel = new Map<string, AiOutageResumeCandidate[]>();
    for (const c of candidates) {
      const model = c.model?.trim() || deps.config.defaultModel;
      byModel.set(model, [...(byModel.get(model) ?? []), c]);
    }
    const spacingMs = Math.max(0, options.spacingMs ?? AI_AUTO_RESUME_SPACING_MS);
    const probeErrors: string[] = [];
    for (const [model, list] of byModel) {
      const probe = await probeLlm(deps.llm, model, options.probeTimeoutMs);
      if (!probe.ok) {
        result.probeFailed.push(model);
        probeErrors.push(probe.error);
        continue;
      }
      result.probedOk.push(model);
      for (const c of list) {
        try {
          const out = await resumeAiOutageHandoff(db, deps, c, result.kicked * spacingMs);
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
    if (result.probeFailed.length > 0) {
      deps.logger.warn(
        { models: result.probeFailed, waiting: result.candidates - result.resumed, err: probeErrors[0] },
        'AI vẫn lỗi — chưa tự trả lại hội thoại cho bot (thử lại lượt sau)',
      );
    }
    return result;
  } finally {
    try {
      if ((await deps.redis.get(AI_AUTO_RESUME_LOCK_KEY)) === token)
        await deps.redis.del(AI_AUTO_RESUME_LOCK_KEY);
    } catch (error) {
      deps.logger.warn({ err: errorText(error) }, 'Không gỡ được khóa tự trả lại hội thoại');
    }
  }
}
