// Chạy chatbot trong hệ thống thật: debounce (6.2), điều kiện (6.3), chống đua (6.4), gửi, escalate.
// Core không phụ thuộc bullmq/ioredis: worker truyền adapter (DebounceRedis, AiJobScheduler).
import {
  aiRuns,
  appSettings,
  channelAccounts,
  chatbots,
  contactIdentities,
  conversations,
  handoffs,
  messages,
  type Db,
} from '@dezon/db';
import {
  aiSettingsSchema,
  DEFAULT_AI_SETTINGS,
  HANDOFF_REASON_CODES,
  type HandoffReasonCode,
} from '@dezon/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { ChannelType } from '@dezon/shared';
import type { CredentialsCipher } from '../channels/service';
import type { ChannelConnector } from '../connectors/types';
import type { HandoffReminderJobData } from '../jobs';
import type { DbLike } from '../inbox/read-model';
import type { InboxContext } from '../inbox/types';
import type { MediaStorage } from '../media/types';
import type { PipelineLogger } from '../pipeline/types';
import type { RealtimePublisher } from '../realtime';
import { toChatbotConfig } from './config';
import {
  botCanSend,
  bubbleDelays,
  emitMessagesCreated,
  errorText,
  insertBotMessages,
  requeueQueuedBotMessages,
} from './delivery';
import { escalateConversation } from './escalate';
import type { LlmClient } from './llm';
import { HANDOFF_CLAIM_GUARD, runChatbotTurn } from './orchestrator';
import { CHATBOT_MAX_BUBBLES } from './tools';
import { getAiSettings, getBusinessHours, SETTING_KEYS, type LarkFallback } from './settings';
import {
  releaseEarlyAiTyping,
  startAiTyping,
  startEarlyAiTyping,
  type AiTypingDeps,
  type AiTypingRedis,
  type AiTypingTarget,
} from './typing';
import {
  hasAgentMessageAfter,
  loadPendingMessages,
  loadPromptImages,
  loadTurnHistory,
  type PendingMessage,
} from './turn-input';
import type { ChatbotTurnResult } from './types';

export { BOT_REQUEUE_MAX_AGE_SEC, requeueQueuedBotMessages } from './delivery';
export {
  escalateConversation,
  HANDOFF_SYSTEM_PREFIX,
  processHandoffReminderJob,
  type EscalateInput,
  type EscalateResult,
} from './escalate';

// ---------- Debounce ----------

/** Tập con ioredis dùng cho debounce. */
export interface DebounceRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
}

/** Adapter hàng đợi `ai-reply` do worker/api cài bằng BullMQ. */
export interface AiJobScheduler {
  /**
   * Lên lịch job AI_REPLY_JOB_NAME (data AiReplyJobData, delay = delayMs) theo kiểu "xóa rồi thêm lại" với
   * hai chỗ: jobId aiReplyJobId(conv) = `ai-<conv>` và `ai-<conv>-next`. Job chính đang active ⇒ đặt lịch
   * chỗ `-next` thay vì bỏ qua. Hai job cùng hội thoại có thể chạy chồng nhau: processAiReplyJob an toàn
   * nhờ khóa dòng hội thoại + chống đua (job thấy tin đã được lần chạy khác xử lý thì tự hủy), và job không
   * còn tin khách chưa xử lý thì 'skipped' im lặng (không ghi ai_runs). Cả hai khe đang chạy ⇒ đặt cờ
   * aiDirtyKey(conv) (TTL AI_DIRTY_TTL_SEC) để job kết thúc lên lịch lại.
   */
  scheduleReply(conversationId: string, delayMs: number): Promise<void>;
  /** Lên lịch job HANDOFF_REMINDER_JOB_NAME, jobId = handoffReminderJobId(handoffId). */
  scheduleHandoffReminder(data: HandoffReminderJobData, delayMs: number): Promise<void>;
  /** Thêm job outbound (OUTBOUND_JOB_NAME, jobId outboundJobId) cho tin bot với delay (giãn bong bóng). */
  enqueueOutbound(messageId: string, delayMs: number): Promise<void>;
}

/**
 * Cờ Redis "có tin khách chưa được lên lịch": scheduler đặt (TTL AI_DIRTY_TTL_SEC) khi cả hai khe job của
 * hội thoại đang chạy; processAiReplyJob kiểm-và-xóa khi kết thúc rồi lên lịch lại.
 */
export const aiDirtyKey = (conversationId: string): string => `ai-dirty:${conversationId}`;
export const AI_DIRTY_TTL_SEC = 10 * 60;

/** Khóa Redis debounce theo spec 6.2. */
export const debounceKeys = (conversationId: string) => ({
  first: `debounce:${conversationId}:first`,
  last: `debounce:${conversationId}:last`,
});

