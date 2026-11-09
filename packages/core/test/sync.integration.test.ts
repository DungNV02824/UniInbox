// Test tích hợp đồng bộ Messenger: Postgres thật (Testcontainers), Graph giả qua fetch (reader thật).
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  channelAccounts,
  contactIdentities,
  contacts,
  conversations,
  createDb,
  messages,
  runMigrations,
  seedUsers,
  type Db,
  type DbHandle,
} from '@dezon/db';
import type { NormalizedInboundMessage } from '@dezon/shared';
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listChannels } from '../src/channels/service';
import { createMessengerConnector } from '../src/connectors/messenger';
import { PermanentSendError, type InboundEvent } from '../src/connectors/types';
import { fallbackContactName } from '../src/pipeline/helpers';
import { processInboundEvent } from '../src/pipeline/inbound';
import { processOutboundMessage } from '../src/pipeline/outbound';
import type { PipelineDeps } from '../src/pipeline/types';
import type { RealtimePublisher } from '../src/realtime';
import { firstCustomerMessageAt } from '../src/pipeline/window-anchor';
import { readSyncState, syncMessengerAccount, syncTickPlan, writeSyncState } from '../src/sync';
import { createMemoryStorage } from './helpers/memory-storage';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
let db: Db;
let agentId: string;
let jpeg: Buffer;

// ---------- Graph giả ----------

interface FakeMessage {
  id: string;
  from: string;
  at: Date;
  message?: string;
  attachments?: unknown[];
}
interface FakeThread {
  id: string;
  psid: string;
  name: string;
  messages: FakeMessage[];
}

let pageId: string;
let accountId: string;
let threads: FakeThread[];
let graphCalls: URL[];
let tokenExpired: boolean;
let rateLimited: boolean;
let sendCounter: number;
let published: { event: string; payload: unknown }[];
let deps: PipelineDeps;

const graphTime = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, '+0000');

function pageOf<T>(items: T[], url: URL): { data: T[]; paging: unknown } {
  const limit = Number(url.searchParams.get('limit') ?? 25);
  const offset = Number(url.searchParams.get('after') ?? 0);
  const data = items.slice(offset, offset + limit);
  const more = offset + limit < items.length;
  return {
    data,
    paging: {
      cursors: { before: 'B', after: String(offset + limit) },
      ...(more ? { next: `https://graph.test/next?access_token=SECRET&after=${offset + limit}` } : {}),
    },
  };
}

const updatedOf = (t: FakeThread) => Math.max(...t.messages.map((m) => m.at.getTime()));

function graphResponse(url: URL, init?: RequestInit): unknown {
  const parts = url.pathname.split('/').filter(Boolean); // [v26.0, ...]
  if (init?.method === 'POST' && parts[2] === 'messages') {
    sendCounter++;
    return { recipient_id: 'x', message_id: `m_sent_${sendCounter}` };
  }
  if (parts[2] === 'conversations') {
    const sorted = [...threads].sort((a, b) => updatedOf(b) - updatedOf(a));
    return pageOf(
      sorted.map((t) => ({
        id: t.id,
        updated_time: graphTime(new Date(updatedOf(t))),
        message_count: t.messages.length,
        participants: {
          data: [
            { id: t.psid, name: t.name, email: `${t.psid}@facebook.com` },
            { id: pageId, name: 'Fanpage', email: `${pageId}@facebook.com` },
          ],
        },
      })),
      url,
    );
  }
  if (parts[2] === 'messages') {
    const t = threads.find((x) => x.id === parts[1]);
    if (!t) return { error: { code: 100, error_subcode: 33 } };
    const sorted = [...t.messages].sort((a, b) => b.at.getTime() - a.at.getTime());
    return pageOf(
      sorted.map((m) => ({
        id: m.id,
        message: m.message ?? '',
        from: { id: m.from, name: m.from === pageId ? 'Fanpage' : t.name },
        created_time: graphTime(m.at),
        ...(m.attachments ? { attachments: { data: m.attachments } } : {}),
      })),
      url,
    );
  }
  return {}; // User Profile: không có quyền => {}
}

const graphFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === 'media.test') {
    return new Response(new Uint8Array(jpeg), { headers: { 'content-type': 'image/jpeg' } });
  }
  graphCalls.push(url);
  if (rateLimited) {
    return new Response(JSON.stringify({ error: { code: 32, type: 'OAuthException' } }), { status: 400 });
  }
  if (tokenExpired) {
    return new Response(
      JSON.stringify({ error: { code: 190, error_subcode: 463, type: 'OAuthException' } }),
      {
        status: 400,
      },
    );
  }
  const body = graphResponse(url, init);
  const status = (body as { error?: unknown }).error ? 400 : 200;
  return new Response(JSON.stringify(body), { status });
};

// ---------- tiện ích ----------

const ago = (ms: number) => new Date(Date.now() - ms);

function webhook(psid: string, mid: string, extra: Partial<NormalizedInboundMessage> = {}): InboundEvent {
  return {
    kind: 'message',
    message: {
      channelAccountId: accountId,
      channelType: 'messenger',
      externalUserId: psid,
      externalMessageId: mid,
      direction: 'in',
      senderType: 'customer',
      text: 'Shop ơi',
      attachments: [],
      sentAt: ago(MINUTE),
      raw: { sender: { id: psid }, message: { mid } },
      ...extra,
    },
  };
}

async function conversationOf(psid: string) {
  const [row] = await db
    .select({ conversation: conversations, contact: contacts })
    .from(conversations)
    .innerJoin(contactIdentities, eq(contactIdentities.id, conversations.contactIdentityId))
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(
      and(eq(contactIdentities.channelAccountId, accountId), eq(contactIdentities.externalUserId, psid)),
    );
  return row!;
}

const messagesOf = (conversationId: string) =>
  db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(messages.sentAt);

async function settingsOf() {
  const [row] = await db
    .select({
      settings: channelAccounts.settings,
      status: channelAccounts.status,
      lastError: channelAccounts.lastError,
    })
    .from(channelAccounts)
    .where(eq(channelAccounts.id, accountId));
  return row!;
}

const events = (name: string) => published.filter((p) => p.event === name);

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  const url = container.getConnectionUri();
  await runMigrations(url);
  handle = createDb(url, { max: 5 });
  db = handle.db;
  const users = await seedUsers(db, {
    admin: { email: 'admin@test.vn', password: 'matkhau123' },
    agent: { email: 'agent@test.vn', password: 'matkhau123' },
  });
  agentId = users.find((u) => u.role === 'agent')!.id;
  jpeg = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#36c' } })
    .jpeg()
    .toBuffer();
});

afterAll(async () => {
  await handle?.close();
  await container?.stop();
});

let seq = 0;
beforeEach(async () => {
  seq++;
  pageId = `page-${seq}`;
  const [account] = await db
    .insert(channelAccounts)
    .values({
      type: 'messenger',
      displayName: `Fanpage ${seq}`,
      externalId: pageId,
      status: 'connected',
      credentials: { enc: JSON.stringify({ pageAccessToken: 'page-token' }) },
      settings: { connectedBy: { provider: 'token' }, pictureUrl: null },
    })
    .returning({ id: channelAccounts.id });
  accountId = account!.id;
  threads = [];
  graphCalls = [];
  tokenExpired = false;
  rateLimited = false;
  sendCounter = 0;
  published = [];
  const publisher: RealtimePublisher = {
    emit: (_rooms, event, payload) => published.push({ event, payload }),
  };
  const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  deps = {
    connectors: {
      messenger: createMessengerConnector({
        appId: 'own-app',
        appSecret: 'app-secret',
        graphBaseUrl: 'https://graph.test',
        graphVersion: 'v26.0',
        fetch: graphFetch,
      }),
    },
    storage: createMemoryStorage(),
    cipher: { encryptJson: (v) => JSON.stringify(v), decryptJson: <T>(s: string) => JSON.parse(s) as T },
    publisher,
    ctx: {
      signUrl: async (key) => `signed:${key}`,
      now: () => new Date(),
      policy: { metaHumanAgentEnabled: false, zaloOaAllowPaidBot: false },
    },
    logger: silent,
    maxMediaBytes: 25 * 1024 * 1024,
    ownAppIds: { messenger: 'own-app' },
    fetch: graphFetch,
  };
});

// ---------- test ----------

