// E2E nút "Bật lại AI": GET /ai/outage, POST /ai/outage/resume (mọi nhân viên; bật công tắc AI chung chỉ admin).
import {
  AI_AUTO_RESUME_JOB_NAME,
  AI_MANUAL_RESUME_JOB_ID,
  LlmError,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
} from '@dezon/core';
import {
  auditLogs,
  contactIdentities,
  contacts,
  conversations,
  createDb,
  type Db,
  handoffs,
  messages,
} from '@dezon/db';
import type { AiOutageResumeResponse, AiOutageStatus, ChatbotDto, LoginResponse } from '@dezon/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Queue } from 'bullmq';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AI_REPLY_QUEUE } from '../src/infra/queue/queue.constants';
import { type InboxSeed, seedInbox } from './inbox-seed';
import { ADMIN, AGENT, startInfra, type TestInfra } from './test-env';

const MIN = 60_000;
const BILLING =
  'Gemini HTTP 402: Your prepayment credits are depleted. Please go to AI Studio to manage your billing.';
const okResponse = (req: LlmRequest): LlmResponse => ({
  functionCall: { name: 'no_reply', args: { reason: 'ok' } },
  text: null,
  usage: { inputTokens: 5, outputTokens: 1 },
  model: req.model,
});

/** LLM giả: mặc định gọi thử được; test đổi `llmImpl` để giả AI vẫn lỗi. */
const llmCalls: LlmRequest[] = [];
let llmImpl: (req: LlmRequest) => Promise<LlmResponse> = async (req) => okResponse(req);
const fakeLlm: LlmClient = {
  generate: async (req) => {
    llmCalls.push(req);
    return llmImpl(req);
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

beforeEach(async () => {
  llmCalls.length = 0;
  llmImpl = async (req) => okResponse(req);
  // Mỗi test tự tạo dữ liệu: đóng handoff còn mở, bỏ bot khỏi hội thoại cũ, bật công tắc AI.
  await db.update(handoffs).set({ resolvedAt: new Date() }).where(isNull(handoffs.resolvedAt));
  await db.update(conversations).set({ chatbotId: null, status: 'open' });
  expect((await putAi(adminToken, true)).statusCode).toBe(200);
});

afterEach(async () => {
  await aiReply.obliterate({ force: true });
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

const auth = (token: string | null) => (token ? { authorization: `Bearer ${token}` } : {});
const getStatus = (token: string | null) =>
  app.inject({ method: 'GET', url: '/ai/outage', headers: auth(token) });
const postResume = (token: string | null) =>
  app.inject({ method: 'POST', url: '/ai/outage/resume', headers: auth(token) });
const putAi = (token: string, enabled: boolean) =>
  app.inject({ method: 'PUT', url: '/settings/ai', headers: auth(token), payload: { enabled } });

let botSeq = 0;
async function createBot(extra: Record<string, unknown> = {}): Promise<ChatbotDto> {
  const res = await app.inject({
    method: 'POST',
    url: '/chatbots',
    headers: auth(adminToken),
    payload: { name: `Bot bật lại AI ${++botSeq}`, ...extra },
  });
  expect(res.statusCode).toBe(201);
  return res.json<ChatbotDto>();
}

let psidSeq = 0;
/** Hội thoại trên Fanpage mẫu gắn bot, khách nhắn cách đây `agoMs`. */
async function botConversation(
  chatbotId: string,
  agoMs: number,
  extra: Partial<typeof conversations.$inferInsert> = {},
): Promise<string> {
  const at = new Date(Date.now() - agoMs);
  const [contact] = await db.insert(contacts).values({ displayName: 'Khách' }).returning({ id: contacts.id });
  const [identity] = await db
    .insert(contactIdentities)
    .values({
      contactId: contact!.id,
      channelAccountId: seed.channelId,
      externalUserId: `psid-ai-${++psidSeq}`,
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
      ...extra,
    })
    .returning({ id: conversations.id });
  await db.insert(messages).values({
    conversationId: conv!.id,
    channelAccountId: seed.channelId,
    senderType: 'customer',
    text: 'Báo giá sofa giúp em',
    sentAt: at,
  });
  return conv!.id;
}

/** Hội thoại "Cần người" vì AI lỗi (handoff auto_resume). */
async function outageConversation(chatbotId: string): Promise<string> {
  const id = await botConversation(chatbotId, 10 * MIN, { status: 'pending_human', aiMode: 'off' });
  await db.insert(handoffs).values({
    conversationId: id,
    reasonCode: 'other',
    summary: `Lỗi gọi AI: ${BILLING}`,
    createdBy: 'ai',
    autoResume: true,
  });
  return id;
}

describe('GET /ai/outage', () => {
  it('chưa đăng nhập ⇒ 401; nhân viên xem được số hội thoại chờ (mỗi hội thoại đếm một lần) và bị bỏ sót', async () => {
    expect((await getStatus(null)).statusCode).toBe(401);
    expect((await postResume(null)).statusCode).toBe(401);
    expect((await getStatus(agentToken)).json<AiOutageStatus>()).toEqual({
      aiEnabled: true,
      waiting: 0,
      missed: 0,
    });

    const bot = await createBot();
    const outage = await outageConversation(bot.id);
    // Thêm handoff lỗi AI thứ hai trên cùng hội thoại ⇒ vẫn đếm 1.
    await db.insert(handoffs).values({
      conversationId: outage,
      reasonCode: 'other',
      summary: 'Lỗi gọi AI: thêm',
      createdBy: 'ai',
      autoResume: true,
    });
    await botConversation(bot.id, 30 * MIN); // bị bỏ sót
    await botConversation(bot.id, 2 * MIN); // mới nhắn — bot còn đang debounce, chưa tính
    const res = await getStatus(agentToken);
    expect(res.statusCode).toBe(200);
    expect(res.json<AiOutageStatus>()).toEqual({ aiEnabled: true, waiting: 1, missed: 1 });
    expect(llmCalls).toHaveLength(0);
  });
});

describe('POST /ai/outage/resume', () => {
  it('không có gì để làm (AI đang bật, không ai chờ) ⇒ 409', async () => {
    const res = await postResume(agentToken);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ message: string }>().message).toContain('không có hội thoại nào');
    expect(await aiReply.getJob(AI_MANUAL_RESUME_JOB_ID)).toBeUndefined();
  });

  it('AI vẫn lỗi (gọi thử hỏng) ⇒ 409 kèm lỗi dễ hiểu, không đẩy job', async () => {
    const bot = await createBot();
    await outageConversation(bot.id);
    llmImpl = async () => {
      throw new LlmError(BILLING, false, 402);
    };
    const res = await postResume(agentToken);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ message: string }>().message).toBe(
      'AI vẫn chưa hoạt động lại: hết hạn mức / chưa nạp tiền Gemini',
    );
    expect(await aiReply.getJob(AI_MANUAL_RESUME_JOB_ID)).toBeUndefined();
  });

  it('nhân viên bấm, AI hoạt động ⇒ gọi thử mọi model, đẩy MỘT job manual (bấm lại không xếp trùng)', async () => {
    const bot = await createBot();
    const other = await createBot({ model: 'gemini-2.5-pro' });
    await outageConversation(bot.id);
    await botConversation(other.id, 30 * MIN);
    const res = await postResume(agentToken);
    expect(res.statusCode).toBe(200);
    expect(res.json<AiOutageResumeResponse>()).toEqual({
      enabledNow: false,
      waiting: 1,
      missed: 1,
      queued: true,
    });
    expect(llmCalls.map((c) => c.model).sort()).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro']);
    const job = await aiReply.getJob(AI_MANUAL_RESUME_JOB_ID);
    expect(job?.name).toBe(AI_AUTO_RESUME_JOB_NAME);
    expect(job?.data).toEqual({ manual: true, actorUserId: seed.agentId });
    expect(job?.opts).toMatchObject({ removeOnComplete: true, removeOnFail: true });

    expect((await postResume(agentToken)).statusCode).toBe(200);
    expect(await aiReply.getJobCounts('waiting', 'delayed', 'active')).toMatchObject({ waiting: 1 });
  });

  it('công tắc AI chung đang tắt: nhân viên ⇒ 403; admin + AI vẫn lỗi ⇒ 409, công tắc vẫn tắt', async () => {
    const bot = await createBot();
    await outageConversation(bot.id);
    expect((await putAi(adminToken, false)).statusCode).toBe(200);
    expect((await getStatus(agentToken)).json<AiOutageStatus>()).toMatchObject({ aiEnabled: false });

    const agentRes = await postResume(agentToken);
    expect(agentRes.statusCode).toBe(403);
    expect(agentRes.json<{ message: string }>().message).toBe(
      'Chỉ quản trị viên bật lại được AI toàn hệ thống',
    );
    expect(llmCalls).toHaveLength(0);

    llmImpl = async () => {
      throw new LlmError('Gemini HTTP 429: Resource has been exhausted (e.g. check quota).', true, 429);
    };
    const failed = await postResume(adminToken);
    expect(failed.statusCode).toBe(409);
    expect(failed.json<{ message: string }>().message).toContain('AI vẫn chưa hoạt động lại');
    expect((await getStatus(adminToken)).json<AiOutageStatus>().aiEnabled).toBe(false);
    expect(await aiReply.getJob(AI_MANUAL_RESUME_JOB_ID)).toBeUndefined();
  });

  it('công tắc tắt, không hội thoại nào chờ: admin bấm ⇒ gọi thử model mặc định, bật công tắc (audit settings.ai), đẩy job', async () => {
    expect((await putAi(adminToken, false)).statusCode).toBe(200);
    const res = await postResume(adminToken);
    expect(res.statusCode).toBe(200);
    expect(res.json<AiOutageResumeResponse>()).toEqual({
      enabledNow: true,
      waiting: 0,
      missed: 0,
      queued: true,
    });
    expect(llmCalls.map((c) => c.model)).toEqual(['gemini-2.5-flash']);
    expect((await getStatus(agentToken)).json<AiOutageStatus>().aiEnabled).toBe(true);
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'settings.ai'), eq(auditLogs.userId, seed.adminId)))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    expect(audit!.data).toEqual({ enabled: true });
    expect((await aiReply.getJob(AI_MANUAL_RESUME_JOB_ID))?.data).toEqual({
      manual: true,
      actorUserId: seed.adminId,
    });
  });
});