export interface DebounceSettings {
  replyDelaySec: number;
  maxWaitSec: number;
}

/**
 * Gặp tin khách mới: SET first NX (epoch ms, PX = (maxWaitSec + 120) × 1000), SET last = now (cùng TTL).
 * delayMs = min(replyDelaySec × 1000, max(0, first + maxWaitSec × 1000 − now)) ⇒ scheduler.scheduleReply.
 * Trả delay đã dùng.
 */
export async function scheduleChatbotReply(
  redis: DebounceRedis,
  scheduler: AiJobScheduler,
  conversationId: string,
  chatbot: DebounceSettings,
  now: Date = new Date(),
): Promise<{ delayMs: number }> {
  const keys = debounceKeys(conversationId);
  const nowMs = now.getTime();
  const ttlMs = (chatbot.maxWaitSec + 120) * 1000;
  await redis.set(keys.first, String(nowMs), 'PX', ttlMs, 'NX');
  await redis.set(keys.last, String(nowMs), 'PX', ttlMs);
  const firstRaw = Number(await redis.get(keys.first));
  const first = Number.isFinite(firstRaw) && firstRaw > 0 ? firstRaw : nowMs;
  const delayMs = Math.min(
    chatbot.replyDelaySec * 1000,
    Math.max(0, first + chatbot.maxWaitSec * 1000 - nowMs),
  );
  await scheduler.scheduleReply(conversationId, delayMs);
  return { delayMs };
}

/** Phụ thuộc của chỉ báo "đang soạn tin" sớm (AiRuntimeDeps thỏa). */
export type EarlyTypingDeps = AiTypingDeps & { redis: AiTypingRedis; ctx: InboxContext };

/**
 * Gọi từ pipeline (qua PipelineDeps.onCustomerMessageStored) sau khi LƯU tin KHÁCH với source 'webhook' |
 * 'sync-incremental' (KHÔNG 'sync-backfill'): đọc conversation + chatbot; nếu chatbot_id có, ai_mode 'auto',
 * bot is_active ⇒ scheduleChatbotReply(bot.replyDelaySec, bot.maxWaitSec). Trả true nếu đã lên lịch.
 * Không kiểm AI tổng/pause ở đây (job kiểm lại).
 * `typing` có ⇒ sau khi lên lịch, bật chỉ báo "đang soạn tin" sớm (fire-and-forget, KHÔNG chờ: không làm chậm
 * pipeline tin đến) nếu bot được chạy và có quyền gửi — khách thấy dấu ba chấm ngay, không phải đợi hết độ trễ
 * gom tin. Job tắt chỉ báo ở mọi đường ra.
 */
export async function maybeScheduleChatbotReply(
  db: Db,
  redis: DebounceRedis,
  scheduler: AiJobScheduler,
  conversationId: string,
  now: Date = new Date(),
  typing?: EarlyTypingDeps,
): Promise<boolean> {
  const [row] = await db
    .select({ replyDelaySec: chatbots.replyDelaySec, maxWaitSec: chatbots.maxWaitSec })
    .from(conversations)
    .innerJoin(chatbots, eq(chatbots.id, conversations.chatbotId))
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.aiMode, 'auto'),
        eq(chatbots.isActive, true),
      ),
    );
  if (!row) return false;
  await scheduleChatbotReply(redis, scheduler, conversationId, row, now);
  if (typing) {
    void startEarlyTyping(db, typing, conversationId, (row.maxWaitSec + 120) * 1000).catch((error: unknown) =>
      typing.logger.debug(
        { conversationId, err: errorText(error) },
        'Không bật được chỉ báo đang soạn tin (sớm)',
      ),
    );
  }
  return true;
}

/**
 * Chỉ báo sớm: chỉ khi job gần như chắc chắn sẽ chạy (AI tổng bật, bot bật, không chờ người, không tạm dừng) và
 * có quyền gửi (Messenger chặn sender_action ngoài cửa sổ 24 h, kênh mất kết nối). Giới hạn lượt/giờ không kiểm
 * ở đây (job 'skipped' tự tắt chỉ báo sớm).
 */
async function startEarlyTyping(
  db: Db,
  deps: EarlyTypingDeps,
  conversationId: string,
  ttlMs: number,
): Promise<void> {
  const [ai, conv] = await Promise.all([getAiSettings(db), loadJobConversation(db, conversationId)]);
  const bot = conv?.bot;
  if (!ai.enabled || !conv || !bot || conv.aiMode !== 'auto' || !bot.isActive) return;
  if (conv.status === 'pending_human') return;
  if (conv.aiPausedUntil && conv.aiPausedUntil > deps.ctx.now()) return;
  if (!(await botCanSend(db, conv, deps.ctx)).allowed) return;
  await startEarlyAiTyping(db, deps, typingTarget(conv), ttlMs);
}

