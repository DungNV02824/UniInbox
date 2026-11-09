// E2E: DELETE /channels/:id (xóa hẳn kênh đã ngắt kết nối) + stats trong GET /channels.
import type { MediaStorage, MessengerGraphApi } from '@dezon/core';
import { auditLogs, channelAccounts, contacts, conversations, createDb, messages } from '@dezon/db';
import type { ChannelAccountDto, DeleteChannelResult, LoginResponse } from '@dezon/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { type InboxSeed, seedInbox } from './inbox-seed';
import { ADMIN, AGENT, startInfra, type TestInfra } from './test-env';

const fakeGraph: MessengerGraphApi = {
  getPage: async () => ({ id: '999888777666555', name: 'Trang thử nghiệm' }),
  subscribeApp: async () => undefined,
  unsubscribeApp: async () => undefined,
};

let infra: TestInfra;
let app: NestFastifyApplication;
let seed: InboxSeed;
let adminToken: string;
let agentToken: string;
const deletedKeys: string[] = [];

const storage: MediaStorage = {
  put: async () => undefined,
  get: async () => Buffer.alloc(0),
  getStream: async () => {
    throw new Error('không dùng trong test');
  },
  delete: async (key) => void deletedKeys.push(key),
  signedUrl: async (key) => `https://s3.test/${key}?sig=test`,
  ping: async () => undefined,
};

beforeAll(async () => {
  infra = await startInfra();
  seed = await seedInbox(infra.databaseUrl);
  // Một tin có ảnh + một khách có avatar S3 để kiểm bước dọn tệp.
  const { db, close } = createDb(infra.databaseUrl, { max: 1 });
  await db
    .update(messages)
    .set({ attachments: [{ type: 'image', mime: 'image/jpeg', storage_key: 'media/seed-photo.jpg' }] })
    .where(eq(messages.conversationId, seed.agentConversationId));
  const [conv] = await db
    .select({ contactId: conversations.contactId })
    .from(conversations)
    .where(eq(conversations.id, seed.adminConversationId));
  await db.update(contacts).set({ avatarUrl: 'avatars/chi-lan.jpg' }).where(eq(contacts.id, conv!.contactId));
  await close();

  app = await createApp(undefined, { mediaStorage: storage, messengerGraph: fakeGraph });
  adminToken = await login(ADMIN.email, ADMIN.password);
  agentToken = await login(AGENT.email, AGENT.password);
});

afterAll(async () => {
  await app?.close();
  await infra?.stop();
});

async function login(email: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return res.json<LoginResponse>().accessToken;
}

const del = (token: string, id: string, payload?: unknown) =>
  app.inject({
    method: 'DELETE',
    url: `/channels/${id}`,
    headers: { authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });

async function setStatus(status: 'connected' | 'disconnected') {
  const { db, close } = createDb(infra.databaseUrl, { max: 1 });
  await db.update(channelAccounts).set({ status }).where(eq(channelAccounts.id, seed.channelId));
  await close();
}

describe('DELETE /channels/:id', () => {
  it('GET /channels trả stats số hội thoại / tin nhắn', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/channels',
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(200);
    const channel = res.json<ChannelAccountDto[]>().find((c) => c.id === seed.channelId);
    expect(channel?.stats).toEqual({ conversations: 3, messages: 3 });
  });

  it('agent => 403; id sai định dạng => 400; không tồn tại => 404; thiếu body => 400', async () => {
    expect((await del(agentToken, seed.channelId, { confirmName: 'Dezon Sofa' })).statusCode).toBe(403);
    expect((await del(adminToken, 'khong-phai-uuid', { confirmName: 'x' })).statusCode).toBe(400);
    const notFound = await del(adminToken, '00000000-0000-4000-8000-000000000000', { confirmName: 'x' });
    expect(notFound.statusCode).toBe(404);
    expect((await del(adminToken, seed.channelId, {})).statusCode).toBe(400);
    expect((await del(adminToken, seed.channelId, { confirmName: '   ' })).statusCode).toBe(400);
  });

  it('kênh đang kết nối => 409 (kiểm tra trạng thái trước tên, kể cả khi gõ sai tên)', async () => {
    const res = await del(adminToken, seed.channelId, { confirmName: 'Dezon Sofa' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ statusCode: 409, message: 'Hãy ngắt kết nối kênh trước khi xóa' });
    const wrongName = await del(adminToken, seed.channelId, { confirmName: 'sai tên' });
    expect(wrongName.statusCode).toBe(409);
  });

  it('tên xác nhận sai => 400', async () => {
    await setStatus('disconnected');
    const res = await del(adminToken, seed.channelId, { confirmName: 'Dezon sofa' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ statusCode: 400, message: 'Tên kênh xác nhận không khớp' });
  });

  it('kênh đã ngắt + đúng tên => 200 kèm số bản ghi đã xóa, dọn tệp, ghi audit', async () => {
    const res = await del(adminToken, seed.channelId, { confirmName: ' Dezon Sofa ' });
    expect(res.statusCode).toBe(200);
    expect(res.json<DeleteChannelResult>()).toEqual({
      deleted: true,
      conversations: 3,
      messages: 3,
      contacts: 3,
    });
    expect(deletedKeys.sort()).toEqual(['avatars/chi-lan.jpg', 'media/seed-photo.jpg']);

    const list = await app.inject({
      method: 'GET',
      url: '/channels',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(list.json<ChannelAccountDto[]>().map((c) => c.id)).not.toContain(seed.channelId);

    const convs = await app.inject({
      method: 'GET',
      url: '/conversations',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(convs.statusCode).toBe(200);
    expect(JSON.stringify(convs.json())).not.toContain(seed.channelId);

    const { db, close } = createDb(infra.databaseUrl, { max: 1 });
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, seed.channelId));
    await close();
    expect(audits.find((a) => a.action === 'channel.delete')).toMatchObject({
      data: { displayName: 'Dezon Sofa', counts: { conversations: 3, messages: 3, contacts: 3 } },
    });

    expect((await del(adminToken, seed.channelId, { confirmName: 'Dezon Sofa' })).statusCode).toBe(404);
  });
});