describe('syncMessengerAccount — backfill', () => {
  it('nhập lịch sử N ngày: không tăng unread, không phát message.created, thay tên tạm, giữ tên nhân viên sửa', async () => {
    // Khách B đã nhắn qua webhook nhưng không lấy được tên => tên tạm, unread 1.
    await processInboundEvent(db, deps, webhook('psid-b-0002', 'm_b_webhook', { sentAt: ago(30 * MINUTE) }));
    // Khách C: nhân viên đã sửa tên; hội thoại đã xong.
    await processInboundEvent(db, deps, webhook('psid-c-0003', 'm_c_webhook', { sentAt: ago(50 * MINUTE) }));
    const c = await conversationOf('psid-c-0003');
    await db.update(contacts).set({ displayName: 'Anh Tuấn (VIP)' }).where(eq(contacts.id, c.contact.id));
    await db
      .update(conversations)
      .set({ status: 'resolved', unreadCount: 0 })
      .where(eq(conversations.id, c.conversation.id));
    expect((await conversationOf('psid-b-0002')).contact.displayName).toBe(
      fallbackContactName('messenger', 'psid-b-0002'),
    );
    published = [];
    const a2At = ago(3 * DAY - MINUTE);

    threads = [
      {
        id: 't_a',
        psid: 'psid-a-0001',
        name: 'Chị Hoa',
        messages: [
          { id: 'm_a_old', from: 'psid-a-0001', at: ago(40 * DAY), message: 'quá cũ' },
          { id: 'm_a1', from: 'psid-a-0001', at: ago(3 * DAY), message: 'Cho em xin báo giá' },
          {
            id: 'm_a2',
            from: 'psid-a-0001',
            at: a2At,
            attachments: [
              {
                id: 'att',
                mime_type: 'image/jpeg',
                name: 'nha.jpg',
                image_data: { url: 'https://media.test/nha.jpg', width: 200, height: 100 },
              },
            ],
          },
          { id: 'm_a3', from: pageId, at: ago(2 * DAY), message: 'Dạ shop gửi chị' },
        ],
      },
      {
        id: 't_b',
        psid: 'psid-b-0002',
        name: 'Bảo Ngọc',
        messages: [
          { id: 'm_b0', from: 'psid-b-0002', at: ago(2 * DAY), message: 'tin cũ hơn webhook' },
          { id: 'm_b_webhook', from: 'psid-b-0002', at: ago(30 * MINUTE), message: 'Shop ơi' },
        ],
      },
      {
        id: 't_c',
        psid: 'psid-c-0003',
        name: 'Tuấn',
        messages: [
          { id: 'm_c0', from: 'psid-c-0003', at: ago(DAY), message: 'hỏi lại' },
          { id: 'm_c_webhook', from: 'psid-c-0003', at: ago(50 * MINUTE), message: 'Shop ơi' },
        ],
      },
    ];

    const result = await syncMessengerAccount(db, deps, accountId, {
      mode: 'backfill',
      days: 30,
      maxMessagesPerConversation: 50,
    });
    expect(result).toEqual({ conversations: 3, messagesStored: 5, messagesSkipped: 2 });

    // A: hội thoại mới, tên thật, unread 0, ảnh tải về S3, tin cũ hơn 30 ngày bị bỏ, thứ tự cũ -> mới.
    const a = await conversationOf('psid-a-0001');
    expect(a.contact.displayName).toBe('Chị Hoa');
    expect(a.conversation.unreadCount).toBe(0);
    // Hội thoại mới chỉ có lịch sử, tin cuối là của Page => không làm ngập "Đang mở".
    expect(a.conversation.status).toBe('resolved');
    const aMsgs = await messagesOf(a.conversation.id);
    expect(aMsgs.map((m) => m.externalMessageId)).toEqual(['m_a1', 'm_a2', 'm_a3']);
    expect(aMsgs.map((m) => m.senderType)).toEqual(['customer', 'customer', 'agent']);
    expect(aMsgs[2]!.status).toBe('sent');
    expect(aMsgs[1]!.attachments[0]).toMatchObject({
      type: 'image',
      original_url: 'https://media.test/nha.jpg',
    });
    expect(aMsgs[1]!.attachments[0]!.storage_key).toMatch(/^media\//);
    expect(aMsgs[0]!.raw).toMatchObject({ source: 'sync', conversationId: 't_a', mid: 'm_a1' });
    expect(a.conversation.lastCustomerMessageAt!.getTime()).toBe(Math.floor(a2At.getTime() / 1000) * 1000);

    // B: tên tạm được thay bằng tên thật, unread giữ nguyên 1, không trùng tin webhook.
    const b = await conversationOf('psid-b-0002');
    expect(b.contact.displayName).toBe('Bảo Ngọc');
    expect(b.conversation.unreadCount).toBe(1);
    expect((await messagesOf(b.conversation.id)).map((m) => m.externalMessageId)).toEqual([
      'm_b0',
      'm_b_webhook',
    ]);

    // C: không ghi đè tên nhân viên sửa, không mở lại hội thoại đã xong.
    const c2 = await conversationOf('psid-c-0003');
    expect(c2.contact.displayName).toBe('Anh Tuấn (VIP)');
    expect(c2.conversation.status).toBe('resolved');
    expect(c2.conversation.unreadCount).toBe(0);

    // Realtime: không có message.created; mỗi hội thoại có tin mới một conversation.updated.
    expect(events('message.created')).toHaveLength(0);
    expect(events('conversation.updated')).toHaveLength(3);

    // Trạng thái đồng bộ: merge, giữ connectedBy.
    const { settings } = await settingsOf();
    expect(settings.connectedBy).toEqual({ provider: 'token' });
    const state = readSyncState(settings)!;
    expect(state).toMatchObject({
      backfillDays: 30,
      backfillRunning: false,
      lastError: null,
      lastErrorAt: null,
    });
    expect(state.lastSyncedAt).not.toBeNull();
    expect(state.lastBackfillAt).toBe(state.lastSyncedAt);
    const [dto] = (await listChannels(db)).filter((ch) => ch.id === accountId);
    expect(dto!.sync).toEqual(state);

    // Đồng bộ đã có tên thật: không gọi GET /{psid} lấy hồ sơ cho khách mới.
    expect(graphCalls.filter((u) => u.pathname.endsWith('/psid-a-0001'))).toHaveLength(0);

    // Không gọi Graph bằng token trong URL, có appsecret_proof.
    expect(graphCalls.every((u) => !u.toString().includes('page-token'))).toBe(true);
    const reads = graphCalls.filter((u) => /\/(conversations|messages)$/.test(u.pathname));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((u) => u.searchParams.has('appsecret_proof'))).toBe(true);
  });

  it('phân trang theo cursor và giới hạn số tin mỗi hội thoại (lấy tin mới nhất)', async () => {
    threads = Array.from({ length: 3 }, (_, i) => ({
      id: `t_${i}`,
      psid: `psid-p${i}`,
      name: `Khách ${i}`,
      messages: Array.from({ length: 5 }, (_, j) => ({
        id: `m_${i}_${j}`,
        from: `psid-p${i}`,
        at: ago((10 - j) * MINUTE + i * 1000),
        message: `tin ${j}`,
      })),
    }));
    const result = await syncMessengerAccount(db, deps, accountId, {
      mode: 'backfill',
      maxConversations: 2,
      maxMessagesPerConversation: 3,
    });
    expect(result).toEqual({ conversations: 2, messagesStored: 6, messagesSkipped: 0, truncated: true });
    expect(readSyncState((await settingsOf()).settings)).toMatchObject({
      backfillConversations: 2,
      backfillMessagesStored: 6,
      backfillTruncated: true,
    });
    const c0 = await conversationOf('psid-p0');
    expect((await messagesOf(c0.conversation.id)).map((m) => m.externalMessageId)).toEqual([
      'm_0_2',
      'm_0_3',
      'm_0_4',
    ]);
    expect(await conversationOf('psid-p2')).toBeUndefined();
  });
});

