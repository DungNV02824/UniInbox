// Đồ giả cho test chatbot: Redis trong bộ nhớ, scheduler ghi lại lệnh, LLM giả, fetch Lark giả, publisher ghi lại.
import type { CredentialsCipher } from '../../src/channels/service';
import type { ChannelConnector } from '../../src/connectors/types';
import type { LlmClient, LlmRequest, LlmResponse } from '../../src/ai/llm';
import type { AiJobScheduler, AiRuntimeDeps, DebounceRedis } from '../../src/ai/runtime';
import type { HandoffReminderJobData } from '../../src/jobs';
import type { InboxContext } from '../../src/inbox/types';
import type { PipelineLogger } from '../../src/pipeline/types';
import type { RealtimePublisher } from '../../src/realtime';
import { createMemoryStorage, type MemoryStorage } from './memory-storage';

export interface FakeRedis extends DebounceRedis {
  store: Map<string, string>;
  setCalls: { key: string; value: string; args: (string | number)[] }[];
}

export function createFakeRedis(): FakeRedis {
  const store = new Map<string, string>();
  const setCalls: FakeRedis['setCalls'] = [];
  return {
    store,
    setCalls,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value, ...args) {
      setCalls.push({ key, value, args });
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async del(...keys) {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    },
  };
}

export interface FakeScheduler extends AiJobScheduler {
  replies: { conversationId: string; delayMs: number }[];
  reminders: { data: HandoffReminderJobData; delayMs: number }[];
  outbound: { messageId: string; delayMs: number }[];
}

export function createFakeScheduler(): FakeScheduler {
  const s: FakeScheduler = {
    replies: [],
    reminders: [],
    outbound: [],
    async scheduleReply(conversationId, delayMs) {
      s.replies.push({ conversationId, delayMs });
    },
    async scheduleHandoffReminder(data, delayMs) {
      s.reminders.push({ data, delayMs });
    },
    async enqueueOutbound(messageId, delayMs) {
      s.outbound.push({ messageId, delayMs });
    },
  };
  return s;
}

export interface FakeLlm extends LlmClient {
  calls: LlmRequest[];
  impl: (req: LlmRequest) => Promise<LlmResponse>;
}

export function llmReply(messages: string[], confidence = 0.9): LlmResponse {
  return {
    functionCall: { name: 'reply', args: { messages, confidence } },
    text: null,
    usage: { inputTokens: 120, outputTokens: 30 },
    model: 'gemini-test',
  };
}

export function createFakeLlm(): FakeLlm {
  const llm: FakeLlm = {
    calls: [],
    impl: async () => llmReply(['Dạ chào anh/chị', 'Shop có mẫu này ạ']),
    async generate(req) {
      llm.calls.push(req);
      return llm.impl(req);
    },
  };
  return llm;
}

export interface Published {
  rooms: string[];
  event: string;
  payload: unknown;
}

export function createRecordingPublisher(): RealtimePublisher & { events: Published[] } {
  const events: Published[] = [];
  return {
    events,
    emit(rooms, event, payload) {
      events.push({ rooms, event, payload });
    },
  };
}

export const silentLogger: PipelineLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

export const fakeCipher: CredentialsCipher = {
  encryptJson: (v) => JSON.stringify(v),
  decryptJson: <T>(s: string) => JSON.parse(s) as T,
};

export interface FakeLark {
  fetch: typeof fetch;
  calls: { url: string; body: Record<string, unknown> }[];
  /** HTTP status trả về (mặc định 200, body { code: 0 }). */
  status: number;
}

export function createFakeLark(): FakeLark {
  const lark: FakeLark = {
    calls: [],
    status: 200,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      lark.calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify(lark.status === 200 ? { code: 0 } : { code: 9499 }), {
        status: lark.status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  };
  return lark;
}

export interface AiTestKit {
  deps: AiRuntimeDeps;
  llm: FakeLlm;
  redis: FakeRedis;
  scheduler: FakeScheduler;
  publisher: ReturnType<typeof createRecordingPublisher>;
  storage: MemoryStorage;
  lark: FakeLark;
}

export const LARK_URL = 'https://open.larksuite.test/open-apis/bot/v2/hook/abc';

export function createAiKit(ctx: InboxContext): AiTestKit {
  const llm = createFakeLlm();
  const redis = createFakeRedis();
  const scheduler = createFakeScheduler();
  const publisher = createRecordingPublisher();
  const storage = createMemoryStorage();
  const lark = createFakeLark();
  return {
    llm,
    redis,
    scheduler,
    publisher,
    storage,
    lark,
    deps: {
      llm,
      publisher,
      ctx,
      storage,
      cipher: fakeCipher,
      scheduler,
      redis,
      logger: silentLogger,
      config: {
        defaultModel: 'gemini-default',
        minConfidence: 0.6,
        appUrl: 'https://inbox.test/',
        handoffReminderMin: 15,
      },
      larkFallback: { webhookUrl: LARK_URL, secret: null },
      fetch: lark.fetch,
      random: () => 0.5,
    },
  };
}

export interface FakeTypingConnector {
  connector: ChannelConnector;
  /** sender_action đã gửi, theo thứ tự. */
  actions: { action: string; psid: string; token: unknown }[];
  /** Ném lỗi ở mọi lần gửi sender_action. */
  fail: boolean;
}

/** Connector Messenger giả chỉ ghi lại sender_action (send/parse không dùng trong test runtime AI). */
export function createFakeTypingConnector(): FakeTypingConnector {
  const fake: FakeTypingConnector = {
    actions: [],
    fail: false,
    connector: {
      type: 'messenger',
      verifyWebhook: () => true,
      parseWebhook: async () => [],
      send: async () => ({ externalMessageId: 'm' }),
      async sendSenderAction(account, to, action) {
        if (fake.fail) throw new Error('Graph lỗi');
        fake.actions.push({ action, psid: to.externalUserId, token: account.credentials.pageAccessToken });
      },
    },
  };
  return fake;
}
