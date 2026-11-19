// E2E: "Áp dụng chatbot mặc định cho hội thoại đang có" — GET /channels/:id/default-chatbot/apply-preview,
// POST /channels/:id/default-chatbot/apply (admin), phát conversation.updated cho hội thoại vừa đổi bot.
import { auditLogs, channelAccounts, chatbots, conversations, createDb, type Db } from '@dezon/db';
import {
  type ApplyDefaultChatbotPreview,
  type ApplyDefaultChatbotResult,
  type ConversationSummary,
  type LoginResponse,
  REALTIME_EVENTS,
} from '@dezon/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.factory';
import { RealtimeService } from '../src/modules/realtime/realtime.service';
import { type InboxSeed, seedInbox } from './inbox-seed';
import { ADMIN, AGENT, startInfra, type TestInfra } from './test-env';

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

let infra: TestInfra;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;
let seed: InboxSeed;
let realtime: RealtimeService;
let adminToken: string;
let agentToken: string;

beforeAll(async () => {
  infra = await startInfra();
  seed = await seedInbox(infra.databaseUrl);
  ({ db, close: closeDb } = createDb(infra.databaseUrl, { max: 2 }));
  app = await createApp(undefined, { mediaStorage: null });
  realtime = app.get(RealtimeService);
  adminToken = await login(ADMIN.email, ADMIN.password);
  agentToken = await login(AGENT.email, AGENT.password);
});

afterEach(() => {
  vi.restoreAllMocks();
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

const call = (method: 'GET' | 'POST', url: string, token?: string) =>
  app.inject({ method, url, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });
const previewUrl = (id: string) => `/channels/${id}/default-chatbot/apply-preview`;
const applyUrl = (id: string) => `/channels/${id}/default-chatbot/apply`;

async function makeBot(name: string, isActive = true): Promise<string> {
  const [bot] = await db.insert(chatbots).values({ name, isActive }).returning({ id: chatbots.id });
  return bot!.id;
}

const setDefault = (chatbotId: string | null) =>
  db
    .update(channelAccounts)
    .set({ defaultChatbotId: chatbotId })
    .where(eq(channelAccounts.id, seed.channelId));

async function conv(id: string) {
  const [row] = await db.select().from(conversations).where(eq(conversations.id, id));
  return row!;
}

describe('áp dụng chatbot mặc định cho hội thoại đang có', () => {
  it('không đăng nhập ⇒ 401; agent ⇒ 403; id sai ⇒ 400; kênh không có ⇒ 404', async () => {
    expect((await call('GET', previewUrl(seed.channelId))).statusCode).toBe(401);
    expect((await call('POST', applyUrl(seed.channelId))).statusCode).toBe(401);
    expect((await call('GET', previewUrl(seed.channelId), agentToken)).statusCode).toBe(403);
    expect((await call('POST', applyUrl(seed.channelId), agentToken)).statusCode).toBe(403);
    expect((await call('GET', previewUrl('khong-phai-uuid'), adminToken)).statusCode).toBe(400);
    expect((await call('POST', applyUrl('khong-phai-uuid'), adminToken)).statusCode).toBe(400);
    const notFound = await call('GET', previewUrl(MISSING_ID), adminToken);
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toMatchObject({ message: 'Không tìm thấy kênh' });
    expect((await call('POST', applyUrl(MISSING_ID), adminToken)).statusCode).toBe(404);
  });

  it('kênh chưa có chatbot mặc định: preview chatbotId null; apply ⇒ 400', async () => {
    await setDefault(null);
    const preview = await call('GET', previewUrl(seed.channelId), adminToken);
    expect(preview.statusCode).toBe(200);
    expect(preview.json<ApplyDefaultChatbotPreview>()).toEqual({
      chatbotId: null,
      eligible: 0,
      alreadyUsing: 0,
      skippedPendingHuman: 0,
      skippedNoBot: 3,
    });
    const res = await call('POST', applyUrl(seed.channelId), adminToken);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ message: 'Trang chưa có chatbot mặc định' });
  });

  it('chatbot mặc định đang tắt ⇒ 400, không đổi hội thoại', async () => {
    const oldBot = await makeBot('Bot cũ (tắt test)');
    const offBot = await makeBot('Bot mặc định đang tắt', false);
    await db
      .update(conversations)
      .set({ chatbotId: oldBot })
      .where(eq(conversations.id, seed.unassignedConversationId));
    await setDefault(offBot);
    const res = await call('POST', applyUrl(seed.channelId), adminToken);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ message: 'Chatbot mặc định đang tắt, hãy bật bot trước' });
    expect((await conv(seed.unassignedConversationId)).chatbotId).toBe(oldBot);
  });

  it('preview + apply: chỉ đổi hội thoại gắn bot khác, bỏ qua "Cần người", giữ ai_mode; phát conversation.updated', async () => {
    const oldBot = await makeBot('Bot cũ');
    const defaultBot = await makeBot('Bot mặc định mới');
    await setDefault(defaultBot);
    // admin: bot cũ, ai tắt ⇒ đổi bot, vẫn tắt; agent: bot cũ, "Cần người" ⇒ bỏ qua; chưa phân công: chưa gắn bot.
    await db
      .update(conversations)
      .set({ chatbotId: oldBot, aiMode: 'off' })
      .where(eq(conversations.id, seed.adminConversationId));
    await db
      .update(conversations)
      .set({ chatbotId: oldBot, aiMode: 'auto', status: 'pending_human' })
      .where(eq(conversations.id, seed.agentConversationId));
    await db
      .update(conversations)
      .set({ chatbotId: null, aiMode: 'off' })
      .where(eq(conversations.id, seed.unassignedConversationId));

    const preview = await call('GET', previewUrl(seed.channelId), adminToken);
    expect(preview.statusCode).toBe(200);
    expect(preview.json<ApplyDefaultChatbotPreview>()).toEqual({
      chatbotId: defaultBot,
      eligible: 1,
      alreadyUsing: 0,
      skippedPendingHuman: 1,
      skippedNoBot: 1,
    });

    const spy = vi.spyOn(realtime, 'emit');
    const res = await call('POST', applyUrl(seed.channelId), adminToken);
    expect(res.statusCode).toBe(200);
    expect(res.json<ApplyDefaultChatbotResult>()).toEqual({
      chatbotId: defaultBot,
      updated: 1,
      skippedPendingHuman: 1,
    });

    expect(await conv(seed.adminConversationId)).toMatchObject({ chatbotId: defaultBot, aiMode: 'off' });
    expect(await conv(seed.agentConversationId)).toMatchObject({
      chatbotId: oldBot,
      status: 'pending_human',
    });
    expect((await conv(seed.unassignedConversationId)).chatbotId).toBeNull();

    const updates = spy.mock.calls
      .filter(([, event]) => event === REALTIME_EVENTS.conversationUpdated)
      .map(([, , payload]) => (payload as { conversation: ConversationSummary }).conversation);
    expect(updates.map((c) => c.id)).toEqual([seed.adminConversationId]);
    expect(updates[0]!.chatbot?.id).toBe(defaultBot);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'channel.apply_default_chatbot'));
    expect(audit).toMatchObject({
      userId: seed.adminId,
      entityId: seed.channelId,
      data: { chatbotId: defaultBot, updated: 1, skippedPendingHuman: 1 },
    });
  });
});