// ---------- Job AI ----------

export interface AiRuntimeConfig {
  /** GEMINI_MODEL */
  defaultModel: string;
  /** AI_MIN_CONFIDENCE */
  minConfidence: number;
  /** APP_URL (link "Mở hội thoại" trên thẻ Lark). */
  appUrl: string;
  /** HANDOFF_ESCALATE_AFTER_MIN */
  handoffReminderMin: number;
}

export interface AiRuntimeDeps {
  llm: LlmClient;
  publisher: RealtimePublisher;
  /** now, signUrl, policy (canSend by 'bot'). */
  ctx: InboxContext;
  /** Tải ảnh khách (attachments.storageKey) làm inline data cho Gemini. */
  storage: MediaStorage;
  /** Giải mã secret Lark. */
  cipher: CredentialsCipher;
  scheduler: AiJobScheduler;
  redis: DebounceRedis;
  logger: PipelineLogger;
  config: AiRuntimeConfig;
  /** Lark mặc định từ env (LARK_WEBHOOK_URL / LARK_WEBHOOK_SECRET) khi app_settings.lark chưa có. */
  larkFallback?: LarkFallback | null;
  fetch?: typeof fetch;
  /** Ngẫu nhiên [0,1) cho giãn bong bóng (test cố định). */
  random?: () => number;
  /**
   * Connector theo kênh để gửi chỉ báo "đang soạn tin" (ChannelConnector.sendSenderAction). Thiếu, hoặc kênh
   * không có sendSenderAction ⇒ bỏ qua bước typing trên nền tảng (realtime 'ai.typing' trong hộp thư VẪN phát).
   * Worker truyền đúng object connectors của pipeline (cùng createConnectors).
   */
  connectors?: Partial<Record<ChannelType, ChannelConnector>>;
}

export type AiReplyOutcome =
  | { status: 'skipped'; reason: string; aiRunId: string | null }
  | { status: 'cancelled'; reason: string; aiRunId: string | null }
  | { status: 'done'; decision: 'reply' | 'escalate' | 'no_reply' | 'error'; aiRunId: string };

/** Lý do skip không ghi ai_runs. */
export const AI_SKIP_DISABLED = 'ai_disabled';
export const AI_SKIP_NO_NEW_MESSAGES = 'no_new_messages';
export const AI_SKIP_NOT_FOUND = 'not_found';

async function loadJobConversation(db: Db, conversationId: string) {
  const [row] = await db
    .select({
      id: conversations.id,
      channelAccountId: conversations.channelAccountId,
      assignedUserId: conversations.assignedUserId,
      status: conversations.status,
      aiMode: conversations.aiMode,
      aiPausedUntil: conversations.aiPausedUntil,
      lastCustomerMessageAt: conversations.lastCustomerMessageAt,
      windowSource: conversations.windowSource,
      channelType: channelAccounts.type,
      channelStatus: channelAccounts.status,
      channelName: channelAccounts.displayName,
      /** PSID của khách — người nhận chỉ báo "đang soạn tin". */
      externalUserId: contactIdentities.externalUserId,
      bot: chatbots,
    })
    .from(conversations)
    .innerJoin(channelAccounts, eq(channelAccounts.id, conversations.channelAccountId))
    .leftJoin(contactIdentities, eq(contactIdentities.id, conversations.contactIdentityId))
    .leftJoin(chatbots, eq(chatbots.id, conversations.chatbotId))
    .where(eq(conversations.id, conversationId));
  return row;
}

type JobConversation = NonNullable<Awaited<ReturnType<typeof loadJobConversation>>>;

function typingTarget(conv: JobConversation): AiTypingTarget {
  return {
    conversationId: conv.id,
    assignedUserId: conv.assignedUserId,
    channelType: conv.channelType,
    channelAccountId: conv.channelAccountId,
    externalUserId: conv.externalUserId ?? null,
    chatbotName: conv.bot?.name ?? null,
  };
}

interface RunRecord {
  conversationId: string;
  chatbotId: string | null;
  triggerMessageIds: string[];
  model: string;
  decision: 'reply' | 'escalate' | 'no_reply' | 'error';
  error?: string | null;
  result?: ChatbotTurnResult;
}

