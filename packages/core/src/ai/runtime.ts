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
  REENGAGE_FOLLOWUP_MIN_IDLE_MINUTES,
  REENGAGE_LIMITS,
  REENGAGE_MODE_LABELS,
  type HandoffReasonCode,
} from '@dezon/shared';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { isAiPausedIndefinitely, type ChannelType } from '@dezon/shared';
import type { CredentialsCipher } from '../channels/service';
import type { ChannelConnector } from '../connectors/types';
import type { AiReengageJobOptions, HandoffReminderJobData } from '../jobs';
import type { DbLike } from '../inbox/read-model';
import type { InboxContext } from '../inbox/types';
import type { MediaStorage } from '../media/types';
import type { PipelineLogger } from '../pipeline/types';
import type { RealtimePublisher } from '../realtime';
import { applyCapturedFields, fallbackPhoneFromTexts, normalizeVnPhone } from '../contacts/capture';
import { recordProjectLogs } from '../project-logs/service';
import { toChatbotConfig } from './config';
import type { ReengageGuidance } from './prompt';
import {
  followUpAlreadySentSql,
  hasRecentActivitySql,
  lastNonSystemSenderSql,
  lastOwnMessageFailedSql,
  REENGAGE_FOLLOWUP_TOOL_LOG,
} from './reengage';
import {
  botCanSend,
  bubbleDelays,
  countBotTurnsLastHour,
  emitConversationUpdated,
  emitMessagesCreated,
  errorText,
  insertBotMessages,
  requeueQueuedBotMessages,
} from './delivery';
import { escalateConversation } from './escalate';
import { notifyStaffKeyword, type NotifyStaffInput } from './notify-staff';
import { isLlmOutageErrorText, type LlmClient } from './llm';
import { HANDOFF_CLAIM_GUARD, runChatbotTurn } from './orchestrator';
import { CHATBOT_MAX_BUBBLES, enabledCaptureFields } from './tools';
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
  orderPendingBySentAt,
  PENDING_MAX_AGE_HOURS,
  type LoadPendingOptions,
  type PendingMessage,
} from './turn-input';
import type { ChatbotConfig, ChatbotTurnResult } from './types';

export { BOT_REQUEUE_MAX_AGE_SEC, requeueQueuedBotMessages } from './delivery';
export {
  appendHandoffSummary,
  escalateConversation,
  HANDOFF_BOT_STOPPED_SUFFIX,
  HANDOFF_REPEAT_NOTIFY_THROTTLE_MIN,
  HANDOFF_REPEAT_PREFIX,
  HANDOFF_SYSTEM_PREFIX,
  processHandoffReminderJob,
  type EscalateInput,
  type EscalateResult,
} from './escalate';

// ---------- Chờ người mà bot vẫn trả lời ----------

/**
 * Hội thoại pending_human có được chạy bot không: CHỈ khi ai_mode 'auto' và bot HIỆN TẠI đặt aiHandoffMode
 * 'continue' (AI tự chuyển người mà bot vẫn trả lời). Đọc cài đặt bot lúc chạy ⇒ admin đổi bot sang 'stop' thì hội
 * thoại đang chờ người (ai_mode vẫn 'auto') lại bị chặn như cũ. Không pending_human ⇒ true (điều kiện khác kiểm riêng).
 */
export function pendingHumanAllowsBot(conv: {
  status: string;
  aiMode: string;
  aiHandoffMode: string | null | undefined;
}): boolean {
  if (conv.status !== 'pending_human') return true;
  return conv.aiMode === 'auto' && conv.aiHandoffMode === 'continue';
}

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
  /**
   * Hẹn lượt "đánh thức" (AiReplyJobData.wakeup = true) sau delayMs — dùng khi job bị chặn vì tạm nghỉ có giờ.
   * KHÔNG BAO GIỜ thay một job ai-reply đang chờ/delayed của hội thoại (vd. job "kick" sau "Tiếp tục AI", hay job
   * debounce của tin khách mới): có job chờ ⇒ bỏ qua (job đó chạy; còn nghỉ thì nó lại tự hẹn). Cả hai khe đang
   * chạy ⇒ đặt cờ ai-dirty.
   */
  scheduleWakeup(conversationId: string, delayMs: number): Promise<void>;
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
  if (!pendingHumanAllowsBot({ ...conv, aiHandoffMode: bot.aiHandoffMode })) return;
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
  /** Mục mở đầu tool_calls (vd. đánh dấu lượt "Khách không bị bỏ sót" — REENGAGE_FOLLOWUP_TOOL_LOG). */
  toolCallsPrefix?: unknown[];
  /** reasoning_summary thay cho summary/reason của kết quả. */
  summary?: string;
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
      toolCalls: [...(r.toolCallsPrefix ?? []), ...(r.result?.toolCalls ?? [])],
      reasoningSummary: r.summary ?? r.result?.summary ?? r.result?.reason ?? null,
      error: r.error ?? null,
    })
    .returning({ id: aiRuns.id });
  return row!.id;
}

/**
 * Lý do chặn khi ai_paused_until còn hiệu lực (tạm nghỉ / "dừng hẳn" sau tin nhân viên). Riêng lý do này KHÔNG coi
 * các tin là đã xử lý (ai_runs ghi trigger rỗng): "Tiếp tục AI" (kick) hoặc tin khách sau khi pause hết hạn vẫn
 * thấy tin khách đang chờ để trả lời. Xem processAiReplyJob bước 1.
 */
export const AI_BLOCKED_PAUSED = 'AI đang tạm dừng vì nhân viên vừa nhắn';
/** Job bị chặn vì tạm nghỉ có giờ ⇒ hẹn chạy lại sau mốc hết nghỉ thêm chừng này (tránh chạy sát mốc rồi lại bị chặn). */
export const PAUSE_WAKEUP_GRACE_MS = 2000;

