import type { Db } from '@dezon/db';
import { ROOM_ADMINS, ROOM_UNASSIGNED } from '@dezon/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelConnector, ResolvedChannelAccount } from '../connectors/types';
import {
  aiTypingOwnerKey,
  createSenderActionQueue,
  EARLY_TYPING_TOKEN_PREFIX,
  releaseEarlyAiTyping,
  startAiTyping,
  startEarlyAiTyping,
  TYPING_REFRESH_MS,
  type AiTypingDeps,
  type AiTypingRedis,
} from './typing';

const ACCOUNT_ROW = {
  id: 'acc-1',
  type: 'messenger',
  externalId: 'page-1',
  credentials: { enc: JSON.stringify({ pageAccessToken: 'tok' }) },
};

/** Db giả cho loadResolvedAccount: select().from().where() ⇒ [row]. */
function fakeDb(row: unknown = ACCOUNT_ROW, delayMs = 0): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => new Promise((resolve) => setTimeout(() => resolve(row ? [row] : []), delayMs)),
      }),
    }),
  } as unknown as Db;
}

function setup(connector?: Partial<ChannelConnector>) {
  const actions: string[] = [];
  const events: { rooms: string[]; event: string; payload: unknown }[] = [];
  const debug = vi.fn();
  const deps: AiTypingDeps = {
    publisher: { emit: (rooms, event, payload) => events.push({ rooms, event, payload }) },
    cipher: { encryptJson: JSON.stringify, decryptJson: <T>(s: string) => JSON.parse(s) as T },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug },
    connectors: {
      messenger: {
        type: 'messenger',
        async sendSenderAction(_a, _to, action) {
          actions.push(action);
        },
        ...connector,
      } as ChannelConnector,
    },
  };
  return { deps, actions, events, debug };
}

/** Redis trong bộ nhớ (get/set/del) — đủ cho khóa chủ sở hữu chỉ báo. */
function memoryRedis(): AiTypingRedis & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value, ...args) {
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

const target = {
  conversationId: 'conv-1',
  assignedUserId: null,
  channelType: 'messenger' as const,
  channelAccountId: 'acc-1',
  externalUserId: 'psid-1',
  chatbotName: 'Bot A',
};

afterEach(() => {
  vi.useRealTimers();
});

describe('startAiTyping', () => {
  it('phát typing true ngay; mark_seen → typing_on; stop(reply) không typing_off', async () => {
    const { deps, actions, events } = setup();
    const session = startAiTyping(fakeDb(), deps, target);
    expect(events).toEqual([
      {
        rooms: [ROOM_ADMINS, ROOM_UNASSIGNED],
        event: 'ai.typing',
        payload: { conversationId: 'conv-1', typing: true, chatbotName: 'Bot A' },
      },
    ]);
    await vi.waitFor(() => expect(actions).toEqual(['mark_seen', 'typing_on']));
    await session.stop({ botReplyQueued: true });
    await session.stop({ botReplyQueued: false }); // gọi lại: không làm gì
    await session.idle();
    expect(actions).toEqual(['mark_seen', 'typing_on']);
    expect(events.map((e) => (e.payload as { typing: boolean }).typing)).toEqual([true, false]);
  });

  it('typing_off luôn sau typing_on đã gửi', async () => {
    const { deps, actions } = setup();
    const session = startAiTyping(fakeDb(ACCOUNT_ROW, 30), deps, target);
    await vi.waitFor(() => expect(actions).toEqual(['mark_seen', 'typing_on']));
    session.stop({ botReplyQueued: false });
    await session.idle();
    expect(actions).toEqual(['mark_seen', 'typing_on', 'typing_off']);
  });

  it('stop khi mark_seen/typing_on chưa kịp gửi ⇒ bỏ chúng (không đến sau tin bot); typing_off vẫn gửi', async () => {
    for (const botReplyQueued of [true, false]) {
      const { deps, actions } = setup();
      const session = startAiTyping(fakeDb(ACCOUNT_ROW, 30), deps, target);
      await session.stop({ botReplyQueued });
      await session.idle();
      expect(actions).toEqual(botReplyQueued ? [] : ['typing_off']);
    }
  });

  it('typing_on đang gửi dở thì vẫn xong, các action chờ phía sau bị bỏ', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { deps, actions } = setup({
      async sendSenderAction(_a, _to, action) {
        if (action === 'mark_seen') await gate;
        actions.push(action);
      },
    });
    const session = startAiTyping(fakeDb(), deps, target);
    await new Promise((r) => setTimeout(r, 10)); // mark_seen đang gửi, typing_on chờ phía sau
    await session.stop({ botReplyQueued: true });
    release();
    await session.idle();
    expect(actions).toEqual(['mark_seen']);
  });

  it(`gửi lại typing_on mỗi ${TYPING_REFRESH_MS} ms tới khi stop`, async () => {
    vi.useFakeTimers();
    const { deps, actions } = setup();
    const session = startAiTyping(fakeDb(), deps, target);
    await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS * 2 + 10);
    void session.stop({ botReplyQueued: true });
    await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS * 3);
    await session.idle();
    expect(actions).toEqual(['mark_seen', 'typing_on', 'typing_on', 'typing_on']);
  });

  it('lỗi sender_action chỉ log debug (không kèm token), hàng đợi vẫn chạy tiếp', async () => {
    let n = 0;
    const { deps, debug } = setup({
      async sendSenderAction() {
        n++;
        throw new Error('Graph lỗi');
      },
    });
    const session = startAiTyping(fakeDb(), deps, target);
    await vi.waitFor(() => expect(n).toBe(2));
    session.stop({ botReplyQueued: false });
    await session.idle();
    expect(n).toBe(3);
    expect(debug).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(debug.mock.calls)).not.toContain('tok');
  });

  it('không có connector / không hỗ trợ / không có PSID / không có tài khoản ⇒ chỉ phát realtime', async () => {
    for (const variant of ['none', 'noMethod', 'noPsid', 'noAccount'] as const) {
      const { deps, actions, events } = setup();
      if (variant === 'none') deps.connectors = {};
      if (variant === 'noMethod') deps.connectors = { messenger: { type: 'messenger' } as ChannelConnector };
      const session = startAiTyping(
        fakeDb(variant === 'noAccount' ? null : ACCOUNT_ROW),
        deps,
        variant === 'noPsid' ? { ...target, externalUserId: null } : target,
      );
      session.stop({ botReplyQueued: false });
      await session.idle();
      expect(actions).toEqual([]);
      expect(events.map((e) => (e.payload as { typing: boolean }).typing)).toEqual([true, false]);
    }
  });
});

