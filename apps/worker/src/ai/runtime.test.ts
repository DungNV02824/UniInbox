import {
  LlmError,
  noopPublisher,
  type AiJobScheduler,
  type DebounceRedis,
  type EarlyTypingDeps,
  type LlmClient,
} from '@dezon/core';
import type { Db } from '@dezon/db';
import { describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '../logger';
import {
  buildAiRuntimeDeps,
  createCustomerMessageHook,
  createDirtyMarker,
  startBotOutboundSweeper,
  createLlmClient,
  larkFallbackFromEnv,
  runAdGreetingEchoRepair,
  type BuildAiDepsInput,
} from './runtime';

const env: BuildAiDepsInput['env'] = {
  AI_PROVIDER: 'gemini',
  GEMINI_API_KEY: 'test-key',
  GEMINI_MODEL: 'gemini-2.5-flash',
  AI_MIN_CONFIDENCE: 0.6,
  APP_URL: 'http://localhost:3100',
  HANDOFF_ESCALATE_AFTER_MIN: 15,
  LARK_WEBHOOK_URL: undefined,
  LARK_WEBHOOK_SECRET: undefined,
};

const fakeLlm: LlmClient = { generate: vi.fn() };
const scheduler: AiJobScheduler = {
  scheduleReply: vi.fn(async () => undefined),
  scheduleWakeup: vi.fn(async () => undefined),
  scheduleHandoffReminder: vi.fn(async () => undefined),
  enqueueOutbound: vi.fn(async () => undefined),
};
const redis: DebounceRedis = { get: vi.fn(), set: vi.fn(), del: vi.fn() };
const pipeline: BuildAiDepsInput['pipeline'] = {
  publisher: noopPublisher,
  ctx: { now: () => new Date(), signUrl: async (k: string) => k, policy: {} } as never,
  storage: {} as never,
  cipher: {} as never,
  connectors: { messenger: { type: 'messenger', sendSenderAction: vi.fn() } as never },
};
const warnLogger = () => ({ warn: vi.fn(), debug: vi.fn() });

describe('createLlmClient', () => {
  it('có key + provider gemini ⇒ gọi factory với key', () => {
    const factory = vi.fn(() => fakeLlm);
    expect(createLlmClient(env, warnLogger(), factory)).toBe(fakeLlm);
    expect(factory).toHaveBeenCalledWith('test-key');
  });

  it('thiếu key (hoặc chỉ khoảng trắng) ⇒ null + warn, không gọi factory', () => {
    const factory = vi.fn(() => fakeLlm);
    for (const key of [undefined, '   ']) {
      const logger = warnLogger();
      expect(createLlmClient({ ...env, GEMINI_API_KEY: key }, logger, factory)).toBeNull();
      expect(logger.warn).toHaveBeenCalledOnce();
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it('provider khác gemini ⇒ null', () => {
    expect(createLlmClient({ ...env, AI_PROVIDER: 'anthropic' }, warnLogger(), () => fakeLlm)).toBeNull();
  });

  it('factory ném (core chưa sẵn sàng) ⇒ null, không làm sập worker, không log key', () => {
    const logger = warnLogger();
    const client = createLlmClient(env, logger, () => {
      throw new Error('createGeminiClient: chưa cài đặt');
    });
    expect(client).toBeNull();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('test-key');
  });
});

describe('buildAiRuntimeDeps', () => {
  it('có key ⇒ enabled, LLM thật, cấu hình từ env', () => {
    const built = buildAiRuntimeDeps({
      env,
      pipeline,
      scheduler,
      redis,
      logger: createSilentLogger(),
      llmFactory: () => fakeLlm,
    });
    expect(built.enabled).toBe(true);
    expect(built.deps.llm).toBe(fakeLlm);
    expect(built.deps.scheduler).toBe(scheduler);
    expect(built.deps.redis).toBe(redis);
    expect(built.deps.ctx).toBe(pipeline.ctx);
    expect(built.deps.publisher).toBe(noopPublisher);
    // Cùng object connectors của pipeline ⇒ runtime AI gửi được "đang soạn tin" (sender_action).
    expect(built.deps.connectors).toBe(pipeline.connectors);
    expect(built.deps.connectors?.messenger?.sendSenderAction).toBeTypeOf('function');
    expect(built.deps.config).toEqual({
      defaultModel: 'gemini-2.5-flash',
      minConfidence: 0.6,
      appUrl: 'http://localhost:3100',
      handoffReminderMin: 15,
    });
  });

  it('không có key ⇒ disabled, LLM giả luôn lỗi không thử lại', async () => {
    const factory = vi.fn(() => fakeLlm);
    const built = buildAiRuntimeDeps({
      env: { ...env, GEMINI_API_KEY: undefined },
      pipeline,
      scheduler,
      redis,
      logger: createSilentLogger(),
      llmFactory: factory,
    });
    expect(built.enabled).toBe(false);
    expect(factory).not.toHaveBeenCalled();
    const error = await built.deps.llm.generate({} as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).retryable).toBe(false);
  });
});

describe('larkFallbackFromEnv', () => {
  it('chỉ có khi LARK_WEBHOOK_URL có; secret rỗng ⇒ null', () => {
    expect(larkFallbackFromEnv({ LARK_WEBHOOK_URL: undefined, LARK_WEBHOOK_SECRET: 's' })).toBeNull();
    expect(larkFallbackFromEnv({ LARK_WEBHOOK_URL: 'https://lark/x', LARK_WEBHOOK_SECRET: ' ' })).toEqual({
      webhookUrl: 'https://lark/x',
      secret: null,
    });
    expect(larkFallbackFromEnv({ LARK_WEBHOOK_URL: 'https://lark/x', LARK_WEBHOOK_SECRET: 'sec' })).toEqual({
      webhookUrl: 'https://lark/x',
      secret: 'sec',
    });
  });
});

describe('createCustomerMessageHook', () => {
  const db = {} as Db;
  const event = { conversationId: 'c1', messageId: 'm1', source: 'webhook' as const };

  it('gọi maybeScheduleChatbotReply(db, redis, scheduler, conversationId)', async () => {
    const schedule = vi.fn(async () => true);
    await createCustomerMessageHook(db, redis, scheduler, warnLogger(), schedule)(event);
    expect(schedule).toHaveBeenCalledWith(db, redis, scheduler, 'c1');
  });

  it('có typing deps ⇒ truyền xuống để bật chỉ báo "đang soạn tin" sớm', async () => {
    const schedule = vi.fn(async () => true);
    const typing = { redis } as unknown as EarlyTypingDeps;
    await createCustomerMessageHook(db, redis, scheduler, warnLogger(), schedule, typing)(event);
    expect(schedule).toHaveBeenCalledWith(db, redis, scheduler, 'c1', undefined, typing);
  });

  it('lỗi lên lịch chỉ log warn, không ném (pipeline không hỏng)', async () => {
    const logger = warnLogger();
    const schedule = vi.fn(async () => Promise.reject(new Error('Redis down')));
    await expect(
      createCustomerMessageHook(db, redis, scheduler, logger, schedule)(event),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});

describe('startBotOutboundSweeper', () => {
  it('gọi requeue với tuổi tối thiểu 60 giây, không chạy chồng, lỗi chỉ log', async () => {
    const warn = vi.fn();
    let release: () => void = () => undefined;
    const requeue = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          release = () => resolve(2);
        }),
    );
    const sweeper = startBotOutboundSweeper({} as Db, scheduler, { warn }, 3_600_000, requeue as never);
    try {
      const first = sweeper.sweep();
      expect(await sweeper.sweep()).toBe(0); // đang chạy ⇒ bỏ qua
      release();
      expect(await first).toBe(2);
      expect(requeue).toHaveBeenCalledTimes(1);
      expect(requeue).toHaveBeenCalledWith({}, scheduler, { minAgeSec: 60 });
      expect(warn).toHaveBeenCalledWith({ requeued: 2 }, expect.any(String));

      requeue.mockImplementationOnce(() => Promise.reject(new Error('db down')));
      expect(await sweeper.sweep()).toBe(0);
      expect(warn).toHaveBeenLastCalledWith({ err: 'db down' }, expect.any(String));
    } finally {
      sweeper.stop();
    }
  });
});

describe('runAdGreetingEchoRepair', () => {
  it('log số lượng khi xong; lỗi chỉ log warn, không ném', async () => {
    const info = vi.fn();
    const warn = vi.fn();
    const result = { echoes: 3, conversations: 2, pausesReleased: 1 };
    const repair = vi.fn(async () => result);
    await runAdGreetingEchoRepair({} as Db, { info, warn }, repair as never);
    expect(repair).toHaveBeenCalledWith({});
    expect(info).toHaveBeenCalledWith(result, expect.any(String));

    repair.mockImplementationOnce(() => Promise.reject(new Error('db down')));
    await expect(runAdGreetingEchoRepair({} as Db, { info, warn }, repair as never)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith({ err: 'db down' }, expect.any(String));
  });
});

describe('createDirtyMarker', () => {
  it('SET ai-dirty:<conv> 1 EX 600', async () => {
    const set = vi.fn(async () => 'OK');
    await createDirtyMarker({ get: vi.fn(), set, del: vi.fn() })('conv-1');
    expect(set).toHaveBeenCalledWith('ai-dirty:conv-1', '1', 'EX', 600);
  });
});