/** Điều kiện 6.3 (trừ AI tổng và "có tin mới"). Trả lý do tiếng Việt nếu không được chạy. */
async function blockedReason(db: Db, deps: AiRuntimeDeps, conv: JobConversation): Promise<string | null> {
  const bot = conv.bot;
  if (!bot || conv.aiMode !== 'auto') return 'Hội thoại không bật chatbot';
  if (!bot.isActive) return 'Chatbot đang tắt';
  // Chờ người: chặn — trừ bot 'continue' (AI tự chuyển mà bot vẫn trả lời, ai_mode còn 'auto').
  if (!pendingHumanAllowsBot({ ...conv, aiHandoffMode: bot.aiHandoffMode })) {
    return 'Hội thoại đang chờ người thật xử lý';
  }
  if (conv.aiPausedUntil && conv.aiPausedUntil > deps.ctx.now()) return AI_BLOCKED_PAUSED;
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

/** Lượt reply + lượt escalate đã gửi tin bot (countBotTurnsLastHour) trong 60 phút qua. */
const countRepliesLastHour = countBotTurnsLastHour;

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

/** Từ khóa chuyển người (pre-filter) của lần chạy escalate đã ghi — escalate bù cũng phải dừng bot. */
function runMatchedKeyword(run: { decision: string; toolCalls: unknown }): string | null {
  if (run.decision !== 'escalate' || !Array.isArray(run.toolCalls)) return null;
  const call = lastDecisionCall(run.toolCalls as LoggedCall[]);
  if (call?.name !== 'prefilter') return null;
  const keyword = call.args?.keyword;
  return typeof keyword === 'string' && keyword ? keyword : 'prefilter';
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
      aiHandoffMode: chatbots.aiHandoffMode,
    })
    .from(conversations)
    .leftJoin(chatbots, eq(chatbots.id, conversations.chatbotId))
    .where(eq(conversations.id, conversationId));
  // Đang chờ người ⇒ thôi — trừ bot 'continue' đang trò chuyện: lượt escalate lặp lại (handoff đã mở) có thể mất tin
  // messages_to_customer ⇒ escalate bù gửi lại (escalateConversation không tạo handoff trùng).
  if (!conv || conv.aiMode !== 'auto' || !conv.chatbotId || !pendingHumanAllowsBot(conv)) return;
  // escalateConversation ghi tin system (lượt tạo handoff) HOẶC tin bot (lượt lặp lại khi bot 'continue') gắn
  // ai_run_id trong cùng transaction ⇒ có một trong hai = tác dụng phụ đã xong.
  const [done] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.aiRunId, run.id), inArray(messages.senderType, ['system', 'bot'])))
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
    ...(runMatchedKeyword(run) ? { matchedKeyword: runMatchedKeyword(run) } : {}),
    ...(run.decision === 'error' && isLlmOutageErrorText(run.error) ? { autoResume: true } : {}),
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
  pendingOptions: LoadPendingOptions = {},
  reengage = false,
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
  if (!cur || cur.aiMode !== 'auto' || cur.chatbotId !== botId) {
    return { reason: 'Chatbot của hội thoại đã thay đổi', reschedule: false };
  }
  if (cur.status === 'pending_human') {
    // Bot 'continue' vẫn trả lời trong lúc chờ người; đọc cài đặt hiện tại (admin có thể vừa đổi sang 'stop').
    const [bot] = await tx
      .select({ aiHandoffMode: chatbots.aiHandoffMode })
      .from(chatbots)
      .where(eq(chatbots.id, botId));
    if (!pendingHumanAllowsBot({ ...cur, aiHandoffMode: bot?.aiHandoffMode })) {
      return { reason: 'Chatbot của hội thoại đã thay đổi', reschedule: false };
    }
  }
  if (reengage && cur.status === 'resolved')
    return { reason: AI_BLOCKED_REENGAGE_RESOLVED, reschedule: false };
  if (await hasAgentMessageAfter(tx, conversationId, pending[0]!.id)) {
    return { reason: 'Nhân viên vừa nhắn', reschedule: false };
  }
  // Cùng tuổi tối đa như lúc đọc tin (lượt "Tái chăm sóc" nới tới N ngày) ⇒ không tưởng nhầm tin cũ "đã được xử lý".
  const now = await loadPendingMessages(tx, conversationId, pendingOptions);
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
 *    nhân viên đã trả lời, canSend(by 'bot'), giới hạn lượt gửi tin trong 60 phút — ai_runs 'reply' + 'escalate' đã
 *    gửi tin bot, countBotTurnsLastHour) ⇒ 'skipped' + ai_runs
 *    decision 'no_reply', error = lý do, trigger = các tin chưa xử lý (coi như đã xử lý) — TRỪ khi bị chặn vì
 *    đang pause (AI_BLOCKED_PAUSED: tạm nghỉ / "dừng hẳn" sau tin nhân viên): trigger rỗng, tin khách đến trong
 *    lúc pause vẫn là tin chưa xử lý ⇒ "Tiếp tục AI" (kick) trả lời ngay tin đang chờ. Pause hết hạn tự nhiên thì
 *    không có gì đánh thức: tin khách kế tiếp kéo theo mọi tin đang chờ (sau tin nhân viên cuối, trong
 *    PENDING_MAX_AGE_HOURS). Tin khách TRƯỚC tin nhân viên vẫn coi như nhân viên đã lo (mốc tin nhân viên cuối).
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
 *    escalate — gửi thay handoffMessage). Lượt khớp notifyKeywords (result.notifiedKeyword) mà không chuyển người
 *    (kể cả bị hủy) ⇒ notifyStaffKeyword (tin system + handoff.created botContinues + Lark, chống trùng 10 phút).
 * 5. Luôn (finally): cờ aiDirtyKey còn ⇒ xóa và lên lịch lại (tin đến khi cả hai khe job đều bận).
 * Lượt "Tái chăm sóc" (options.reengage — reengage.ts): bước 1–3 dùng tuổi tối đa pendingMaxAgeHours cho tin chưa xử lý
 * (cả bước chống đua), không xóa khóa debounce, hội thoại đã đổi bot hoặc đã đánh dấu "Đã xử lý" (cả lúc bắt đầu lẫn
 * dưới khóa — AI_BLOCKED_REENGAGE_RESOLVED) ⇒ chặn; MỌI lần chặn/hủy (kể cả công tắc dưới khóa) ghi trigger rỗng; prompt có ghi chú "trả lời muộn" (lateReplySince = giờ gửi tin chờ cũ nhất).
 * Lỗi hạ tầng (DB/Redis) ⇒ ném (BullMQ retry); lỗi LLM không bao giờ ném (decision 'error').
 */
