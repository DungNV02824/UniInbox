// Phụ thuộc chatbot AI cho worker: LLM (Gemini), scheduler BullMQ, Redis debounce, cấu hình từ env.
import {
  AI_DIRTY_TTL_SEC,
  aiDirtyKey,
  createGeminiClient,
  LlmError,
  maybeScheduleChatbotReply,
  requeueQueuedBotMessages,
  type AiJobScheduler,
  type AiRuntimeDeps,
  type CustomerMessageStoredEvent,
  type DebounceRedis,
  type EarlyTypingDeps,
  type LarkConfig,
  type LlmClient,
  type PipelineDeps,
  type PipelineLogger,
} from '@dezon/core';
import type { Db } from '@dezon/db';
import { QUEUE_NAMES } from '@dezon/shared';
import type { Env } from '@dezon/shared/server';
import type { Redis } from 'ioredis';
import { createQueue } from '../queues';
import { closeRedis, createRedisConnection } from '../redis';
import { createBullAiJobScheduler } from './scheduler';

type AiEnv = Pick<
  Env,
  | 'AI_PROVIDER'
  | 'GEMINI_API_KEY'
  | 'GEMINI_MODEL'
  | 'AI_MIN_CONFIDENCE'
  | 'APP_URL'
  | 'HANDOFF_ESCALATE_AFTER_MIN'
  | 'LARK_WEBHOOK_URL'
  | 'LARK_WEBHOOK_SECRET'
>;

/**
 * LLM client theo env. Không có key / provider khác 'gemini' / core chưa sẵn sàng ⇒ null (worker vẫn chạy,
 * job trả lời AI bị bỏ qua). Không ném lỗi để worker luôn khởi động được.
 */
export function createLlmClient(
  env: Pick<AiEnv, 'AI_PROVIDER' | 'GEMINI_API_KEY'>,
  logger: Pick<PipelineLogger, 'warn'>,
  factory: (apiKey: string) => LlmClient = createGeminiClient,
): LlmClient | null {
  if (env.AI_PROVIDER !== 'gemini') {
    logger.warn({ provider: env.AI_PROVIDER }, 'AI_PROVIDER chưa hỗ trợ (chỉ gemini): chatbot AI tắt');
    return null;
  }
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    logger.warn({}, 'Thiếu GEMINI_API_KEY: chatbot AI tắt (không lên lịch/không chạy job trả lời)');
    return null;
  }
  try {
    return factory(apiKey);
  } catch (error) {
    // Không log key; chỉ thông điệp lỗi.
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'Không tạo được Gemini client: chatbot AI tắt',
    );
    return null;
  }
}

/** LLM giả khi AI tắt: job nhắc handoff vẫn cần AiRuntimeDeps nhưng không bao giờ gọi LLM. */
export const disabledLlmClient: LlmClient = {
  generate: () => Promise.reject(new LlmError('Chatbot AI chưa được cấu hình (GEMINI_API_KEY)', false)),
};

/** Lark dự phòng từ env (LARK_WEBHOOK_URL/SECRET) khi app_settings.lark chưa cấu hình. */
export function larkFallbackFromEnv(
  env: Pick<AiEnv, 'LARK_WEBHOOK_URL' | 'LARK_WEBHOOK_SECRET'>,
): LarkConfig | null {
  if (!env.LARK_WEBHOOK_URL) return null;
  return { webhookUrl: env.LARK_WEBHOOK_URL, secret: env.LARK_WEBHOOK_SECRET?.trim() || null };
}

export interface BuildAiDepsInput {
  env: AiEnv;
  /**
   * Dùng lại publisher/ctx/storage/cipher của pipeline, và connectors (cùng object createConnectors) để gửi chỉ báo
   * "đang soạn tin" (sender_action) cho khách.
   */
  pipeline: Pick<PipelineDeps, 'publisher' | 'ctx' | 'storage' | 'cipher' | 'connectors'>;
  scheduler: AiJobScheduler;
  redis: DebounceRedis;
  logger: PipelineLogger;
  llmFactory?: (apiKey: string) => LlmClient;
}

export interface BuiltAiDeps {
  /** true khi có LLM thật: lên lịch và chạy job trả lời. */
  enabled: boolean;
  deps: AiRuntimeDeps;
  larkFallback: LarkConfig | null;
}

/** Dựng AiRuntimeDeps (thuần, không mở kết nối) — tách riêng để test. */
export function buildAiRuntimeDeps(input: BuildAiDepsInput): BuiltAiDeps {
  const { env, pipeline, scheduler, redis, logger } = input;
  const llm = createLlmClient(env, logger, input.llmFactory);
  const larkFallback = larkFallbackFromEnv(env);
  const deps: AiRuntimeDeps = {
    llm: llm ?? disabledLlmClient,
    publisher: pipeline.publisher,
    ctx: pipeline.ctx,
    storage: pipeline.storage,
    cipher: pipeline.cipher,
    connectors: pipeline.connectors,
    scheduler,
    redis,
    logger,
    config: {
      defaultModel: env.GEMINI_MODEL,
      minConfidence: env.AI_MIN_CONFIDENCE,
      appUrl: env.APP_URL,
      handoffReminderMin: env.HANDOFF_ESCALATE_AFTER_MIN,
    },
    larkFallback,
  };
  return { enabled: llm !== null, deps, larkFallback };
}