describe('syncMessengerAccount — chống trùng với webhook', () => {
  it('sync rồi webhook cùng mid: một tin', async () => {
    threads = [
      {
        id: 't_s',
        psid: 'psid-s',
        name: 'Lan',
        messages: [{ id: 'm_s1', from: 'psid-s', at: ago(5 * MINUTE), message: 'A' }],
      },
    ];
    await syncMessengerAccount(db, deps, accountId, { mode: 'incremental' });
    await processInboundEvent(db, deps, webhook('psid-s', 'm_s1'));
    const s = await conversationOf('psid-s');
    expect(await messagesOf(s.conversation.id)).toHaveLength(1);
    expect(s.conversation.unreadCount).toBe(1);
  });

  it('webhook rồi sync cùng mid: một tin, unread không tăng thêm', async () => {
    await processInboundEvent(db, deps, webhook('psid-w', 'm_w1', { sentAt: ago(5 * MINUTE) }));
    threads = [
      {
        id: 't_w',
        psid: 'psid-w',
        name: 'Mai',
        messages: [{ id: 'm_w1', from: 'psid-w', at: ago(5 * MINUTE), message: 'Shop ơi' }],
      },
    ];
    const result = await syncMessengerAccount(db, deps, accountId, { mode: 'incremental' });
    expect(result).toEqual({ conversations: 1, messagesStored: 0, messagesSkipped: 1 });
    const w = await conversationOf('psid-w');
    expect(await messagesOf(w.conversation.id)).toHaveLength(1);
    expect(w.conversation.unreadCount).toBe(1);
  });

  it('webhook rồi sync: mọi tin đã có nhưng tên tạm vẫn được thay bằng tên participants (một lần)', async () => {
    await processInboundEvent(db, deps, webhook('psid-n', 'm_n1', { sentAt: ago(5 * MINUTE) }));
    expect((await conversationOf('psid-n')).contact.displayName).toBe(
      fallbackContactName('messenger', 'psid-n'),
    );
    threads = [
      {
        id: 't_n',
        psid: 'psid-n',
        name: 'Đúng Văn',
        messages: [{ id: 'm_n1', from: 'psid-n', at: ago(5 * MINUTE), message: 'Shop ơi' }],
      },
    ];
    published = [];
    await syncMessengerAccount(db, deps, accountId, { mode: 'incremental' });
    expect((await conversationOf('psid-n')).contact.displayName).toBe('Đúng Văn');
    expect(published.filter((p) => p.event === 'conversation.updated')).toHaveLength(1);

    // Lần sau không phát lại; tên nhân viên đã sửa không bị ghi đè.
    const n = await conversationOf('psid-n');
    await db.update(contacts).set({ displayName: 'Anh Văn (NV sửa)' }).where(eq(contacts.id, n.contact.id));
    published = [];
    await syncMessengerAccount(db, deps, accountId, { mode: 'incremental' });
    expect((await conversationOf('psid-n')).contact.displayName).toBe('Anh Văn (NV sửa)');
    expect(published.filter((p) => p.event === 'conversation.updated')).toHaveLength(0);
  });
});