/**
 * Job bị chặn vì tạm nghỉ sau tin nhân viên ⇒ hẹn lượt "đánh thức" ngay sau mốc hết nghỉ, để bot tự trả lời các tin
 * khách đến trong lúc nghỉ (không phải chờ khách nhắn thêm). Đọc LẠI ai_paused_until (nhân viên có thể vừa bấm "Tiếp
 * tục AI" / nhắn thêm): đã gỡ hoặc "dừng hẳn" ⇒ không hẹn. scheduleWakeup không thay job đang chờ (kick, debounce).
 * Lỗi DB/Redis chỉ log.
 */
async function scheduleWakeupAfterPause(db: Db, deps: AiRuntimeDeps, conversationId: string): Promise<void> {
  try {
    const [row] = await db
      .select({ aiPausedUntil: conversations.aiPausedUntil })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    const until = row?.aiPausedUntil;
    if (!until || isAiPausedIndefinitely(until.toISOString())) return;
    const delayMs = Math.max(0, until.getTime() - deps.ctx.now().getTime()) + PAUSE_WAKEUP_GRACE_MS;
    await deps.scheduler.scheduleWakeup(conversationId, delayMs);
  } catch (error) {
    deps.logger.warn(
      { conversationId, err: errorText(error) },
      'Không hẹn được lượt trả lời sau khi hết tạm nghỉ',
    );
  }
}

export interface AiReplyJobOptions {
  /** Lượt "đánh thức" sau tạm nghỉ (AiReplyJobData.wakeup): bị chặn ⇒ không coi tin là đã xử lý. */
  wakeup?: boolean;
  /**
   * Lượt "Tái chăm sóc khách bị bỏ sót" (AiReplyJobData.reengage, admin bấm — reengage.ts): tin chưa xử lý tính tới
   * pendingMaxAgeHours giờ (kẹp trong [PENDING_MAX_AGE_HOURS, REENGAGE_LIMITS.daysMax × 24]); hội thoại không còn gắn
   * chatbotId, đã đánh dấu "Đã xử lý", hoặc bị chặn vì BẤT KỲ lý do gì (kể cả công tắc dưới khóa) ⇒ không coi tin là đã xử lý; prompt có ghi
   * chú "trả lời muộn" (lateReplyTurnNote); không xóa khóa debounce của luồng thường.
   * mode 'followup' ("Khách không bị bỏ sót") ⇒ lượt CHỦ ĐỘNG nhắn khơi gợi lại, không qua tin chưa xử lý — xem
   * runFollowUpJob.
   */
  reengage?: AiReengageJobOptions;
}

/** Tuổi tối đa (giờ, số nguyên) của tin chưa xử lý cho lượt "Tái chăm sóc" — dữ liệu job lạ cũng không vượt khung. */
export function reengagePendingMaxAgeHours(reengage: AiReengageJobOptions): number {
  const hours = Math.ceil(Number(reengage.pendingMaxAgeHours));
  if (!Number.isFinite(hours)) return PENDING_MAX_AGE_HOURS;
  return Math.min(REENGAGE_LIMITS.daysMax * 24, Math.max(PENDING_MAX_AGE_HOURS, hours));
}

/** Lý do chặn lượt "Tái chăm sóc" khi hội thoại đã đổi/gỡ bot sau lúc admin bấm. */
export const AI_BLOCKED_REENGAGE_BOT_CHANGED = 'Hội thoại đã đổi chatbot sau khi bấm tái chăm sóc';
/**
 * Lý do chặn lượt "Tái chăm sóc" khi nhân viên đã đánh dấu hội thoại "Đã xử lý" (sau lúc bấm, hoặc trong lúc gọi AI):
 * tin khách mới luôn mở lại hội thoại (inbound) nên "đã xử lý" = nhân viên đã lo các tin đang chờ — không nhắn xin lỗi
 * muộn về việc đã xong. Lượt thường không chặn (chỉ chạy khi có tin khách mới, lúc đó hội thoại đã mở lại).
 */
export const AI_BLOCKED_REENGAGE_RESOLVED = 'Hội thoại đã được đánh dấu đã xử lý';

export async function processAiReplyJob(
  db: Db,
  deps: AiRuntimeDeps,
  conversationId: string,
  options: AiReplyJobOptions = {},
): Promise<AiReplyOutcome> {
  try {
    return await runAiReplyJob(db, deps, conversationId, options);
  } finally {
    await rescheduleIfDirty(db, deps, conversationId);
  }
}

