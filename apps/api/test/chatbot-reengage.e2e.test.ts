// E2E "Tái chăm sóc khách bị bỏ sót": POST /chatbots/:id/reengage/preview|start (admin).
import { AI_REPLY_JOB_NAME, aiReengageJobId, type LlmClient } from '@dezon/core';
import {
  auditLogs,
  contactIdentities,
  contacts,
  conversations,
  createDb,
  type Db,
  messages,
} from '@dezon/db';
import {
  type ChatbotDto,
  type LoginResponse,
  REENGAGE_LIMITS,
  type ReengagePreview,
  type ReengageStartResult,
} from '@dezon/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AI_REPLY_QUEUE } from '../src/infra/queue/queue.constants';
import { REENGAGE_NEXT_SLOT_KEY_SUFFIX } from '../src/modules/chatbots/chatbot-reengage.service';
import { type InboxSeed, seedInbox } from './inbox-seed';
import { ADMIN, AGENT, startInfra, type TestInfra } from './test-env';

const RANDOM_ID = '7f1c2a9e-3b4d-4c5e-8f60-112233445566';
const HOUR = 3_600_000;

/** LLM giả: preview/start không bao giờ gọi AI. */
const llmCalls: unknown[] = [];
const fakeLlm: LlmClient = {
  generate: async (req) => {
    llmCalls.push(req);
    throw new Error('Không được gọi LLM trong test tái chăm sóc');
  },
};

let infra: TestInfra;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;
let seed: InboxSeed;
let aiReply: Queue;
let adminToken: string;
let agentToken: string;

beforeAll(async () => {
  infra = await startInfra();
  seed = await seedInbox(infra.databaseUrl);
  ({ db, close: closeDb } = createDb(infra.databaseUrl, { max: 2 }));
  app = await createApp(undefined, { mediaStorage: null, llm: fakeLlm });
  aiReply = app.get(AI_REPLY_QUEUE);
  adminToken = await login(ADMIN.email, ADMIN.password);
  agentToken = await login(AGENT.email, AGENT.password);
});

afterEach(async () => {
  await aiReply.obliterate({ force: true });
  // obliterate không xóa khóa khe giãn cách chung (không phải khóa job).
  await (await aiReply.client).del(aiReply.toKey(REENGAGE_NEXT_SLOT_KEY_SUFFIX));
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  await infra?.stop();
});

async function login(email: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return res.json<LoginResponse>().accessToken;
}