describe('syncMessengerAccount — incremental', () => {
  it('chỉ lấy tin mới từ lastSyncedAt - 2 phút, tăng unread, phát message.created, mở lại hội thoại đã xong', async () => {
    threads = [
      {
        id: 't_i',
        psid: 'psid-i',
        name: 'Hùng',
        messages: [{ id: 'm_i1', from: 'psid-i', at: ago(20 * MINUTE), message: 'cũ' }],
      },
    ];
    await syncMessengerAccount(db, deps, accountId, { mode: 'backfill', days: 7 });
    const i = await conversationOf('psid-i');
    await db.update(conversations).set({ status: 'resolved' }).where(eq(conversations.id, i.conversation.id));
    // Lần đồng bộ trước cách đây 10 phút => tin 20 phút trước không được đọc lại xử lý.
    await writeSyncState(db, accountId, { lastSyncedAt: ago(10 * MINUTE).toISOString() });
    threads[0]!.messages.push({ id: 'm_i2', from: 'psid-i', at: ago(MINUTE), message: 'mới' });
    published = [];

    const result = await syncMessengerAccount(db, deps, accountId, { mode: 'incremental' });
    expect(result).toEqual({ conversations: 1, messagesStored: 1, messagesSkipped: 0 });
    const after = await conversationOf('psid-i');
    expect(after.conversation.unreadCount).toBe(1);
    expect(after.conversation.status).toBe('open');
    expect(events('message.created')).toHaveLength(1);
    expect(readSyncState((await settingsOf()).settings)!.lastBackfillAt).not.toBeNull();
  });

  it('hội thoại cập nhật trước mốc không được đọc tin', async () => {
    threads = [
      {
        id: 't_o',
        psid: 'psid-o',
        name: 'Cũ',
        messages: [{ id: 'm_o', from: 'psid-o', at: ago(3 * DAY), message: 'x' }],
      },
    ];
    await writeSyncState(db, accountId, { lastSyncedAt: ago(MINUTE).toISOString() });
    const result = await syncMessengerAccount(db, deps, accountId, { mode: 'incremental' });
    expect(result).toEqual({ conversations: 0, messagesStored: 0, messagesSkipped: 0 });
    expect(graphCalls.filter((u) => u.pathname.endsWith('/messages'))).toHaveLength(0);
  });

  it('tin hệ thống đã gửi (nhiều phần) và tin đang chờ gửi không bị nhập trùng; tin từ Business Suite được nhập', async () => {
    await processInboundEvent(db, deps, webhook('psid-own', 'm_own_in', { sentAt: ago(10 * MINUTE) }));
    const own = await conversationOf('psid-own');
    // Tin nhân viên: text + ảnh => 2 phần gửi, 2 mid.
    const key = 'uploads/2026/11/a.jpg';
    await deps.storage.put(key, jpeg, 'image/jpeg');
    const [sent] = await db
      .insert(messages)
      .values({
        conversationId: own.conversation.id,
        channelAccountId: accountId,
        senderType: 'agent',
        senderUserId: agentId,
        text: 'Dạ em gửi mẫu',
        attachments: [{ type: 'image', storage_key: key, mime: 'image/jpeg' }],
        status: 'queued',
        raw: { outbound: {} },
        sentAt: ago(5 * MINUTE),
      })
      .returning({ id: messages.id });
    await processOutboundMessage(db, deps, sent!.id);
    const [sentRow] = await db.select().from(messages).where(eq(messages.id, sent!.id));
    expect(sentRow).toMatchObject({ status: 'sent', externalMessageId: 'm_sent_1' });
    expect(sentRow!.raw).toMatchObject({ outbound: {}, sentExternalIds: ['m_sent_1', 'm_sent_2'] });
    // Tin đang chờ gửi (Send API đã nhận nhưng worker chưa ghi kết quả).
    await db.insert(messages).values({
      conversationId: own.conversation.id,
      channelAccountId: accountId,
      senderType: 'agent',
      senderUserId: agentId,
      text: 'Đang gửi',
      status: 'queued',
      raw: { outbound: {} },
      sentAt: ago(2 * MINUTE),
    });

    threads = [
      {
        id: 't_own',
        psid: 'psid-own',
        name: 'Khách Own',
        messages: [
          { id: 'm_own_in', from: 'psid-own', at: ago(10 * MINUTE), message: 'Shop ơi' },
          { id: 'm_sent_1', from: pageId, at: ago(5 * MINUTE), message: 'Dạ em gửi mẫu' },
          {
            id: 'm_sent_2',
            from: pageId,
            at: ago(5 * MINUTE),
            attachments: [
              { id: 'x', mime_type: 'image/jpeg', image_data: { url: 'https://media.test/x.jpg' } },
            ],
          },
          { id: 'm_queued', from: pageId, at: ago(2 * MINUTE), message: 'Đang gửi' },
          { id: 'm_mbs', from: pageId, at: ago(MINUTE), message: 'Trả lời từ Business Suite' },
        ],
      },
    ];
    published = [];
    const result = await syncMessengerAccount(db, deps, accountId, { mode: 'incremental' });
    expect(result).toEqual({ conversations: 1, messagesStored: 1, messagesSkipped: 4 });
    const rows = await messagesOf(own.conversation.id);
    expect(rows).toHaveLength(4);
    const mbs = rows.find((r) => r.externalMessageId === 'm_mbs')!;
    expect(mbs).toMatchObject({ senderType: 'agent', senderUserId: null, status: 'sent' });
    expect((await conversationOf('psid-own')).conversation.unreadCount).toBe(1);
  });
});

