// E2E "Nhóm Lark theo chatbot": /settings/lark/groups (CRUD + Gửi thử, chỉ admin) và thẻ Lark khi bấm nút banner
// "Cần người" đi đúng nhóm của bot (không thuộc nhóm nào ⇒ nhóm chung như trước).
import { createDb, type Db, handoffs, conversations } from '@dezon/db';
import { type ChatbotDto, type LarkGroupDto, type LoginResponse } from '@dezon/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { type InboxSeed, seedInbox } from './inbox-seed';
import { ADMIN, AGENT, startInfra, type TestInfra } from './test-env';

const RANDOM_ID = '7f1c2a9e-3b4d-4c5e-8f60-112233445566';
const HOOK_A = 'https://open.larksuite.com/open-apis/bot/v2/hook/nhom-a';
const HOOK_B = 'https://open.larksuite.com/open-apis/bot/v2/hook/nhom-b';
/** LARK_WEBHOOK_URL của env = nhóm chung khi admin chưa từng lưu cấu hình Lark. */
const ENV_LARK_URL = 'https://open.larksuite.com/open-apis/bot/v2/hook/env-hook';

/** fetch giả cho webhook Lark. */
let larkReply: { status: number; body: unknown } = { status: 200, body: { code: 0, msg: 'success' } };
const larkCalls: { url: string; body: Record<string, unknown> }[] = [];
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  larkCalls.push({
    url: String(input),
    body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
  });
  return new Response(JSON.stringify(larkReply.body), {
    status: larkReply.status,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

let infra: TestInfra;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;
let seed: InboxSeed;
let adminToken: string;
let agentToken: string;

beforeAll(async () => {
  infra = await startInfra();
  process.env.LARK_WEBHOOK_URL = ENV_LARK_URL;
  seed = await seedInbox(infra.databaseUrl);
  ({ db, close: closeDb } = createDb(infra.databaseUrl, { max: 2 }));
  app = await createApp(undefined, { mediaStorage: null, llm: null, geminiModels: null, fetch: fakeFetch });
  adminToken = await login(ADMIN.email, ADMIN.password);
  agentToken = await login(AGENT.email, AGENT.password);
});

afterEach(() => {
  larkCalls.length = 0;
  larkReply = { status: 200, body: { code: 0, msg: 'success' } };
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

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const call = (token: string | null, method: Method, url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
const asAdmin = (method: Method, url: string, payload?: unknown) => call(adminToken, method, url, payload);
const asAgent = (method: Method, url: string, payload?: unknown) => call(agentToken, method, url, payload);

async function createBot(payload: Record<string, unknown>): Promise<ChatbotDto> {
  const res = await asAdmin('POST', '/chatbots', payload);
  expect(res.statusCode).toBe(201);
  return res.json<ChatbotDto>();
}

describe('phân quyền', () => {
  const ROUTES: [Method, string, unknown?][] = [
    ['GET', '/settings/lark/groups'],
    ['POST', '/settings/lark/groups', { name: 'X', webhookUrl: HOOK_A }],
    ['PATCH', `/settings/lark/groups/${RANDOM_ID}`, { name: 'Y' }],
    ['DELETE', `/settings/lark/groups/${RANDOM_ID}`],
    ['POST', `/settings/lark/groups/${RANDOM_ID}/test`],
  ];

  it.each(ROUTES)('chưa đăng nhập gọi %s %s => 401', async (method, url, payload) => {
    expect((await call(null, method, url, payload)).statusCode).toBe(401);
  });

  it.each(ROUTES)('agent gọi %s %s => 403', async (method, url, payload) => {
    expect((await asAgent(method, url, payload)).statusCode).toBe(403);
  });
});

describe('CRUD /settings/lark/groups', () => {
  it('tạo / liệt kê / sửa / Gửi thử / xóa; secret không trả ra; lỗi 400 / 404 / 502', async () => {
    const bot = await createBot({ name: 'Bot nhóm Lark' });
    expect((await asAdmin('GET', '/settings/lark/groups')).json()).toEqual([]);

    const created = await asAdmin('POST', '/settings/lark/groups', {
      name: 'Nhóm thợ',
      webhookUrl: HOOK_A,
      secret: 'bi-mat-nhom',
      chatbotIds: [bot.id],
    });
    expect(created.statusCode).toBe(201);
    const group = created.json<LarkGroupDto>();
    expect(group).toMatchObject({
      name: 'Nhóm thợ',
      webhookUrl: HOOK_A,
      hasSecret: true,
      chatbotIds: [bot.id],
    });
    expect(created.body).not.toContain('bi-mat');
    expect(typeof group.createdAt).toBe('string');

    const list = await asAdmin('GET', '/settings/lark/groups');
    expect(list.statusCode).toBe(200);
    expect(list.json<LarkGroupDto[]>()).toEqual([group]);
    expect(list.body).not.toContain('bi-mat');

    // Gửi thử: ký bằng secret của nhóm, đúng webhook của nhóm.
    const tested = await asAdmin('POST', `/settings/lark/groups/${group.id}/test`);
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toEqual({ ok: true });
    expect(larkCalls).toHaveLength(1);
    expect(larkCalls[0]!.url).toBe(HOOK_A);
    expect(larkCalls[0]!.body.sign).toEqual(expect.any(String));
    larkReply = { status: 200, body: { code: 19021, msg: 'sign match fail' } };
    const rejected = await asAdmin('POST', `/settings/lark/groups/${group.id}/test`);
    expect(rejected.statusCode).toBe(502);
    expect(rejected.json<{ message: string }>().message).toContain('sign match fail');

    const patched = await asAdmin('PATCH', `/settings/lark/groups/${group.id}`, {
      webhookUrl: HOOK_B,
      secret: null,
      chatbotIds: [],
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<LarkGroupDto>()).toMatchObject({
      webhookUrl: HOOK_B,
      hasSecret: false,
      chatbotIds: [],
    });

    // 400: body sai / id sai / bot không tồn tại / không có gì để sửa.
    expect(
      (await asAdmin('POST', '/settings/lark/groups', { name: '', webhookUrl: HOOK_A })).statusCode,
    ).toBe(400);
    expect(
      (await asAdmin('POST', '/settings/lark/groups', { name: 'X', webhookUrl: 'http://x.test/hook' }))
        .statusCode,
    ).toBe(400);
    const unknownBot = await asAdmin('POST', '/settings/lark/groups', {
      name: 'X',
      webhookUrl: HOOK_A,
      chatbotIds: [RANDOM_ID],
    });
    expect(unknownBot.statusCode).toBe(400);
    expect(unknownBot.json<{ message: string }>().message).toContain('chatbot không tồn tại');
    expect((await asAdmin('PATCH', `/settings/lark/groups/${group.id}`, {})).statusCode).toBe(400);
    expect((await asAdmin('PATCH', '/settings/lark/groups/khong-phai-uuid', { name: 'X' })).statusCode).toBe(
      400,
    );

    // 404: nhóm không có.
    expect((await asAdmin('PATCH', `/settings/lark/groups/${RANDOM_ID}`, { name: 'X' })).statusCode).toBe(
      404,
    );
    expect((await asAdmin('DELETE', `/settings/lark/groups/${RANDOM_ID}`)).statusCode).toBe(404);
    expect((await asAdmin('POST', `/settings/lark/groups/${RANDOM_ID}/test`)).statusCode).toBe(404);

    const deleted = await asAdmin('DELETE', `/settings/lark/groups/${group.id}`);
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe('');
    expect((await asAdmin('GET', '/settings/lark/groups')).json()).toEqual([]);
  });
});

describe('thẻ Lark khi bấm nút banner đi theo nhóm của bot', () => {
  async function makePendingHuman(conversationId: string, chatbotId: string): Promise<void> {
    await db
      .update(conversations)
      .set({
        chatbotId,
        aiMode: 'off',
        status: 'pending_human',
        handoffReason: 'other',
        handoffAt: new Date(),
      })
      .where(eq(conversations.id, conversationId));
    await db
      .insert(handoffs)
      .values({
        conversationId,
        reasonCode: 'other',
        summary: 'Công trình 33 Trần Quang Diệu',
        createdBy: 'ai',
      });
  }

  async function reset(conversationId: string): Promise<void> {
    await db.delete(handoffs).where(eq(handoffs.conversationId, conversationId));
    await db
      .update(conversations)
      .set({
        chatbotId: null,
        aiMode: 'off',
        status: 'open',
        handoffReason: null,
        handoffAt: null,
        assignedUserId: null,
      })
      .where(eq(conversations.id, conversationId));
  }

  it('bot thuộc nhóm ⇒ chỉ nhóm đó; bot không thuộc nhóm nào ⇒ nhóm chung (env)', async () => {
    const inGroup = await createBot({ name: 'Bot nghiệm thu nhóm', handoffActionLark: true });
    const free = await createBot({ name: 'Bot nghiệm thu chung', handoffActionLark: true });
    const created = await asAdmin('POST', '/settings/lark/groups', {
      name: 'Nhóm nghiệm thu',
      webhookUrl: HOOK_A,
      chatbotIds: [inGroup.id],
    });
    expect(created.statusCode).toBe(201);
    const conversationId = seed.unassignedConversationId;

    await makePendingHuman(conversationId, inGroup.id);
    expect((await asAgent('POST', `/conversations/${conversationId}/handoff/ack`)).statusCode).toBe(200);
    expect(larkCalls.map((c) => c.url)).toEqual([HOOK_A]);
    expect(JSON.stringify(larkCalls[0]!.body)).toContain('Công trình 33 Trần Quang Diệu');
    await reset(conversationId);

    larkCalls.length = 0;
    await makePendingHuman(conversationId, free.id);
    expect((await asAgent('POST', `/conversations/${conversationId}/handoff/ack`)).statusCode).toBe(200);
    expect(larkCalls.map((c) => c.url)).toEqual([ENV_LARK_URL]);
    await reset(conversationId);

    await asAdmin('DELETE', `/settings/lark/groups/${created.json<LarkGroupDto>().id}`);
  });
});