/**
 * Hook PipelineDeps.onCustomerMessageStored: lên lịch job trả lời (debounce). Tự bắt lỗi (chỉ log warn,
 * không log nội dung) để pipeline tin đến không bao giờ hỏng vì chatbot. `typing` có (worker truyền ai.deps) ⇒
 * bật chỉ báo "đang soạn tin" ngay khi lên lịch (mark_seen + typing_on cho khách, 'ai.typing' cho hộp thư),
 * không đợi hết độ trễ gom tin.
 */
export function createCustomerMessageHook(
  db: Db,
  redis: DebounceRedis,
  scheduler: AiJobScheduler,
  logger: Pick<PipelineLogger, 'warn' | 'debug'>,
  schedule: typeof maybeScheduleChatbotReply = maybeScheduleChatbotReply,
  typing?: EarlyTypingDeps,
): (event: CustomerMessageStoredEvent) => Promise<void> {
  return async ({ conversationId }) => {
    try {
      const scheduled = typing
        ? await schedule(db, redis, scheduler, conversationId, undefined, typing)
        : await schedule(db, redis, scheduler, conversationId);
      if (scheduled) logger.debug({ conversationId }, 'Đã lên lịch chatbot trả lời');
    } catch (error) {
      logger.warn({ conversationId, err: error }, 'Không lên lịch được chatbot trả lời');
    }
  };
}

/** ioredis ⇒ DebounceRedis (set của ioredis là overload nên không gán thẳng được). */
export function toDebounceRedis(redis: Redis): DebounceRedis {
  return {
    get: (key) => redis.get(key),
    set: (key, value, ...args) => redis.call('SET', key, value, ...args),
    del: (...keys) => redis.del(...keys),
  };
}

/** Chu kỳ quét tin bot 'queued' bị bỏ rơi. */
export const BOT_OUTBOUND_SWEEP_INTERVAL_MS = 60_000;
/** Tin bot 'queued' lâu hơn chừng này (giây) mới bị coi là mất job outbound. */
export const BOT_OUTBOUND_SWEEP_MIN_AGE_SEC = 60;

/**
 * Sweeper rẻ cho tin bot 'queued' quá BOT_OUTBOUND_SWEEP_MIN_AGE_SEC giây (worker chết giữa commit và
 * enqueue): mỗi chu kỳ requeueQueuedBotMessages (jobId outbound cố định ⇒ lặp/nhiều worker đều an toàn).
 * Dùng setInterval (unref) thay vì job lặp của BullMQ để không phải sửa processor; lỗi chỉ log warn.
 * Trả hàm dừng.
 */
export function startBotOutboundSweeper(
  db: Db,
  scheduler: Pick<AiJobScheduler, 'enqueueOutbound'>,
  logger: Pick<PipelineLogger, 'warn'>,
  intervalMs: number = BOT_OUTBOUND_SWEEP_INTERVAL_MS,
  requeue: typeof requeueQueuedBotMessages = requeueQueuedBotMessages,
): { sweep: () => Promise<number>; stop: () => void } {
  let running = false;
  const sweep = async (): Promise<number> => {
    if (running) return 0;
    running = true;
    try {
      const n = await requeue(db, scheduler, { minAgeSec: BOT_OUTBOUND_SWEEP_MIN_AGE_SEC });
      if (n > 0) logger.warn({ requeued: n }, 'Sweeper: xếp hàng lại tin bot chưa gửi');
      return n;
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'Sweeper tin bot lỗi');
      return 0;
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void sweep(), intervalMs);
  timer.unref();
  return { sweep, stop: () => clearInterval(timer) };
}

/** Cờ ai-dirty (SET EX) — dùng làm markDirty của scheduler. */
export function createDirtyMarker(redis: DebounceRedis): (conversationId: string) => Promise<void> {
  return async (conversationId) => {
    await redis.set(aiDirtyKey(conversationId), '1', 'EX', AI_DIRTY_TTL_SEC);
  };
}

/** deps.scheduler / deps.redis dùng cho hook pipeline. */
export interface AiRuntime extends BuiltAiDeps {
  close: () => Promise<void>;
}

/**
 * Mở kết nối Redis riêng cho chatbot (Queue ai-reply + outbound để đẩy job, lệnh GET/SET/DEL debounce) và
 * dựng AiRuntimeDeps. Queue ở đây độc lập với Queue của startWorkerApp (pipeline runtime tạo trước app).
 */
export function createAiRuntime(
  env: AiEnv & Pick<Env, 'REDIS_URL'>,
  pipeline: BuildAiDepsInput['pipeline'],
  logger: PipelineLogger,
): AiRuntime {
  const redis = createRedisConnection(env.REDIS_URL, { connectionName: 'dezon-worker:ai' });
  redis.on('error', (error) => logger.warn({ err: error }, 'Lỗi kết nối Redis (chatbot AI)'));
  const aiReplyQueue = createQueue(QUEUE_NAMES.aiReply, redis);
  const outboundQueue = createQueue(QUEUE_NAMES.outbound, redis);
  for (const queue of [aiReplyQueue, outboundQueue]) {
    queue.on('error', (error) => logger.warn({ queue: queue.name, err: error }, 'Lỗi queue (chatbot AI)'));
  }
  const debounceRedis = toDebounceRedis(redis);
  const scheduler = createBullAiJobScheduler({
    aiReplyQueue,
    outboundQueue,
    logger,
    markDirty: createDirtyMarker(debounceRedis),
  });
  const built = buildAiRuntimeDeps({ env, pipeline, scheduler, redis: debounceRedis, logger });

  return {
    ...built,
    close: async () => {
      await Promise.allSettled([aiReplyQueue.close(), outboundQueue.close()]);
      await closeRedis(redis);
    },
  };
}