describe('syncMessengerAccount — backfill sau khi mất kết nối', () => {
  it('tin sau lần đồng bộ trước là tin bị lỡ: tăng unread, mở lại hội thoại, phát message.created', async () => {
    await processInboundEvent(db, deps, webhook('psid-r', 'm_r0', { sentAt: ago(3 * DAY) }));
    const r = await conversationOf('psid-r');
    await db
      .update(conversations)
      .set({ status: 'resolved', unreadCount: 0 })
      .where(eq(conversations.id, r.conversation.id));
    // Token hết hạn từ 10 giờ trước; kết nối lại => backfill 30 ngày.
    await writeSyncState(db, accountId, {
      lastSyncedAt: ago(10 * 60 * MINUTE).toISOString(),
      lastBackfillAt: ago(20 * DAY).toISOString(),
    });
    threads = [
      {
        id: 't_r',
        psid: 'psid-r',
        name: 'Khách R',
        messages: [
          { id: 'm_r0', from: 'psid-r', at: ago(3 * DAY), message: 'Shop ơi' },
          { id: 'm_r_hist', from: 'psid-r', at: ago(2 * DAY), message: 'lịch sử' },
          { id: 'm_r_missed1', from: 'psid-r', at: ago(5 * 60 * MINUTE), message: 'còn hàng không' },
          { id: 'm_r_missed2', from: 'psid-r', at: ago(4 * 60 * MINUTE), message: 'shop ơi?' },
        ],
      },
      {
        id: 't_n',
        psid: 'psid-n',
        name: 'Khách mới',
        messages: [{ id: 'm_n1', from: 'psid-n', at: ago(3 * 60 * MINUTE), message: 'hỏi giá' }],
      },
    ];
    published = [];
    const result = await syncMessengerAccount(db, deps, accountId, { mode: 'backfill', days: 30 });
    expect(result).toEqual({ conversations: 2, messagesStored: 4, messagesSkipped: 1 });
    const after = await conversationOf('psid-r');
    expect(after.conversation.unreadCount).toBe(2);
    expect(after.conversation.status).toBe('open');
    const n = await conversationOf('psid-n');
    expect(n.conversation.unreadCount).toBe(1);
    expect(n.conversation.status).toBe('open');
    // m_r_hist là lịch sử; 3 tin bị lỡ => 3 message.created.
    expect(events('message.created')).toHaveLength(3);
  });

  it('hội thoại mới: tin cuối của khách trong 24 giờ thì vẫn "Đang mở"; cũ hơn thì "Đã xong"', async () => {
    threads = [
      {
        id: 't_recent',
        psid: 'psid-recent',
        name: 'Gần đây',
        messages: [{ id: 'm_recent', from: 'psid-recent', at: ago(3 * 60 * MINUTE), message: 'alo' }],
      },
      {
        id: 't_stale',
        psid: 'psid-stale',
        name: 'Lâu rồi',
        messages: [{ id: 'm_stale', from: 'psid-stale', at: ago(5 * DAY), message: 'alo' }],
      },
    ];
    await syncMessengerAccount(db, deps, accountId, { mode: 'backfill', days: 30 });
    const recent = await conversationOf('psid-recent');
    expect(recent.conversation).toMatchObject({ status: 'open', unreadCount: 0 });
    expect((await conversationOf('psid-stale')).conversation.status).toBe('resolved');
  });

  it('cửa sổ quảng cáo không bị kéo lùi bởi lịch sử nhập từ đồng bộ', async () => {
    threads = [
      {
        id: 't_ads',
        psid: 'psid-ads',
        name: 'Khách QC',
        messages: [{ id: 'm_ads_old', from: 'psid-ads', at: ago(20 * DAY), message: 'cũ' }],
      },
    ];
    await syncMessengerAccount(db, deps, accountId, { mode: 'backfill', days: 30 });
    const clickAt = ago(MINUTE);
    await processInboundEvent(
      db,
      deps,
      webhook('psid-ads', 'm_ads_click', { sentAt: clickAt, referral: { source: 'ADS' } }),
    );
    const c = await conversationOf('psid-ads');
    expect(c.conversation.windowSource).toBe('ads');
    expect((await firstCustomerMessageAt(db, c.conversation.id))!.getTime()).toBe(clickAt.getTime());
  });
});