async function runAiReplyJob(
  db: Db,
  deps: AiRuntimeDeps,
  conversationId: string,
  options: AiReplyJobOptions,
): Promise<AiReplyOutcome> {
  const reengage = options.reengage;
  // Lượt "Tái chăm sóc" không thuộc chuỗi debounce của tin khách mới ⇒ để nguyên khóa debounce (job thường tự xóa).
  if (!reengage) {
    const keys = debounceKeys(conversationId);
    await deps.redis.del(keys.first, keys.last);
  }
  await recoverLostSideEffects(db, deps, conversationId);
  // "Khách không bị bỏ sót": không có tin khách chờ ⇒ lượt chủ động riêng (không qua loadPendingMessages / chống đua 6.4).
  if (reengage?.mode === 'followup') return runFollowUpJob(db, deps, conversationId, reengage);
  const pendingOptions: LoadPendingOptions = reengage
    ? { maxAgeHours: reengagePendingMaxAgeHours(reengage) }
    : {};
  const skipped = (reason: string, aiRunId: string | null = null): AiReplyOutcome => ({
    status: 'skipped',
    reason,
    aiRunId,
  });

  // Ba lần đọc độc lập ⇒ song song (bớt round trip DB trước lời gọi LLM); thứ tự kiểm giữ nguyên.
  const [ai, conv, pending] = await Promise.all([
    getAiSettings(db),
    loadJobConversation(db, conversationId),
    loadPendingMessages(db, conversationId, pendingOptions),
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
  const blocked =
    reengage && conv.bot?.id !== reengage.chatbotId
      ? AI_BLOCKED_REENGAGE_BOT_CHANGED
      : reengage && conv.status === 'resolved'
        ? AI_BLOCKED_REENGAGE_RESOLVED
        : await blockedReason(db, deps, conv);
  if (blocked || !conv.bot) {
    const reason = blocked ?? 'Hội thoại không bật chatbot';
    const id = await insertRun(db, {
      conversationId,
      chatbotId: conv.bot?.id ?? null,
      // Đang pause ⇒ không coi là đã xử lý (resume/kick còn thấy tin để trả lời); lý do khác ⇒ coi như đã xử lý.
      // Lượt "đánh thức" / "Tái chăm sóc" (không do sự kiện mới) bị chặn vì lý do khác (bot vừa gỡ/tắt, đủ lượt/giờ,
      // ngoài cửa sổ…) cũng không.
      triggerMessageIds: reason === AI_BLOCKED_PAUSED || options.wakeup || reengage ? [] : triggerMessageIds,
      model,
      decision: 'no_reply',
      error: reason,
    });
    deps.logger.info({ conversationId, reason }, 'Chatbot không chạy');
    await release();
    if (reason === AI_BLOCKED_PAUSED) await scheduleWakeupAfterPause(db, deps, conversationId);
    return skipped(reason, id);
  }
  const bot = conv.bot;

  // Đã qua hết điều kiện + có quyền gửi ⇒ "đang soạn tin" NGAY (realtime + sender_action fire-and-forget, chạy
  // song song với tải dữ liệu/LLM). finally: tắt ở mọi đường ra (reply/escalate/no_reply/hủy/lỗi).
  // Ghi đè khóa chỉ báo sớm (nếu có) bằng token của job ⇒ job tự tắt ở finally.
  const typing = startAiTyping(db, deps, typingTarget(conv));
  let botReplyQueued = false;
  try {
    const outcome = await runChatbotTurnAndCommit(db, deps, conv, bot, pending, {
      pendingOptions,
      reengage: reengage !== undefined,
      ...(reengage?.rules || reengage?.content
        ? {
            reengageGuidance: {
              ...(reengage.rules ? { rules: reengage.rules } : {}),
              ...(reengage.content ? { content: reengage.content } : {}),
            },
          }
        : {}),
    });
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
  turn: { pendingOptions: LoadPendingOptions; reengage: boolean; reengageGuidance?: ReengageGuidance },
): Promise<{ result: AiReplyOutcome; botReplyQueued: boolean }> {
  const conversationId = conv.id;
  const triggerMessageIds = pending.map((m) => m.id);
  const model = bot.model ?? deps.config.defaultModel;
  const [{ history, newMessages }, images, businessHours] = await Promise.all([
    loadTurnHistory(db, conversationId, pending),
    loadPromptImages(deps.storage, pending, deps.logger),
    getBusinessHours(db),
  ]);
  const chatbot = toChatbotConfig(bot);
  const result = await runChatbotTurn(
    {
      llm: deps.llm,
      now: deps.ctx.now,
      defaultModel: deps.config.defaultModel,
      minConfidence: deps.config.minConfidence,
    },
    {
      chatbot,
      history,
      newMessages,
      channelName: conv.channelName,
      businessHours,
      ...(images.length > 0 ? { images } : {}),
      ...(turn.reengage ? { lateReplySince: oldestSentAt(pending) ?? deps.ctx.now() } : {}),
      ...(turn.reengageGuidance ? { reengageGuidance: turn.reengageGuidance } : {}),
    },
  );

  const saved = await db.transaction(async (tx) => {
    const race = await raceReason(tx, conversationId, bot.id, pending, turn.pendingOptions, turn.reengage);
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
        // Lượt "Tái chăm sóc" bị chặn dưới khóa (bot vừa tắt, đủ lượt/giờ) cũng không nuốt tin khách.
        triggerMessageIds: kill.consume && !turn.reengage ? triggerMessageIds : [],
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

  // Từ khóa "Báo nhân viên, bot VẪN trả lời" (notifyKeywords): báo nhân viên sau commit ở MỌI kết quả của lượt
  // (reply / no_reply / hủy do chống đua hay công tắc), kể cả khi bước sau commit ném lỗi (finally) — trừ khi lượt
  // này chuyển người thật (escalate/error đã ghi): escalateConversation đã báo (tin system + handoff.created + Lark).
  // escalateConversation không báo gì (staffNotified false — đã chờ người với bot dừng, chống trùng) ⇒ vẫn báo theo từ khóa.
  let staffNotified: boolean | undefined;
  try {
    const out = await afterTurnCommitted(db, deps, conv, bot, result, saved);
    staffNotified = out.staffNotified;
    return out;
  } finally {
    // "Thu thập thông tin": lượt đã commit thật (không hủy, không lỗi) ⇒ ghi vào hồ sơ khách. Sau phần gửi/chuyển người
    // (không làm chậm tin bot); lỗi chỉ log, không bao giờ ảnh hưởng lượt bot.
    if (!saved.race && result.decision !== 'error') {
      await captureCustomerInfoSafe(db, deps, conversationId, chatbot.capture, result, pending);
    }
    // "Nhật ký công trình": lượt reply / escalate đã commit thật ⇒ ghi các công trình bot tiếp nhận (lỗi chỉ log).
    if (!saved.race && (result.decision === 'reply' || result.decision === 'escalate')) {
      await recordProjectLogsSafe(db, deps, conversationId, chatbot, result, pending, saved);
    }
    const notifyKeyword =
      result.notifiedKeyword &&
      (saved.race ||
        (result.decision !== 'escalate' && result.decision !== 'error') ||
        staffNotified === false)
        ? result.notifiedKeyword
        : null;
    if (notifyKeyword) {
      await notifyStaffSafe(db, deps, conversationId, {
        keyword: notifyKeyword,
        customerTexts: pending.map((m) => m.text),
        aiRunId: saved.aiRunId,
      });
    }
  }
}

/**
 * Thông tin khách cần ghi của một lượt: `captured` model điền (ChatbotTurnResult.captured, đã lọc theo trường bật) +
 * dự phòng SĐT (trường phone bật): CHỈ khi model không điền `captured` hoặc điền `phone` mà sai dạng — model đã điền
 * `captured` mà bỏ phone thì tôn trọng (số trong tin có thể là của người khác) — lấy SĐT từ tin khách của lượt này
 * (fallbackPhoneFromTexts: tin chỉ để cho SĐT), đánh dấu phoneGuessed (chỉ điền khi khách chưa có SĐT, không gắn
 * nhãn). Lượt có Nhật ký công trình (`projectLogs` khác rỗng) ⇒ KHÔNG dự phòng: số trong tin lượt đó thường là
 * SĐT nhà thầu, không phải của người nhắn. Không có gì ⇒ null.
 */
export function turnCapturedInfo(
  capture: ChatbotConfig['capture'],
  captured: Record<string, string> | undefined,
  customerTexts: readonly (string | null)[],
  projectLogs?: readonly Record<string, string>[],
): { phone: string | null; phoneGuessed?: true; fields: Record<string, string> } | null {
  const enabledKeys = new Set(enabledCaptureFields(capture).map((f) => f.key));
  if (enabledKeys.size === 0) return null;
  const { phone: modelPhone, ...rest } = captured ?? {};
  const fields = Object.fromEntries(Object.entries(rest).filter(([k]) => enabledKeys.has(k)));
  let phone: string | null = null;
  let phoneGuessed = false;
  if (enabledKeys.has('phone')) {
    phone = modelPhone ? normalizeVnPhone(modelPhone) : null;
    if (!phone && (captured === undefined || modelPhone) && !projectLogs?.length) {
      phone = fallbackPhoneFromTexts(customerTexts);
      phoneGuessed = phone !== null;
    }
  }
  if (!phone && Object.keys(fields).length === 0) return null;
  return { phone, ...(phoneGuessed && { phoneGuessed: true as const }), fields };
}

/**
 * Ghi thông tin khách bot thu thập được (applyCapturedFields, transaction riêng — contact lấy lại từ hội thoại trong
 * transaction để đúng khách sau khi gộp); có thay đổi (trường / nhãn) ⇒ phát conversation.updated cho hộp thư đang mở.
 * Bot tắt thu thập ⇒ không làm gì. KHÔNG BAO GIỜ ném: lỗi chỉ log warn.
 */
async function captureCustomerInfoSafe(
  db: Db,
  deps: AiRuntimeDeps,
  conversationId: string,
  capture: ChatbotConfig['capture'],
  result: ChatbotTurnResult,
  pending: readonly PendingMessage[],
): Promise<void> {
  if (!capture.enabled) return;
  try {
    const info = turnCapturedInfo(
      capture,
      result.captured,
      pending.map((m) => m.text),
      result.projectLogs,
    );
    if (!info) return;
    const out = await db.transaction(async (tx) => {
      const [conv] = await tx
        .select({ contactId: conversations.contactId })
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      if (!conv) return null;
      return applyCapturedFields(tx, {
        contactId: conv.contactId,
        config: capture,
        captured: info,
        now: deps.ctx.now(),
      });
    });
    if (!out || (out.changedKeys.length === 0 && out.tagged === null)) return;
    deps.logger.info(
      { conversationId, keys: out.changedKeys, tagged: out.tagged !== null },
      'Bot thu thập thông tin khách',
    );
    await emitConversationUpdated(db, deps, conversationId);
  } catch (error) {
    deps.logger.warn({ conversationId, err: errorText(error) }, 'Không ghi được thông tin khách (thu thập)');
  }
}

/**
 * Ghi "Nhật ký công trình" của một lượt reply / escalate đã commit (recordProjectLogs, transaction riêng — chống trùng
 * theo aiRunId): công trình model điền (ChatbotTurnResult.projectLogs, đã lọc trường bật), gắn với tin khách của lượt
 * (theo thứ tự gửi) + tin bot của lượt (bong bóng reply; escalate: tin gửi khách lúc chuyển — đọc theo ai_run_id vì
 * escalateConversation tự chèn). Có dòng mới ⇒ phát conversation.updated (web tải lại chi tiết, có projectLogs).
 * Bot tắt nhật ký / không có công trình ⇒ không làm gì. KHÔNG BAO GIỜ ném: lỗi chỉ log warn.
 */
async function recordProjectLogsSafe(
  db: Db,
  deps: AiRuntimeDeps,
  conversationId: string,
  chatbot: ChatbotConfig,
  result: ChatbotTurnResult,
  pending: readonly PendingMessage[],
  saved: { aiRunId: string; messageIds: string[] },
): Promise<void> {
  const config = chatbot.capture.projectLog;
  const entries = result.projectLogs ?? [];
  if (!config?.enabled || entries.length === 0) return;
  try {
    const ids = await db.transaction(async (tx) => {
      const botMessageIds =
        result.decision === 'reply'
          ? saved.messageIds
          : (
              await tx
                .select({ id: messages.id })
                .from(messages)
                .where(
                  and(
                    eq(messages.conversationId, conversationId),
                    eq(messages.aiRunId, saved.aiRunId),
                    eq(messages.senderType, 'bot'),
                  ),
                )
                .orderBy(asc(messages.createdAt), asc(messages.id))
            ).map((m) => m.id);
      return recordProjectLogs(tx, {
        conversationId,
        chatbotId: chatbot.id,
        aiRunId: saved.aiRunId,
        config,
        entries,
        customerMessageIds: orderPendingBySentAt(pending).map((m) => m.id),
        botMessageIds,
        now: deps.ctx.now(),
      });
    });
    if (ids.length === 0) return;
    deps.logger.info({ conversationId, count: ids.length }, 'Bot ghi nhật ký công trình');
    await emitConversationUpdated(db, deps, conversationId);
  } catch (error) {
    deps.logger.warn({ conversationId, err: errorText(error) }, 'Không ghi được nhật ký công trình');
  }
}

/** Giờ gửi sớm nhất trong các tin chưa xử lý (ghi chú "trả lời muộn" của lượt "Tái chăm sóc"). */
function oldestSentAt(pending: readonly PendingMessage[]): Date | null {
  let oldest: Date | null = null;
  for (const m of pending) if (m.sentAt && (!oldest || m.sentAt < oldest)) oldest = m.sentAt;
  return oldest;
}

/** Báo nhân viên (notifyStaffKeyword); lỗi chỉ log warn — lượt bot đã commit, không ném để BullMQ chạy lại. */
async function notifyStaffSafe(
  db: Db,
  deps: AiRuntimeDeps,
  conversationId: string,
  input: NotifyStaffInput,
): Promise<void> {
  try {
    await notifyStaffKeyword(db, deps, conversationId, input);
  } catch (error) {
    deps.logger.warn({ conversationId, err: errorText(error) }, 'Không báo được nhân viên (từ khóa báo)');
  }
}

/** Bước 4 của processAiReplyJob: tác dụng phụ sau commit (gửi tin bot / chuyển người / lên lịch lại khi hủy). */
async function afterTurnCommitted(
  db: Db,
  deps: AiRuntimeDeps,
  conv: JobConversation,
  bot: NonNullable<JobConversation['bot']>,
  result: ChatbotTurnResult,
  saved: { race: RaceResult | null; aiRunId: string; messageIds: string[] },
): Promise<{ result: AiReplyOutcome; botReplyQueued: boolean; staffNotified?: boolean }> {
  const conversationId = conv.id;
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
  let staffNotified: boolean | undefined;
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
      // Từ khóa chuyển người luôn dừng bot (kể cả bot 'continue').
      ...(result.matchedKeyword ? { matchedKeyword: result.matchedKeyword } : {}),
      // Lỗi phía AI (hết tiền, quá tải, hết thời gian chờ…) ⇒ tự trả lại cho bot khi AI hoạt động lại.
      ...(result.decision === 'error' && result.llmOutage ? { autoResume: true } : {}),
    });
    staffNotified = escalated.staffNotified;
    // Tin bot đầu tiên tự tắt dấu ba chấm (như reply) ⇒ không gửi typing_off.
    if (escalated.botMessagesQueued > 0) botReplyQueued = true;
  }
  return {
    result: { status: 'done', decision: result.decision, aiRunId: saved.aiRunId },
    botReplyQueued,
    ...(staffNotified !== undefined ? { staffNotified } : {}),
  };
}

// ---------- Tái chăm sóc "Khách không bị bỏ sót" (lượt chủ động) ----------

/** Lý do chặn lượt "Khách không bị bỏ sót": khách đã nhắn sau tin cuối của bên mình ⇒ luồng debounce thường trả lời. */
export const AI_BLOCKED_FOLLOWUP_CUSTOMER_WROTE = 'Khách vừa nhắn — để luồng trả lời thường xử lý';
/** Lý do chặn lượt "Khách không bị bỏ sót": hội thoại có tin (bất kỳ bên nào) trong khoảng lặng tối thiểu. */
export const AI_BLOCKED_FOLLOWUP_RECENT_ACTIVITY = `Hội thoại có tin nhắn trong ${REENGAGE_FOLLOWUP_MIN_IDLE_MINUTES} phút gần đây`;
/** Lý do chặn lượt "Khách không bị bỏ sót": hội thoại chưa có tin nào của khách (không có gì để khơi gợi lại). */
export const AI_BLOCKED_FOLLOWUP_NO_CUSTOMER = 'Hội thoại chưa có tin nhắn của khách';
/** Lý do chặn lượt "Khách không bị bỏ sót": đã nhắn khơi gợi sau tin khách cuối mà khách chưa đáp ⇒ không nhắn dồn. */
export const AI_BLOCKED_FOLLOWUP_ALREADY_SENT = 'Đã nhắn khơi gợi khách này rồi, khách chưa nhắn lại';
/** Lý do chặn lượt "Khách không bị bỏ sót": tin cuối của bên mình gửi thất bại (khách có thể chưa nhận được). */
export const AI_BLOCKED_FOLLOWUP_LAST_FAILED = 'Tin cuối của bên mình gửi thất bại — nhân viên cần kiểm tra';
/** Lượt "Khách không bị bỏ sót" mà AI gọi `no_reply` (khách đã từ chối / đã xong / hội thoại đã kết thúc…) ⇒ không gửi. */
export const AI_FOLLOWUP_DECLINED = 'AI quyết định không nhắn khơi gợi';
/** Lượt "Khách không bị bỏ sót" mà AI không gọi `reply` (hoặc không còn bong bóng) ⇒ không gửi gì. */
export const AI_FOLLOWUP_NO_REPLY = 'AI không soạn được tin chăm sóc';

const FOLLOWUP_SUMMARY = `Tái chăm sóc «${REENGAGE_MODE_LABELS.followup}» — bot chủ động nhắn khơi gợi lại`;

/** Mục đánh dấu đầu tool_calls (Nhật ký AI): chỉ độ dài chỉ dẫn gõ tay, không ghi nội dung. */
function followUpToolLog(reengage: AiReengageJobOptions): unknown {
  return {
    name: REENGAGE_FOLLOWUP_TOOL_LOG,
    args: {
      mode: 'followup',
      rulesChars: reengage.rules ? Array.from(reengage.rules).length : 0,
      contentChars: reengage.content ? Array.from(reengage.content).length : 0,
    },
  };
}

/**
 * Trạng thái tin nhắn của hội thoại cho lượt "Khách không bị bỏ sót" (cùng quy tắc với câu quét — reengage.ts): tin cuối
 * không tính system / echo tự động là của khách ⇒ AI_BLOCKED_FOLLOWUP_CUSTOMER_WROTE; chưa có tin khách ⇒
 * AI_BLOCKED_FOLLOWUP_NO_CUSTOMER; có tin (bất kỳ loại nào) trong REENGAGE_FOLLOWUP_MIN_IDLE_MINUTES phút ⇒
 * AI_BLOCKED_FOLLOWUP_RECENT_ACTIVITY; đã nhắn khơi gợi sau tin khách cuối (followUpAlreadySentSql) ⇒
 * AI_BLOCKED_FOLLOWUP_ALREADY_SENT; tin cuối của bên mình gửi thất bại ⇒ AI_BLOCKED_FOLLOWUP_LAST_FAILED. Không có gì
 * ⇒ null.
 */
async function followUpStateReason(db: DbLike, conversationId: string): Promise<string | null> {
  const conv = sql`${conversations.id}`;
  const [row] = await db
    .select({
      lastSender: lastNonSystemSenderSql(conv),
      recent: hasRecentActivitySql(conv),
      hasCustomer: sql<boolean>`exists (select 1 from ${messages} cm
        where cm.conversation_id = ${conv} and cm.sender_type = 'customer')`,
      alreadySent: followUpAlreadySentSql(conv),
      lastFailed: lastOwnMessageFailedSql(conv),
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  if (!row) return 'Không tìm thấy hội thoại';
  if (row.lastSender === 'customer') return AI_BLOCKED_FOLLOWUP_CUSTOMER_WROTE;
  if (!row.hasCustomer || row.lastSender === null) return AI_BLOCKED_FOLLOWUP_NO_CUSTOMER;
  if (row.recent) return AI_BLOCKED_FOLLOWUP_RECENT_ACTIVITY;
  if (row.alreadySent) return AI_BLOCKED_FOLLOWUP_ALREADY_SENT;
  if (row.lastFailed) return AI_BLOCKED_FOLLOWUP_LAST_FAILED;
  return null;
}

/**
 * Kiểm lại DƯỚI KHÓA dòng hội thoại (SELECT … FOR UPDATE) ngay trước khi ghi tin bot của lượt "Khách không bị bỏ sót":
 * vẫn ai_mode 'auto' + đúng bot, không chờ người (trừ bot 'continue'), không "Đã xử lý", không đang tạm dừng, và
 * followUpStateReason (khách chưa nhắn thêm, hội thoại vẫn lặng). Trả lý do hủy hoặc null.
 */
async function followUpRaceReason(
  tx: DbLike,
  conversationId: string,
  botId: string,
  now: Date,
): Promise<string | null> {
  const [cur] = await tx
    .select({
      aiMode: conversations.aiMode,
      chatbotId: conversations.chatbotId,
      status: conversations.status,
      aiPausedUntil: conversations.aiPausedUntil,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .for('update');
  if (!cur || cur.aiMode !== 'auto' || cur.chatbotId !== botId) return 'Chatbot của hội thoại đã thay đổi';
  if (cur.status === 'pending_human') {
    const [bot] = await tx
      .select({ aiHandoffMode: chatbots.aiHandoffMode })
      .from(chatbots)
      .where(eq(chatbots.id, botId));
    if (!pendingHumanAllowsBot({ ...cur, aiHandoffMode: bot?.aiHandoffMode })) {
      return 'Hội thoại đang chờ người thật xử lý';
    }
  }
  if (cur.status === 'resolved') return AI_BLOCKED_REENGAGE_RESOLVED;
  if (cur.aiPausedUntil && cur.aiPausedUntil > now) return AI_BLOCKED_PAUSED;
  return followUpStateReason(tx, conversationId);
}

/**
 * Lượt "Tái chăm sóc — Khách không bị bỏ sót" (AiReengageJobOptions.mode 'followup', admin bấm — reengage.ts): bên
 * mình đã trả lời sau tin cuối của khách và hội thoại đã lặng ⇒ bot CHỦ ĐỘNG nhắn 1–2 tin khơi gợi lại. Không có tin
 * khách nào được coi là đã xử lý (mọi ai_runs của lượt này trigger RỖNG).
 * 1. AI tổng tắt / hội thoại không có ⇒ 'skipped' KHÔNG ghi ai_runs (như lượt thường).
 * 2. Kiểm điều kiện (chưa gọi AI): còn gắn đúng chatbotId (AI_BLOCKED_REENGAGE_BOT_CHANGED), chưa "Đã xử lý"
 *    (AI_BLOCKED_REENGAGE_RESOLVED), blockedReason (bot gỡ/tắt, chờ người trừ 'continue', tạm dừng, botCanSend, giới
 *    hạn lượt/giờ), followUpStateReason (khách đã nhắn thêm ⇒ luồng debounce thường lo; chưa có tin khách; có tin trong
 *    khoảng lặng; đã nhắn khơi gợi mà khách chưa đáp; tin cuối của bên mình gửi thất bại) ⇒ 'skipped' + ai_runs 'no_reply' (error = lý do, trigger rỗng). Không hẹn "đánh thức" khi tạm dừng.
 * 3. Lịch sử (loadTurnHistory, không có tin mới) + runChatbotTurn({ followUp: true, reengageGuidance }) ⇒ chỉ tool
 *    `reply` + `no_reply` (khách đã từ chối / đã xong ⇒ AI không nhắn: 'no_reply' AI_FOLLOWUP_DECLINED), không escalate / pre-filter / bộ chặn "tự nói đã chuyển", không captured / project_logs. Không ra 'reply'
 *    có bong bóng ⇒ ghi ai_runs ('error' giữ nguyên lý do lỗi AI, còn lại 'no_reply' AI_FOLLOWUP_NO_REPLY), KHÔNG gửi
 *    gì, KHÔNG chuyển người (trigger rỗng ⇒ recoverLostSideEffects cũng không escalate bù).
 * 4. Transaction: followUpRaceReason dưới khóa + killSwitchReason (AI tổng, bot còn bật, giới hạn/giờ) ⇒ 'cancelled'
 *    (ai_runs 'no_reply', "Đã hủy: …", trigger rỗng; không lên lịch lại — tin khách mới đã tự lên lịch debounce). Không
 *    thì ai_runs 'reply' (trigger rỗng, tool_calls mở đầu REENGAGE_FOLLOWUP_TOOL_LOG) + tin bot (insertBotMessages).
 * 5. Sau commit: enqueueOutbound từng tin (bubbleDelays) + message.created. KHÔNG ghi "Thu thập thông tin" / "Nhật ký
 *    công trình", không báo nhân viên theo từ khóa.
 * Lỗi hạ tầng (DB/Redis) ⇒ ném (BullMQ retry: lần chạy lại thấy tin bot vừa gửi trong khoảng lặng ⇒ tự bỏ qua).
 */
async function runFollowUpJob(
  db: Db,
  deps: AiRuntimeDeps,
  conversationId: string,
  reengage: AiReengageJobOptions,
): Promise<AiReplyOutcome> {
  const [ai, conv] = await Promise.all([getAiSettings(db), loadJobConversation(db, conversationId)]);
  if (!ai.enabled) return { status: 'skipped', reason: AI_SKIP_DISABLED, aiRunId: null };
  if (!conv) return { status: 'skipped', reason: AI_SKIP_NOT_FOUND, aiRunId: null };
  const marker = followUpToolLog(reengage);
  const blocked =
    conv.bot?.id !== reengage.chatbotId
      ? AI_BLOCKED_REENGAGE_BOT_CHANGED
      : conv.status === 'resolved'
        ? AI_BLOCKED_REENGAGE_RESOLVED
        : ((await blockedReason(db, deps, conv)) ?? (await followUpStateReason(db, conversationId)));
  if (blocked || !conv.bot) {
    const reason = blocked ?? 'Hội thoại không bật chatbot';
    const id = await insertRun(db, {
      conversationId,
      chatbotId: conv.bot?.id ?? null,
      triggerMessageIds: [],
      model: conv.bot?.model ?? deps.config.defaultModel,
      decision: 'no_reply',
      error: reason,
      toolCallsPrefix: [marker],
      summary: FOLLOWUP_SUMMARY,
    });
    deps.logger.info({ conversationId, reason }, 'Chatbot không chạy (tái chăm sóc chủ động)');
    return { status: 'skipped', reason, aiRunId: id };
  }
  const bot = conv.bot;
  const typing = startAiTyping(db, deps, typingTarget(conv));
  let botReplyQueued = false;
  try {
    const outcome = await runFollowUpTurnAndCommit(db, deps, conv, bot, reengage, marker);
    botReplyQueued = outcome.botReplyQueued;
    return outcome.result;
  } finally {
    await typing.stop({ botReplyQueued });
  }
}

/** Bước 3–5 của runFollowUpJob (sau khi đã qua điều kiện chạy). */
async function runFollowUpTurnAndCommit(
  db: Db,
  deps: AiRuntimeDeps,
  conv: JobConversation,
  bot: NonNullable<JobConversation['bot']>,
  reengage: AiReengageJobOptions,
  marker: unknown,
): Promise<{ result: AiReplyOutcome; botReplyQueued: boolean }> {
  const conversationId = conv.id;
  const model = bot.model ?? deps.config.defaultModel;
  const [{ history }, businessHours] = await Promise.all([
    loadTurnHistory(db, conversationId, []),
    getBusinessHours(db),
  ]);
  const guidance: ReengageGuidance | null =
    reengage.rules || reengage.content
      ? {
          ...(reengage.rules ? { rules: reengage.rules } : {}),
          ...(reengage.content ? { content: reengage.content } : {}),
        }
      : null;
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
      newMessages: [],
      channelName: conv.channelName,
      businessHours,
      followUp: true,
      ...(guidance ? { reengageGuidance: guidance } : {}),
    },
  );
  const base = {
    conversationId,
    chatbotId: bot.id,
    model,
    result,
    triggerMessageIds: [] as string[],
    toolCallsPrefix: [marker],
    summary: FOLLOWUP_SUMMARY,
  };

  const bubbles = result.decision === 'reply' ? (result.messages ?? []) : [];
  if (bubbles.length === 0) {
    // Không gửi gì, không chuyển người: lượt chủ động không có khách nào đang chờ.
    const decision = result.decision === 'error' ? 'error' : 'no_reply';
    const error =
      result.decision === 'error'
        ? (result.reason ?? 'Lỗi AI')
        : result.decision === 'no_reply'
          ? `${AI_FOLLOWUP_DECLINED}: ${result.reason ?? ''}`.trim()
          : `${AI_FOLLOWUP_NO_REPLY} (decision ${result.decision})`;
    const aiRunId = await insertRun(db, { ...base, decision, error });
    deps.logger.warn({ conversationId, decision: result.decision }, AI_FOLLOWUP_NO_REPLY);
    return { result: { status: 'done', decision, aiRunId }, botReplyQueued: false };
  }

  const saved = await db.transaction(async (tx) => {
    const race =
      (await followUpRaceReason(tx, conversationId, bot.id, deps.ctx.now())) ??
      (await killSwitchReason(tx, conversationId, bot.id, 'reply'))?.reason ??
      null;
    if (race) {
      const aiRunId = await insertRun(tx, { ...base, decision: 'no_reply', error: `Đã hủy: ${race}` });
      return { race, aiRunId, messageIds: [] as string[] };
    }
    const aiRunId = await insertRun(tx, { ...base, decision: 'reply', error: null });
    const messageIds = await insertBotMessages(tx, conv, bubbles, aiRunId, deps.ctx.now());
    return { race: null, aiRunId, messageIds };
  });

  if (saved.race) {
    deps.logger.info(
      { conversationId, reason: saved.race },
      'Hủy lượt tái chăm sóc chủ động (kiểm lại dưới khóa)',
    );
    return {
      result: { status: 'cancelled', reason: saved.race, aiRunId: saved.aiRunId },
      botReplyQueued: false,
    };
  }
  deps.logger.info(
    { conversationId, latencyMs: result.latencyMs, model: result.model, bubbles: saved.messageIds.length },
    'Lượt tái chăm sóc chủ động xong',
  );
  const delays = bubbleDelays(saved.messageIds.length, deps.random);
  let botReplyQueued = false;
  for (const [i, id] of saved.messageIds.entries()) {
    await deps.scheduler.enqueueOutbound(id, delays[i] ?? 0);
    botReplyQueued = true;
  }
  await emitMessagesCreated(db, deps, saved.messageIds, conversationId);
  return { result: { status: 'done', decision: 'reply', aiRunId: saved.aiRunId }, botReplyQueued };
}

// ---------- Nhân viên nhắn ⇒ tạm dừng AI ----------
// Áp "Khi nhân viên vào nhắn tin" (agent_reply_mode: continue / pause / stop) của bot — xem ./agent-pause.ts.
export {
  DEFAULT_AI_PAUSE_AFTER_AGENT_MIN,
  pauseAiAfterAgentMessage,
  type AgentPauseResult,
} from './agent-pause';
