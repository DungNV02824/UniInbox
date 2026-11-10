// E2E "Danh sách nhãn có màu": RBAC, CRUD + 409/400, đổi tên/xóa lan sang khách, PATCH /contacts kiểm nhãn,
// phát realtime 'contact_tags.updated' tới mọi nhân viên.
import { contacts, conversations, createDb, type Db } from '@dezon/db';
import {
  type ContactDetail,
  type ContactTagDto,
  CONTACT_TAGS_MAX,
  type ConversationUpdatedPayload,
  type LoginResponse,
  REALTIME_EVENTS,
  ROOM_ADMINS,
  ROOM_UNASSIGNED,
} from '@dezon/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.factory';
import { RealtimeService } from '../src/modules/realtime/realtime.service';
import { type InboxSeed, seedInbox } from './inbox-seed';
import { ADMIN, AGENT, startInfra, type TestInfra } from './test-env';

let infra: TestInfra;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;
let seed: InboxSeed;
let realtime: RealtimeService;
let adminToken: string;
let agentToken: string;
let contactId: string;

beforeAll(async () => {
  infra = await startInfra();
  seed = await seedInbox(infra.databaseUrl);
  ({ db, close: closeDb } = createDb(infra.databaseUrl, { max: 2 }));
  app = await createApp(undefined, { mediaStorage: null, llm: null, geminiModels: null });
  realtime = app.get(RealtimeService);
  adminToken = await login(ADMIN.email, ADMIN.password);
  agentToken = await login(AGENT.email, AGENT.password);
  const [conv] = await db
    .select({ contactId: conversations.contactId })
    .from(conversations)
    .where(eq(conversations.id, seed.agentConversationId));
  contactId = conv!.contactId;
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

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const call = (token: string, method: Method, url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
const asAdmin = (method: Method, url: string, payload?: unknown) => call(adminToken, method, url, payload);
const asAgent = (method: Method, url: string, payload?: unknown) => call(agentToken, method, url, payload);

async function createTag(name: string, color?: string): Promise<ContactTagDto> {
  const res = await asAdmin('POST', '/contact-tags', color ? { name, color } : { name });
  expect(res.statusCode).toBe(201);
  return res.json<ContactTagDto>();
}

const tagEvents = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.filter(([, event]) => event === REALTIME_EVENTS.contactTagsUpdated);

/** contact.tags trong các lần phát conversation.updated cho hội thoại của khách seed. */
const conversationTagEvents = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls
    .filter(([, event]) => event === REALTIME_EVENTS.conversationUpdated)
    .map(([, , payload]) => (payload as ConversationUpdatedPayload).conversation)
    .filter((c) => c.contact.id === contactId)
    .map((c) => ({ id: c.id, tags: c.contact.tags }));

describe('/contact-tags', () => {
  it('cần đăng nhập', async () => {
    expect((await app.inject({ method: 'GET', url: '/contact-tags' })).statusCode).toBe(401);
  });

  it('admin tạo (màu mặc định blue), agent xem được nhưng không sửa được; phát realtime tới mọi nhân viên', async () => {
    const spy = vi.spyOn(realtime, 'emit');
    const vip = await createTag('  VIP  ');
    expect(vip).toMatchObject({ name: 'VIP', color: 'blue', sortOrder: 0, contactCount: 0 });
    expect(tagEvents(spy)).toEqual([
      [[ROOM_ADMINS, ROOM_UNASSIGNED], REALTIME_EVENTS.contactTagsUpdated, {}],
    ]);

    const list = await asAgent('GET', '/contact-tags');
    expect(list.statusCode).toBe(200);
    expect(list.json<ContactTagDto[]>().map((t) => t.name)).toEqual(['VIP']);

    expect((await asAgent('POST', '/contact-tags', { name: 'X' })).statusCode).toBe(403);
    expect((await asAgent('PATCH', `/contact-tags/${vip.id}`, { color: 'red' })).statusCode).toBe(403);
    expect((await asAgent('POST', '/contact-tags/reorder', { ids: [vip.id] })).statusCode).toBe(403);
    expect((await asAgent('DELETE', `/contact-tags/${vip.id}`)).statusCode).toBe(403);
    expect(tagEvents(spy)).toHaveLength(1);
  });

  it('trùng tên ⇒ 409 "Đã có nhãn này"; dữ liệu sai ⇒ 400', async () => {
    const dup = await asAdmin('POST', '/contact-tags', { name: 'vip' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ message: 'Đã có nhãn này' });
    expect((await asAdmin('POST', '/contact-tags', { name: 'A', color: 'black' })).statusCode).toBe(400);
    expect((await asAdmin('POST', '/contact-tags', { name: '   ' })).statusCode).toBe(400);
    expect((await asAdmin('POST', '/contact-tags', { name: 'x'.repeat(51) })).statusCode).toBe(400);
  });

  it('PATCH /contacts/:id: nhãn mới phải có trong danh sách, chuẩn hóa cách viết', async () => {
    const bad = await asAgent('PATCH', `/contacts/${contactId}`, { tags: ['Gõ sai'] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ message: 'Nhãn "Gõ sai" chưa có trong danh sách nhãn' });
    const spy = vi.spyOn(realtime, 'emit');
    const ok = await asAgent('PATCH', `/contacts/${contactId}`, { tags: ['vip'] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<ContactDetail>().tags).toEqual(['VIP']);
    // Danh sách hộp thư đang mở thấy tag mới ngay (summary có contact.tags).
    expect(conversationTagEvents(spy)).toEqual([{ id: seed.agentConversationId, tags: ['VIP'] }]);
    // Chỉ sửa ghi chú ⇒ không phát conversation.updated.
    spy.mockClear();
    expect((await asAgent('PATCH', `/contacts/${contactId}`, { notes: 'n' })).statusCode).toBe(200);
    expect(conversationTagEvents(spy)).toEqual([]);
  });

  it('đổi tên lan sang khách; sắp xếp; xóa gỡ khỏi khách và trả số khách', async () => {
    const [vip] = (await asAdmin('GET', '/contact-tags')).json<ContactTagDto[]>();
    expect(vip).toMatchObject({ name: 'VIP', contactCount: 1 });
    const sofa = await createTag('Sofa', 'green');

    const spy = vi.spyOn(realtime, 'emit');
    const renamed = await asAdmin('PATCH', `/contact-tags/${vip!.id}`, { name: 'Khách VIP', color: 'red' });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<ContactTagDto>()).toMatchObject({ name: 'Khách VIP', color: 'red', contactCount: 1 });
    const [row] = await db.select({ tags: contacts.tags }).from(contacts).where(eq(contacts.id, contactId));
    expect(row!.tags).toEqual(['Khách VIP']);
    expect(conversationTagEvents(spy)).toEqual([{ id: seed.agentConversationId, tags: ['Khách VIP'] }]);
    spy.mockClear();

    const reordered = await asAdmin('POST', '/contact-tags/reorder', { ids: [sofa.id, vip!.id] });
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json<ContactTagDto[]>().map((t) => t.name)).toEqual(['Sofa', 'Khách VIP']);
    expect(conversationTagEvents(spy)).toEqual([]);

    const del = await asAdmin('DELETE', `/contact-tags/${vip!.id}`);
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ removedFromContacts: 1 });
    const [after] = await db.select({ tags: contacts.tags }).from(contacts).where(eq(contacts.id, contactId));
    expect(after!.tags).toEqual([]);
    expect(conversationTagEvents(spy)).toEqual([{ id: seed.agentConversationId, tags: [] }]);
    expect((await asAdmin('DELETE', `/contact-tags/${vip!.id}`)).statusCode).toBe(404);
    expect(tagEvents(spy)).toHaveLength(2);
  });

  it(`quá ${CONTACT_TAGS_MAX} nhãn ⇒ 400`, async () => {
    const existing = (await asAdmin('GET', '/contact-tags')).json<ContactTagDto[]>().length;
    for (let i = existing; i < CONTACT_TAGS_MAX; i++) await createTag(`Nhãn ${i}`);
    expect((await asAdmin('POST', '/contact-tags', { name: 'Thừa' })).statusCode).toBe(400);
  });
});