describe('chủ sở hữu chỉ báo (hai job chồng nhau)', () => {
  it('job cũ kết thúc sau khi job mới bắt đầu ⇒ không typing:false / typing_off; job mới tắt bình thường', async () => {
    const { deps, actions, events } = setup();
    const redis = memoryRedis();
    deps.redis = redis;
    const a = startAiTyping(fakeDb(), deps, target);
    await vi.waitFor(() => expect(actions).toEqual(['mark_seen', 'typing_on']));
    const b = startAiTyping(fakeDb(), deps, target);
    await vi.waitFor(() => expect(actions).toHaveLength(4));
    await a.stop({ botReplyQueued: false }); // vd. bị hủy vì khách nhắn thêm
    await a.idle();
    expect(events.map((e) => (e.payload as { typing: boolean }).typing)).toEqual([true, true]);
    expect(actions).not.toContain('typing_off');
    expect(redis.store.has(aiTypingOwnerKey('conv-1'))).toBe(true);

    await b.stop({ botReplyQueued: false });
    await b.idle();
    expect(events.map((e) => (e.payload as { typing: boolean }).typing)).toEqual([true, true, false]);
    expect(actions.at(-1)).toBe('typing_off');
    expect(redis.store.size).toBe(0);
  });

  it('job cũ không làm mới typing_on khi job mới đã giữ chỉ báo', async () => {
    vi.useFakeTimers();
    const { deps, actions } = setup();
    deps.redis = memoryRedis();
    const a = startAiTyping(fakeDb(), deps, target);
    await vi.advanceTimersByTimeAsync(10);
    const b = startAiTyping(fakeDb(), deps, target);
    await vi.advanceTimersByTimeAsync(10);
    void b.stop({ botReplyQueued: true }); // b xong (có tin bot), khóa trống ⇒ a lại giữ
    const c = startAiTyping(fakeDb(), deps, target); // job mới hơn nữa giữ khóa
    await vi.advanceTimersByTimeAsync(10);
    const before = actions.length;
    await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS + 10);
    // Chỉ c làm mới (a không còn giữ khóa).
    expect(actions.length - before).toBe(1);
    void a.stop({ botReplyQueued: true });
    void c.stop({ botReplyQueued: true });
    await vi.advanceTimersByTimeAsync(10);
  });

  it('Redis lỗi ⇒ vẫn phát true/false và gửi typing_off (không ném)', async () => {
    const { deps, actions, events, debug } = setup();
    const boom = async () => {
      throw new Error('redis down');
    };
    deps.redis = { get: boom, set: boom, del: boom };
    const s = startAiTyping(fakeDb(), deps, target);
    await vi.waitFor(() => expect(actions).toEqual(['mark_seen', 'typing_on']));
    await s.stop({ botReplyQueued: false });
    await s.idle();
    expect(events.map((e) => (e.payload as { typing: boolean }).typing)).toEqual([true, false]);
    expect(actions).toEqual(['mark_seen', 'typing_on', 'typing_off']);
    expect(debug).toHaveBeenCalled();
  });
});