describe('syncMessengerAccount — tin tệp từ Business Suite', () => {
  it('ảnh gửi từ Business Suite không bị coi là bản sao của một tin chữ đang chờ gửi', async () => {
    await processInboundEvent(db, deps, webhook('psid-img', 'm_img_in', { sentAt: ago(10 * MINUTE) }));
    const conv = await conversationOf('psid-img');
    await db.insert(messages).values({
      conversationId: conv.conversation.id,
      channelAccountId: accountId,
      senderType: 'agent',
      senderUserId: agentId,
      text: 'Dạ em gửi báo giá',
      status: 'queued',
      raw: { outbound: {} },
      sentAt: ago(2 * MINUTE),
    });
    threads = [
      {
        id: 't_img',
        psid: 'psid-img',
        name: 'Khách ảnh',
        messages: [
          { id: 'm_img_in', from: 'psid-img', at: ago(10 * MINUTE), message: 'Shop ơi' },
          {
            id: 'm_img_mbs',
            from: pageId,
            at: ago(MINUTE),
            attachments: [
              { id: 'q', mime_type: 'image/jpeg', image_data: { url: 'https://media.test/q.jpg' } },
            ],
          },
        ],
      },
    ];
    const result = await syncMessengerAccount(db, deps, accountId, { mode: 'incremental' });
    expect(result).toMatchObject({ messagesStored: 1 });
    const rows = await messagesOf(conv.conversation.id);
    expect(rows.find((m) => m.externalMessageId === 'm_img_mbs')).toMatchObject({ senderType: 'agent' });
  });
});