async function insertRun(db: DbLike, r: RunRecord): Promise<string> {
  const [row] = await db
    .insert(aiRuns)
    .values({
      conversationId: r.conversationId,
      chatbotId: r.chatbotId,
      triggerMessageIds: r.triggerMessageIds,
      model: r.result?.model || r.model,
      inputTokens: r.result?.usage.inputTokens ?? 0,
      outputTokens: r.result?.usage.outputTokens ?? 0,
      latencyMs: Math.max(0, Math.round(r.result?.latencyMs ?? 0)),
      decision: r.decision,
      toolCalls: r.result?.toolCalls ?? [],
      reasoningSummary: r.result?.summary ?? r.result?.reason ?? null,
      error: r.error ?? null,
    })
    .returning({ id: aiRuns.id });
  return row!.id;
}

/** Điều kiện 6.3 (trừ AI tổng và "có tin mới"). Trả lý do tiếng Việt nếu không được chạy. */
async function blockedReason(db: Db, deps: AiRuntimeDeps, conv: JobConversation): Promise<string | null> {
  const bot = conv.bot;
  if (!bot || conv.aiMode !== 'auto') return 'Hội thoại không bật chatbot';
  if (!bot.isActive) return 'Chatbot đang tắt';
  if (conv.status === 'pending_human') return 'Hội thoại đang chờ người thật xử lý';
  if (conv.aiPausedUntil && conv.aiPausedUntil > deps.ctx.now()) {
    return 'AI đang tạm dừng vì nhân viên vừa nhắn';
  }
  // "Nhân viên đã trả lời sau tin khách" không cần kiểm ở đây: tin chưa xử lý luôn tạo sau tin nhân viên cuối.
  // Hai lần đọc độc lập ⇒ song song (đường trễ trước LLM); thứ tự ưu tiên lý do giữ nguyên.
  const [send, replies] = await Promise.all([
    botCanSend(db, conv, deps.ctx),
    countRepliesLastHour(db, conv.id),
  ]);
  if (!send.allowed) return `Không được gửi: ${send.reason ?? 'ngoài cửa sổ gửi'}`;
  if (replies >= bot.maxRepliesPerHour) return capReason(bot.maxRepliesPerHour);
  return null;
}

const capReason = (n: number) => `Đã đạt giới hạn ${n} lượt trả lời/giờ`;

async function countRepliesLastHour(db: DbLike, conversationId: string): Promise<number> {
  const [cap] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(aiRuns)
    .where(
      and(
        eq(aiRuns.conversationId, conversationId),
        eq(aiRuns.decision, 'reply'),
        sql`${aiRuns.createdAt} > now() - interval '1 hour'`,
      ),
    );
  return cap?.n ?? 0;
}

interface KillSwitch {
  reason: string;
  /** true ⇒ coi các tin là đã xử lý (ghi trigger); AI tổng tắt thì không (giống lúc bắt đầu job). */
  consume: boolean;
}

/**
 * Công tắc kiểm lại NGAY TRƯỚC KHI ghi (trong transaction đã khóa dòng hội thoại): AI tổng, bot còn bật,
 * giới hạn trả lời/giờ (đếm lại dưới khóa — hai job song song không cùng vượt giới hạn).
 */
async function killSwitchReason(
  tx: DbLike,
  conversationId: string,
  botId: string,
  decision: ChatbotTurnResult['decision'],
): Promise<KillSwitch | null> {
  const [setting] = await tx
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, SETTING_KEYS.ai))
    .limit(1);
  const ai = aiSettingsSchema.safeParse(setting?.value);
  if (!(ai.success ? ai.data : DEFAULT_AI_SETTINGS).enabled) {
    return { reason: 'AI tổng đã tắt', consume: false };
  }
  const [bot] = await tx
    .select({ isActive: chatbots.isActive, maxRepliesPerHour: chatbots.maxRepliesPerHour })
    .from(chatbots)
    .where(eq(chatbots.id, botId));
  if (!bot?.isActive) return { reason: 'Chatbot đã tắt', consume: true };
  if (decision === 'reply' && (await countRepliesLastHour(tx, conversationId)) >= bot.maxRepliesPerHour) {
    return { reason: capReason(bot.maxRepliesPerHour), consume: true };
  }
  return null;
}

type LoggedCall = { name?: unknown; args?: Record<string, unknown> } | null | undefined;

const isGuard = (c: LoggedCall, action?: string) =>
  c?.name === HANDOFF_CLAIM_GUARD && (action === undefined || c.args?.action === action);

/** Mục quyết định cuối cùng trong tool_calls (bỏ qua mục của bộ chặn "tự nói đã chuyển"). */
function lastDecisionCall(calls: readonly LoggedCall[]): LoggedCall {
  return [...calls].reverse().find((c) => !isGuard(c));
}