describe('createSenderActionQueue', () => {
  it('dùng tài khoản đã tải sẵn (không truy vấn DB)', async () => {
    const { deps, actions } = setup();
    const db = { select: vi.fn() } as unknown as Db;
    const account: ResolvedChannelAccount = {
      id: 'acc-1',
      type: 'messenger',
      externalId: 'page-1',
      credentials: { pageAccessToken: 'tok' },
    };
    const queue = createSenderActionQueue(db, deps, target, account);
    queue!.push('typing_on');
    await queue!.idle();
    expect(actions).toEqual(['typing_on']);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('chỉ báo sớm (hook tin khách, trước debounce)', () => {
  const typings = (events: { payload: unknown }[]) =>
    events.map((e) => (e.payload as { typing: boolean }).typing);

  it('nhận khóa NX với token early:, phát true, gửi mark_seen + typing_on; job ghi đè rồi tự tắt', async () => {
    const { deps, actions, events } = setup();
    const redis = memoryRedis();
    const early = await startEarlyAiTyping(fakeDb(), { ...deps, redis }, target, 5_000);
    expect(early.started).toBe(true);
    expect(redis.store.get(aiTypingOwnerKey('conv-1'))).toMatch(new RegExp(`^${EARLY_TYPING_TOKEN_PREFIX}`));
    expect(events[0]).toEqual({
      rooms: [ROOM_ADMINS, ROOM_UNASSIGNED],
      event: 'ai.typing',
      payload: { conversationId: 'conv-1', typing: true, chatbotName: 'Bot A' },
    });
    await early.idle();
    expect(actions).toEqual(['mark_seen', 'typing_on']);

    // Job bắt đầu: ghi đè token ⇒ stop của job tắt (không có tin bot ⇒ typing_off).
    const job = startAiTyping(fakeDb(), { ...deps, redis }, target);
    await job.stop({ botReplyQueued: false });
    await job.idle();
    expect(typings(events)).toEqual([true, true, false]);
    expect(actions.at(-1)).toBe('typing_off');
    expect(redis.store.size).toBe(0);
  });

  it('job khác đang giữ chỉ báo ⇒ không bật (không cướp khóa, không gửi gì)', async () => {
    const { deps, actions, events } = setup();
    const redis = memoryRedis();
    redis.store.set(aiTypingOwnerKey('conv-1'), 'job-token');
    const early = await startEarlyAiTyping(fakeDb(), { ...deps, redis }, target);
    await early.idle();
    expect(early.started).toBe(false);
    expect(redis.store.get(aiTypingOwnerKey('conv-1'))).toBe('job-token');
    expect(actions).toEqual([]);
    expect(events).toEqual([]);
  });

  it('job đã nhận khóa trước khi typing_on sớm kịp gửi ⇒ bỏ typing_on sớm (không đến sau tin bot)', async () => {
    const { deps, actions } = setup();
    const redis = memoryRedis();
    const early = await startEarlyAiTyping(fakeDb(ACCOUNT_ROW, 30), { ...deps, redis }, target);
    redis.store.set(aiTypingOwnerKey('conv-1'), 'job-token'); // job vừa bắt đầu
    await early.idle();
    expect(actions).toEqual(['mark_seen']);
  });

  it('releaseEarlyAiTyping: chỉ tắt khi khóa còn là token sớm', async () => {
    const { deps, actions, events } = setup();
    const redis = memoryRedis();
    const d = { ...deps, redis };
    await (await startEarlyAiTyping(fakeDb(), d, target)).idle();
    expect(await releaseEarlyAiTyping(fakeDb(), d, target)).toBe(true);
    await vi.waitFor(() => expect(actions).toEqual(['mark_seen', 'typing_on', 'typing_off']));
    expect(typings(events)).toEqual([true, false]);
    expect(redis.store.size).toBe(0);

    // Không có khóa / khóa của job đang soạn ⇒ không làm gì.
    expect(await releaseEarlyAiTyping(fakeDb(), d, target)).toBe(false);
    redis.store.set(aiTypingOwnerKey('conv-1'), 'job-token');
    expect(await releaseEarlyAiTyping(fakeDb(), d, target)).toBe(false);
    await new Promise((r) => setTimeout(r, 10));
    expect(actions).toHaveLength(3);
    expect(typings(events)).toEqual([true, false]);
  });

  it('Redis lỗi ⇒ không bật, không ném', async () => {
    const { deps, actions, events } = setup();
    const boom = async () => {
      throw new Error('redis down');
    };
    const early = await startEarlyAiTyping(
      fakeDb(),
      { ...deps, redis: { get: boom, set: boom, del: boom } },
      target,
    );
    expect(early.started).toBe(false);
    expect(
      await releaseEarlyAiTyping(fakeDb(), { ...deps, redis: { get: boom, set: boom, del: boom } }, target),
    ).toBe(false);
    expect(actions).toEqual([]);
    expect(events).toEqual([]);
  });
});