describe('syncMessengerAccount — lỗi', () => {
  it('token hỏng: kênh expired, ghi lastError tiếng Việt, ném PermanentSendError', async () => {
    tokenExpired = true;
    await writeSyncState(db, accountId, { backfillRunning: true });
    const err = await syncMessengerAccount(db, deps, accountId, { mode: 'backfill' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PermanentSendError);
    const row = await settingsOf();
    expect(row.status).toBe('expired');
    expect(row.lastError).toContain('Token Fanpage');
    const state = readSyncState(row.settings)!;
    expect(state.backfillRunning).toBe(false);
    expect(state.lastError).toContain('Token Fanpage');
    expect(state.lastError).not.toContain('page-token');
    expect(state.lastErrorAt).not.toBeNull();
    expect(state.lastSyncedAt).toBeNull();
  });

  it('Facebook giới hạn tần suất (mã 32): ghi lỗi + tạm dừng đồng bộ định kỳ 15 phút', async () => {
    rateLimited = true;
    const err = await syncMessengerAccount(db, deps, accountId, { mode: 'incremental' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const row = await settingsOf();
    expect(row.status).toBe('connected');
    const state = readSyncState(row.settings)!;
    expect(state.lastError).toContain('giới hạn tần suất');
    const paused = Date.parse(state.pausedUntil!) - Date.now();
    expect(paused).toBeGreaterThan(14 * MINUTE);
    expect(paused).toBeLessThanOrEqual(15 * MINUTE);
    expect(syncTickPlan(row.settings, new Date()).paused).toBe(true);
    // Lần thành công sau xóa tạm dừng.
    rateLimited = false;
    await syncMessengerAccount(db, deps, accountId, { mode: 'incremental' });
    expect(readSyncState((await settingsOf()).settings)!.pausedUntil).toBeNull();
  });

  it('kênh không ở trạng thái connected: không gọi Graph', async () => {
    await db.update(channelAccounts).set({ status: 'disconnected' }).where(eq(channelAccounts.id, accountId));
    const result = await syncMessengerAccount(db, deps, accountId, { mode: 'incremental' });
    expect(result).toEqual({ conversations: 0, messagesStored: 0, messagesSkipped: 0 });
    expect(graphCalls).toHaveLength(0);
  });
});

describe('readSyncState', () => {
  it('đọc an toàn jsonb tự do', () => {
    expect(readSyncState(null)).toBeNull();
    expect(readSyncState({ sync: 'x' })).toBeNull();
    expect(
      readSyncState({
        sync: { lastSyncedAt: 'không phải ngày', backfillDays: -1, backfillRunning: 'yes', lastError: 5 },
      }),
    ).toEqual({
      lastSyncedAt: null,
      lastBackfillAt: null,
      backfillDays: null,
      backfillRunning: false,
      lastError: null,
      lastErrorAt: null,
      backfillConversations: null,
      backfillMessagesStored: null,
      backfillTruncated: false,
      pausedUntil: null,
    });
  });

  it('syncTickPlan: cần backfill khi chưa từng đồng bộ lịch sử; tạm dừng tới pausedUntil', () => {
    const now = new Date('2026-11-05T10:00:00Z');
    expect(syncTickPlan(null, now)).toEqual({ needsBackfill: true, paused: false });
    expect(
      syncTickPlan(
        { sync: { lastBackfillAt: '2026-11-05T09:00:00Z', pausedUntil: '2026-11-05T10:05:00Z' } },
        now,
      ),
    ).toEqual({ needsBackfill: false, paused: true });
    expect(syncTickPlan({ sync: { pausedUntil: '2026-11-05T09:59:00Z' } }, now).paused).toBe(false);
  });
});