const call = (token: string | null, url: string, payload?: unknown) =>
  app.inject({
    method: 'POST',
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
const asAdmin = (url: string, payload?: unknown) => call(adminToken, url, payload);

let botSeq = 0;
async function createBot(extra: Record<string, unknown> = {}): Promise<ChatbotDto> {
  const res = await app.inject({
    method: 'POST',
    url: '/chatbots',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: `Bot tái chăm sóc ${++botSeq}`, ...extra },
  });
  expect(res.statusCode).toBe(201);
  return res.json<ChatbotDto>();
}

let psidSeq = 0;
/** Hội thoại trên Fanpage mẫu (Messenger) gắn bot, khách nhắn cách đây `agoMs`, chưa ai trả lời. */
async function missedConversation(chatbotId: string, agoMs: number, name = 'Anh Minh'): Promise<string> {
  const at = new Date(Date.now() - agoMs);
  const [contact] = await db.insert(contacts).values({ displayName: name }).returning({ id: contacts.id });
  const [identity] = await db
    .insert(contactIdentities)
    .values({
      contactId: contact!.id,
      channelAccountId: seed.channelId,
      externalUserId: `psid-re-${++psidSeq}`,
    })
    .returning({ id: contactIdentities.id });
  const [conv] = await db
    .insert(conversations)
    .values({
      contactId: contact!.id,
      channelAccountId: seed.channelId,
      contactIdentityId: identity!.id,
      chatbotId,
      aiMode: 'auto',
      lastCustomerMessageAt: at,
      lastMessageAt: at,
    })
    .returning({ id: conversations.id });
  await db.insert(messages).values({
    conversationId: conv!.id,
    channelAccountId: seed.channelId,
    senderType: 'customer',
    text: 'Sofa góc còn màu xám không shop?',
    sentAt: at,
  });
  return conv!.id;
}

const previewUrl = (id: string) => `/chatbots/${id}/reengage/preview`;
const startUrl = (id: string) => `/chatbots/${id}/reengage/start`;

describe('phân quyền và kiểm tra đầu vào', () => {
  it('agent ⇒ 403, chưa đăng nhập ⇒ 401', async () => {
    for (const [url, body] of [
      [previewUrl(RANDOM_ID), { days: 15 }],
      [startUrl(RANDOM_ID), { days: 15, conversationIds: [RANDOM_ID] }],
    ] as const) {
      expect((await call(agentToken, url, body)).statusCode).toBe(403);
      expect((await call(null, url, body)).statusCode).toBe(401);
    }
  });

  it('bot không có ⇒ 404; id/body sai ⇒ 400; bot tắt ⇒ 400', async () => {
    expect((await asAdmin(previewUrl(RANDOM_ID), { days: 15 })).statusCode).toBe(404);
    expect((await asAdmin(startUrl(RANDOM_ID), { days: 15, conversationIds: [RANDOM_ID] })).statusCode).toBe(
      404,
    );
    expect((await asAdmin(previewUrl('abc'), { days: 15 })).statusCode).toBe(400);

    const bot = await createBot();
    for (const body of [{}, { days: 0 }, { days: REENGAGE_LIMITS.daysMax + 1 }, { days: 1.5 }]) {
      expect((await asAdmin(previewUrl(bot.id), body)).statusCode).toBe(400);
    }
    const tooMany = Array.from(
      { length: REENGAGE_LIMITS.maxPerRun + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    for (const body of [
      { days: 15 },
      { days: 15, conversationIds: [] },
      { days: 15, conversationIds: ['abc'] },
      { days: 15, conversationIds: tooMany },
    ]) {
      expect((await asAdmin(startUrl(bot.id), body)).statusCode).toBe(400);
    }

    const inactive = await createBot({ isActive: false });
    const res = await asAdmin(previewUrl(inactive.id), { days: 15 });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toContain('Chatbot đang tắt');
  });
});

describe('tái chăm sóc', () => {
  it('preview liệt kê khách bị bỏ sót; start kiểm lại id, xếp job riêng có giãn cách, ghi audit, không gọi AI', async () => {
    const bot = await createBot();
    const fresh = await missedConversation(bot.id, 2 * HOUR, 'Chị Hoa');
    const fresh2 = await missedConversation(bot.id, 3 * HOUR, 'Anh Nam');
    const stale = await missedConversation(bot.id, 30 * HOUR, 'Anh Bình');

    const res = await asAdmin(previewUrl(bot.id), { days: 15 });
    expect(res.statusCode).toBe(200);
    const preview = res.json<ReengagePreview>();
    expect(preview).toMatchObject({ days: 15, truncated: false, alreadyQueued: 0 });
    expect(preview.eligible.map((i) => i.conversationId)).toEqual([fresh, fresh2]);
    expect(preview.eligible[0]).toMatchObject({
      contactName: 'Chị Hoa',
      channelName: 'Dezon Sofa',
      channelType: 'messenger',
      waitingMessages: 1,
      lastCustomerText: 'Sofa góc còn màu xám không shop?',
    });
    expect(preview.outsideWindow.map((i) => i.conversationId)).toEqual([stale]);
    expect(preview.outsideWindow[0]!.reason).toContain('24 giờ');

    const startRes = await asAdmin(startUrl(bot.id), {
      days: 15,
      conversationIds: [fresh, stale, fresh2, RANDOM_ID],
    });
    expect(startRes.statusCode).toBe(200);
    const started = startRes.json<ReengageStartResult>();
    expect(started).toMatchObject({
      queued: 2,
      alreadyQueued: 0,
      skipped: 2,
      spacingSec: REENGAGE_LIMITS.spacingSec,
      estimatedMinutes: 1,
      startsInMinutes: 0,
    });
    // Khung 24 giờ đã đóng ⇒ trả lại cho nhân viên kèm lý do.
    expect(started.outsideWindow.map((i) => i.conversationId)).toEqual([stale]);

    const job1 = await aiReply.getJob(aiReengageJobId(fresh));
    const job2 = await aiReply.getJob(aiReengageJobId(fresh2));
    expect(job1?.name).toBe(AI_REPLY_JOB_NAME);
    expect(job1?.data).toMatchObject({
      conversationId: fresh,
      reengage: { pendingMaxAgeHours: 15 * 24, chatbotId: bot.id },
    });
    // Khung gửi đóng sớm nhất trước: fresh2 (tin khách cũ hơn ⇒ khung 24 giờ đóng sớm hơn) lên trước dù gửi sau.
    expect(job2?.opts.delay ?? 0).toBe(0);
    expect(job1?.opts.delay).toBe(REENGAGE_LIMITS.spacingSec * 1000);
    expect(await aiReply.getJob(aiReengageJobId(stale))).toBeUndefined();
    // Không đụng khe debounce/đánh thức của hội thoại.
    expect(await aiReply.getJob(`ai-${fresh}`)).toBeUndefined();

    // "Kiểm tra lại" khi job còn chờ ⇒ hai khách đã xếp hàng không còn trong eligible.
    const recheck = (await asAdmin(previewUrl(bot.id), { days: 15 })).json<ReengagePreview>();
    expect(recheck.eligible).toEqual([]);
    expect(recheck.alreadyQueued).toBe(2);

    // Bấm lại khi job còn chờ ⇒ không tạo job trùng, báo alreadyQueued (không đếm là đã xếp).
    const again = await asAdmin(startUrl(bot.id), { days: 15, conversationIds: [fresh] });
    expect(again.json<ReengageStartResult>()).toMatchObject({
      queued: 0,
      alreadyQueued: 1,
      skipped: 0,
      estimatedMinutes: 0,
    });
    expect(await aiReply.getJobCounts('delayed', 'waiting')).toMatchObject({ delayed: 1, waiting: 1 });

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'chatbot.reengage'), eq(auditLogs.entityId, bot.id)));
    expect(audits.map((a) => a.data)).toEqual(
      expect.arrayContaining([
        { days: 15, requested: 4, queued: 2, alreadyQueued: 0, skipped: 2 },
        { days: 15, requested: 1, queued: 0, alreadyQueued: 1, skipped: 0 },
      ]),
    );
    expect(llmCalls).toHaveLength(0);
  });

  it('lần bấm sau (bot khác / sau "Kiểm tra lại") nối tiếp sau các job còn chờ trong MỘT hàng giãn cách (Redis)', async () => {
    const spacingMs = REENGAGE_LIMITS.spacingSec * 1000;
    const bot1 = await createBot();
    const bot2 = await createBot();
    const a1 = await missedConversation(bot1.id, 2 * HOUR, 'Chị Mai');
    const a2 = await missedConversation(bot1.id, 2 * HOUR, 'Chị Thu');
    const b1 = await missedConversation(bot2.id, 2 * HOUR, 'Anh Tuấn');

    const first = await asAdmin(startUrl(bot1.id), { days: 15, conversationIds: [a1, a2] });
    expect(first.json<ReengageStartResult>()).toMatchObject({
      queued: 2,
      startsInMinutes: 0,
      estimatedMinutes: 1,
    });
    const second = await asAdmin(startUrl(bot2.id), { days: 15, conversationIds: [b1] });
    expect(second.json<ReengageStartResult>()).toMatchObject({
      queued: 1,
      startsInMinutes: 1,
      estimatedMinutes: 1,
    });

    // Khe thứ ba của hàng chung: ≈ 2 × spacing sau lần bấm đầu (trừ thời gian giữa hai lần gọi), không phải 0.
    const delays = await Promise.all(
      [a1, a2, b1].map(async (id) => (await aiReply.getJob(aiReengageJobId(id)))?.opts.delay ?? 0),
    );
    expect(delays[0]! + delays[1]!).toBe(spacingMs);
    expect(delays[2]).toBeGreaterThan(2 * spacingMs - 10_000);
    expect(delays[2]).toBeLessThanOrEqual(2 * spacingMs);
  });
});