/** reason_code của lần chạy escalate/error đã ghi (để escalate bù). */
function runReasonCode(run: { decision: string; toolCalls: unknown }): HandoffReasonCode {
  if (run.decision !== 'escalate' || !Array.isArray(run.toolCalls)) return 'other';
  const calls = run.toolCalls as LoggedCall[];
  // reply tự nói "đã chuyển nhân viên" bị orchestrator đổi thành escalate 'other' (không phải độ tự tin thấp).
  if (calls.some((c) => isGuard(c, 'convert'))) return 'other';
  const call = lastDecisionCall(calls);
  if (call?.name === 'reply' || call?.name === 'text_fallback') return 'low_confidence';
  const code = call?.args?.reason_code;
  if (HANDOFF_REASON_CODES.includes(code as HandoffReasonCode)) return code as HandoffReasonCode;
  return call?.name === 'prefilter' ? 'human_request' : 'other';
}

/**
 * Tin gửi người nhắn của lần chạy escalate đã ghi (để escalate bù gửi đúng như lượt gốc): messages_to_customer của
 * escalate, hoặc bong bóng reply khi bộ chặn đã đổi thành escalate. Không có ⇒ [] (escalate bù dùng handoffMessage).
 */
function runCustomerMessages(run: { decision: string; toolCalls: unknown }): string[] {
  if (run.decision !== 'escalate' || !Array.isArray(run.toolCalls)) return [];
  const calls = run.toolCalls as LoggedCall[];
  const converted = calls.find((c) => isGuard(c, 'convert'));
  const call = lastDecisionCall(calls);
  const raw = converted
    ? converted.args?.messages
    : call?.name === 'escalate'
      ? call.args?.messages_to_customer
      : undefined;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m): m is string => typeof m === 'string')
    .map((m) => m.trim())
    .filter(Boolean)
    .slice(0, CHATBOT_MAX_BUBBLES);
}

/** Escalate bù chỉ cho lần chạy trong khoảng này (cũ hơn thì bỏ qua). */
const ESCALATE_RECOVERY_MAX_AGE_HOURS = 24;

/**
 * Khôi phục tác dụng phụ sau commit bị mất (worker chết/lỗi giữa commit và gửi/escalate):
 * (a) xếp hàng lại tin bot còn 'queued' của hội thoại (tạo > 5 giây trước — tránh đua với job vừa commit);
 * (b) lần chạy mới nhất là escalate/error mà hội thoại chưa pending_human, vẫn bật bot, chưa có tin system
 *     của lần chạy đó (escalateConversation luôn tạo tin system gắn ai_run_id trong cùng transaction) và không
 *     có handoff nào tạo/đóng sau lần chạy
 *     ⇒ escalateConversation bù (khóa dòng + kiểm handoff mở nên không tạo trùng).
 */
async function recoverLostSideEffects(db: Db, deps: AiRuntimeDeps, conversationId: string): Promise<void> {
  const requeued = await requeueQueuedBotMessages(db, deps.scheduler, { conversationId, minAgeSec: 5 });
  if (requeued > 0) deps.logger.warn({ conversationId, requeued }, 'Xếp hàng lại tin bot chưa gửi');

  const [run] = await db
    .select({
      id: aiRuns.id,
      decision: aiRuns.decision,
      toolCalls: aiRuns.toolCalls,
      summary: aiRuns.reasoningSummary,
      error: aiRuns.error,
      triggers: aiRuns.triggerMessageIds,
      createdAt: aiRuns.createdAt,
      recent: sql<boolean>`${aiRuns.createdAt} > now() - make_interval(hours => ${ESCALATE_RECOVERY_MAX_AGE_HOURS})`,
    })
    .from(aiRuns)
    .where(eq(aiRuns.conversationId, conversationId))
    .orderBy(desc(aiRuns.createdAt), desc(aiRuns.id))
    .limit(1);
  if (!run || !run.recent || run.triggers.length === 0) return;
  if (run.decision !== 'escalate' && run.decision !== 'error') return;
  const [conv] = await db
    .select({
      status: conversations.status,
      aiMode: conversations.aiMode,
      chatbotId: conversations.chatbotId,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  if (!conv || conv.status === 'pending_human' || conv.aiMode !== 'auto' || !conv.chatbotId) return;
  const [done] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.aiRunId, run.id), eq(messages.senderType, 'system')))
    .limit(1);
  if (done) return;
  // Có handoff tạo/đóng sau lần chạy (nhân viên đã can thiệp) ⇒ không escalate bù.
  const [later] = await db
    .select({ id: handoffs.id })
    .from(handoffs)
    .where(
      and(
        eq(handoffs.conversationId, conversationId),
        sql`greatest(${handoffs.createdAt}, coalesce(${handoffs.resolvedAt}, ${handoffs.createdAt})) >= ${run.createdAt}`,
      ),
    )
    .limit(1);
  if (later) return;
  deps.logger.warn({ conversationId, aiRunId: run.id }, 'Escalate bù cho lần chạy AI bị gián đoạn');
  await escalateConversation(db, deps, conversationId, {
    reasonCode: runReasonCode(run),
    summary: run.summary ?? run.error ?? 'AI không xử lý được hội thoại',
    createdBy: 'ai',
    aiRunId: run.id,
    messages: runCustomerMessages(run),
  });
}

/** Cờ ai-dirty còn ⇒ lên lịch lại (tin khách đến lúc cả hai khe đều bận). Lỗi chỉ log. */
async function rescheduleIfDirty(db: Db, deps: AiRuntimeDeps, conversationId: string): Promise<void> {
  try {
    if ((await deps.redis.del(aiDirtyKey(conversationId))) === 0) return;
    await maybeScheduleChatbotReply(db, deps.redis, deps.scheduler, conversationId, deps.ctx.now(), deps);
  } catch (error) {
    deps.logger.warn({ conversationId, err: errorText(error) }, 'Không lên lịch lại được chatbot (ai-dirty)');
  }
}

interface RaceResult {
  reason: string;
  /** Có tin khách mới ⇒ để debounce chạy lại. */
  reschedule: boolean;
}

/** Chống đua 6.4 — gọi trong transaction đã khóa dòng hội thoại. */
async function raceReason(
  tx: DbLike,
  conversationId: string,
  botId: string,
  pending: readonly PendingMessage[],
): Promise<RaceResult | null> {
  const [cur] = await tx
    .select({
      aiMode: conversations.aiMode,
      chatbotId: conversations.chatbotId,
      status: conversations.status,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .for('update');
  if (!cur || cur.aiMode !== 'auto' || cur.chatbotId !== botId || cur.status === 'pending_human') {
    return { reason: 'Chatbot của hội thoại đã thay đổi', reschedule: false };
  }
  if (await hasAgentMessageAfter(tx, conversationId, pending[0]!.id)) {
    return { reason: 'Nhân viên vừa nhắn', reschedule: false };
  }
  const now = await loadPendingMessages(tx, conversationId);
  const before = new Set(pending.map((m) => m.id));
  const current = new Set(now.map((m) => m.id));
  if (now.some((m) => !before.has(m.id))) return { reason: 'Khách vừa nhắn thêm', reschedule: true };
  if (pending.some((m) => !current.has(m.id))) {
    return { reason: 'Lần chạy khác đã xử lý các tin này', reschedule: false };
  }
  return null;
}

/**
 * Job `ai-reply`. Các bước:
 * 0. Khôi phục tác dụng phụ bị mất của lần chạy trước (recoverLostSideEffects): xếp hàng lại tin bot còn
 *    'queued', escalate bù khi lần chạy escalate/error chưa kịp chuyển người.
 * 1. Xóa khóa debounce. Đọc conversation (+ kênh, chatbot). AI tổng tắt hoặc không có tin khách chưa xử lý
 *    ⇒ 'skipped' KHÔNG ghi ai_runs. Điều kiện 6.3 khác không đạt (bot gỡ/tắt, pending_human, đang pause,
 *    nhân viên đã trả lời, canSend(by 'bot'), giới hạn ai_runs 'reply' trong 60 phút) ⇒ 'skipped' + ai_runs
 *    decision 'no_reply', error = lý do, trigger = các tin chưa xử lý (coi như đã xử lý).
 * 2. Dựng history (CHATBOT_HISTORY_LIMIT tin cuối) + newMessages + ảnh (≤ 4, storage.get ⇒ base64), giờ làm
 *    việc, rồi runChatbotTurn({ llm, now: ctx.now, defaultModel, minConfidence }).
 * 3. Transaction + SELECT ... FOR UPDATE conversation (chống đua 6.4): ai_mode/chatbot_id đổi, có tin agent
 *    mới, có tin khách mới (⇒ scheduleChatbotReply lại), hoặc lần chạy khác đã xử lý ⇒ 'cancelled' (ai_runs
 *    'no_reply', error "Đã hủy: …", trigger rỗng để lần sau thấy đủ tin). Kiểm lại công tắc dưới khóa (AI tổng,
 *    bot còn bật, giới hạn/giờ với reply) ⇒ 'cancelled' tương tự. Không thì ghi ai_runs (chatbot_id,
 *    trigger_message_ids, model, tokens, latency_ms, decision, tool_calls, reasoning_summary, error) và với
 *    reply: tạo message sender 'bot' (queued, ai_run_id, tách ≤ 1999).
 * 4. Sau commit: reply ⇒ enqueueOutbound lần lượt với delay cộng dồn BOT_BUBBLE_GAP_MIN_MS..MAX_MS, phát
 *    message.created. escalate / error ⇒ escalateConversation(reasonCode ?? 'other', createdBy 'ai', messages của
 *    escalate — gửi thay handoffMessage).
 * 5. Luôn (finally): cờ aiDirtyKey còn ⇒ xóa và lên lịch lại (tin đến khi cả hai khe job đều bận).
 * Lỗi hạ tầng (DB/Redis) ⇒ ném (BullMQ retry); lỗi LLM không bao giờ ném (decision 'error').
 */
export async function processAiReplyJob(
  db: Db,
  deps: AiRuntimeDeps,
  conversationId: string,
): Promise<AiReplyOutcome> {
  try {
    return await runAiReplyJob(db, deps, conversationId);
  } finally {
    await rescheduleIfDirty(db, deps, conversationId);
  }
}

async function runAiReplyJob(db: Db, deps: AiRuntimeDeps, conversationId: string): Promise<AiReplyOutcome> {
  const keys = debounceKeys(conversationId);
  await deps.redis.del(keys.first, keys.last);
  await recoverLostSideEffects(db, deps, conversationId);
  const skipped = (reason: string, aiRunId: string | null = null): AiReplyOutcome => ({
    status: 'skipped',
    reason,
    aiRunId,
  });

  // Ba lần đọc độc lập ⇒ song song (bớt round trip DB trước lời gọi LLM); thứ tự kiểm giữ nguyên.
  const [ai, conv, pending] = await Promise.all([
    getAiSettings(db),
    loadJobConversation(db, conversationId),
    loadPendingMessages(db, conversationId),
  ]);
  // Không chạy ⇒ tắt chỉ báo sớm do hook tin khách bật (nếu chưa job nào nhận).
  const release = async () => {
    if (conv) await releaseEarlyAiTyping(db, deps, typingTarget(conv));
  };
  if (!ai.enabled) {
    await release();
    return skipped(AI_SKIP_DISABLED);
  }
  if (!conv) return skipped(AI_SKIP_NOT_FOUND);
  if (pending.length === 0) {
    await release();
    return skipped(AI_SKIP_NO_NEW_MESSAGES);
  }

  const triggerMessageIds = pending.map((m) => m.id);
  const model = conv.bot?.model ?? deps.config.defaultModel;
  const blocked = await blockedReason(db, deps, conv);
  if (blocked || !conv.bot) {
    const reason = blocked ?? 'Hội thoại không bật chatbot';
    const id = await insertRun(db, {
      conversationId,
      chatbotId: conv.bot?.id ?? null,
      triggerMessageIds,
      model,
      decision: 'no_reply',
      error: reason,
    });
    deps.logger.info({ conversationId, reason }, 'Chatbot không chạy');
    await release();
    return skipped(reason, id);
  }
  const bot = conv.bot;

  // Đã qua hết điều kiện + có quyền gửi ⇒ "đang soạn tin" NGAY (realtime + sender_action fire-and-forget, chạy
  // song song với tải dữ liệu/LLM). finally: tắt ở mọi đường ra (reply/escalate/no_reply/hủy/lỗi).
  // Ghi đè khóa chỉ báo sớm (nếu có) bằng token của job ⇒ job tự tắt ở finally.
  const typing = startAiTyping(db, deps, typingTarget(conv));
  let botReplyQueued = false;
  try {
    const outcome = await runChatbotTurnAndCommit(db, deps, conv, bot, pending);
    botReplyQueued = outcome.botReplyQueued;
    return outcome.result;
  } finally {
    await typing.stop({ botReplyQueued });
  }
}

/** Bước 2–4 của processAiReplyJob (sau khi đã qua điều kiện chạy). */
async function runChatbotTurnAndCommit(
  db: Db,
  deps: AiRuntimeDeps,
  conv: JobConversation,
  bot: NonNullable<JobConversation['bot']>,
  pending: readonly PendingMessage[],
): Promise<{ result: AiReplyOutcome; botReplyQueued: boolean }> {
  const conversationId = conv.id;
  const triggerMessageIds = pending.map((m) => m.id);
  const model = bot.model ?? deps.config.defaultModel;
  const [{ history, newMessages }, images, businessHours] = await Promise.all([
    loadTurnHistory(db, conversationId, pending),
    loadPromptImages(deps.storage, pending, deps.logger),
    getBusinessHours(db),
  ]);
  const result = await runChatbotTurn(
    {
      llm: deps.llm,
      now: deps.ctx.now,
      defaultModel: deps.config.defaultModel,
      minConfidence: deps.config.minConfidence,
    },
    {
      chatbot: toChatbotConfig(bot),
      history,
      newMessages,
      channelName: conv.channelName,
      businessHours,
      ...(images.length > 0 ? { images } : {}),
    },
  );

  const saved = await db.transaction(async (tx) => {
    const race = await raceReason(tx, conversationId, bot.id, pending);
    const base = { conversationId, chatbotId: bot.id, model, result };
    if (race) {
      const aiRunId = await insertRun(tx, {
        ...base,
        triggerMessageIds: [],
        decision: 'no_reply',
        error: `Đã hủy: ${race.reason}`,
      });
      return { race, aiRunId, messageIds: [] as string[] };
    }
    const kill = await killSwitchReason(tx, conversationId, bot.id, result.decision);
    if (kill) {
      const aiRunId = await insertRun(tx, {
        ...base,
        triggerMessageIds: kill.consume ? triggerMessageIds : [],
        decision: 'no_reply',
        error: `Đã hủy: ${kill.reason}`,
      });
      return { race: { reason: kill.reason, reschedule: false }, aiRunId, messageIds: [] as string[] };
    }
    const aiRunId = await insertRun(tx, {
      ...base,
      triggerMessageIds,
      decision: result.decision,
      error: result.decision === 'error' ? (result.reason ?? 'Lỗi AI') : null,
    });
    const messageIds =
      result.decision === 'reply'
        ? await insertBotMessages(tx, conv, result.messages ?? [], aiRunId, deps.ctx.now())
        : [];
    return { race: null, aiRunId, messageIds };
  });

  if (saved.race) {
    deps.logger.info({ conversationId, reason: saved.race.reason }, 'Hủy lượt chatbot (chống đua/công tắc)');
    if (saved.race.reschedule) {
      await scheduleChatbotReply(deps.redis, deps.scheduler, conversationId, bot, deps.ctx.now());
    }
    return {
      result: { status: 'cancelled', reason: saved.race.reason, aiRunId: saved.aiRunId },
      botReplyQueued: false,
    };
  }

  deps.logger.info(
    { conversationId, decision: result.decision, latencyMs: result.latencyMs, model: result.model },
    'Lượt chatbot xong',
  );
  let botReplyQueued = false;
  if (result.decision === 'reply') {
    const delays = bubbleDelays(saved.messageIds.length, deps.random);
    for (const [i, id] of saved.messageIds.entries()) {
      await deps.scheduler.enqueueOutbound(id, delays[i] ?? 0);
      botReplyQueued = true;
    }
    await emitMessagesCreated(db, deps, saved.messageIds, conversationId);
  } else if (result.decision === 'escalate' || result.decision === 'error') {
    // escalate có messages (messages_to_customer / bong bóng tự nói "đã chuyển") ⇒ gửi THAY handoffMessage.
    const escalated = await escalateConversation(db, deps, conversationId, {
      reasonCode: result.reasonCode ?? 'other',
      summary: result.summary ?? result.reason ?? 'AI không xử lý được hội thoại',
      createdBy: 'ai',
      aiRunId: saved.aiRunId,
      ...(result.decision === 'escalate' && result.messages?.length ? { messages: result.messages } : {}),
    });
    // Tin bot đầu tiên tự tắt dấu ba chấm (như reply) ⇒ không gửi typing_off.
    if (escalated.botMessagesQueued > 0) botReplyQueued = true;
  }
  return { result: { status: 'done', decision: result.decision, aiRunId: saved.aiRunId }, botReplyQueued };
}

// ---------- Nhân viên nhắn ⇒ tạm dừng AI ----------

/** Mặc định AI_PAUSE_AFTER_AGENT_MIN. */
export const DEFAULT_AI_PAUSE_AFTER_AGENT_MIN = 30;

/**
 * Nhân viên vừa gửi tin (sendAgentMessage hoặc echo Business Suite không phải của hệ thống) ⇒ nếu hội thoại
 * có chatbot_id: ai_paused_until = max(hiện tại, now + pauseMinutes) (tin đồng bộ cũ không rút ngắn pause).
 * Trả thời điểm pause sau cập nhật (null nếu không có bot). `db` nhận cả transaction.
 */
export async function pauseAiAfterAgentMessage(
  db: Pick<Db, 'update'>,
  conversationId: string,
  now: Date,
  pauseMinutes: number = DEFAULT_AI_PAUSE_AFTER_AGENT_MIN,
): Promise<Date | null> {
  const until = new Date(now.getTime() + pauseMinutes * 60_000).toISOString();
  const [row] = await db
    .update(conversations)
    .set({
      aiPausedUntil: sql`greatest(${conversations.aiPausedUntil}, ${until}::timestamptz)`,
    })
    .where(and(eq(conversations.id, conversationId), sql`${conversations.chatbotId} is not null`))
    .returning({ aiPausedUntil: conversations.aiPausedUntil });
  return row?.aiPausedUntil ?? null;
}
