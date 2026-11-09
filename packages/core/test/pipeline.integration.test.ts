// Test tích hợp pipeline inbound/outbound: Postgres thật (Testcontainers), connector/storage/publisher giả.
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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PermanentSendError,
  TransientSendError,
  type ChannelConnector,
  type InboundEvent,
  type OutboundPart,
} from '../src/connectors/types';
import { processInboundEvent, processInboundJob } from '../src/pipeline/inbound';
import {
  markOutboundFailed,
  MSG_BATCH_ABORTED,
  OutboundNotReadyError,
  processOutboundMessage,
} from '../src/pipeline/outbound';
import { ReceiptNotReadyError } from '../src/pipeline/receipts';
import type { PipelineDeps } from '../src/pipeline/types';
import type { RealtimePublisher } from '../src/realtime';
import { createMemoryStorage, type MemoryStorage } from './helpers/memory-storage';

const OWN_APP_ID = '1517776481860111';
const PAGE_ID = 'page-1';
const MINUTE = 60_000;

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
let db: Db;
let accountId: string;
let agentId: string;
let storage: MemoryStorage;
let published: { rooms: string[]; event: string; payload: unknown }[];
let sendMock: ReturnType<typeof vi.fn<ChannelConnector['send']>>;
let fetchProfileMock: ReturnType<typeof vi.fn<NonNullable<ChannelConnector['fetchProfile']>>>;
let deps: PipelineDeps;
let bigJpeg: Buffer;
let smallJpeg: Buffer;

type FakePayload = { pageId: string; events: InboundEvent[] };

/** Connector giả: payload = { pageId, events }, gắn channelAccountId bằng resolver như connector thật. */
function fakeConnector(): ChannelConnector {
  return {
    type: 'messenger',
    verifyWebhook: () => true,
    async parseWebhook(body, resolveAccount) {
      const { pageId, events } = body as FakePayload;
      const account = await resolveAccount('messenger', pageId);
      if (!account) return [];
      return events.map((e) =>
        e.kind === 'message'
          ? { ...e, message: { ...e.message, channelAccountId: account.id } }
          : { ...e, channelAccountId: account.id },
      );
    },
    send: (...args) => sendMock(...args),
    fetchProfile: (...args) => fetchProfileMock(...args),
  };
}

const fakeFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url === 'http://media.test/photo.jpg') {
    return new Response(new Uint8Array(bigJpeg), { headers: { 'content-type': 'image/jpeg' } });
  }
  if (url === 'http://media.test/avatar.jpg') {
    return new Response(new Uint8Array(smallJpeg), { headers: { 'content-type': 'image/jpeg' } });
  }
  return new Response('not found', { status: 404 });
};

function inbound(
  externalUserId: string,
  externalMessageId: string,
  extra: Partial<NormalizedInboundMessage> = {},
): InboundEvent {
  return {
    kind: 'message',
    message: {
      channelAccountId: accountId,
      channelType: 'messenger',
      externalUserId,
      externalMessageId,
      direction: 'in',
      senderType: 'customer',
      text: 'Shop ơi tư vấn giúp em',
      attachments: [],
      sentAt: new Date(Date.now() - MINUTE),
      raw: { mid: externalMessageId },
      ...extra,
    },
  };
}

async function conversationOf(externalUserId: string) {
  const [row] = await db
    .select({ conversation: conversations, contact: contacts })
    .from(conversations)
    .innerJoin(contactIdentities, eq(contactIdentities.id, conversations.contactIdentityId))
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(
      and(
        eq(contactIdentities.channelAccountId, accountId),
        eq(contactIdentities.externalUserId, externalUserId),
      ),
    );
  return row!;
}

const messagesOf = (conversationId: string) =>
  db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(messages.sentAt);

async function queuedMessage(
  conversationId: string,
  values: Partial<typeof messages.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(messages)
    .values({
      conversationId,
      channelAccountId: accountId,
      senderType: 'agent',
      senderUserId: agentId,
      text: 'Dạ em chào chị',
      status: 'queued',
      raw: { outbound: {} },
      ...values,
    })
    .returning({ id: messages.id });
  return row!.id;
}

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
  const [account] = await db
    .insert(channelAccounts)
    .values({
      type: 'messenger',
      displayName: 'Fanpage Dezon',
      externalId: PAGE_ID,
      status: 'connected',
      credentials: { enc: JSON.stringify({ pageAccessToken: 'page-token' }) },
    })
    .returning({ id: channelAccounts.id });
  accountId = account!.id;
  bigJpeg = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#c33' } })
    .jpeg()
    .toBuffer();
  smallJpeg = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#3c3' } })
    .jpeg()
    .toBuffer();
});

afterAll(async () => {
  await handle?.close();
  await container?.stop();
});

beforeEach(() => {
  storage = createMemoryStorage();
  published = [];
  sendMock = vi.fn<ChannelConnector['send']>(async () => ({ externalMessageId: `m_sent_${Math.random()}` }));
  fetchProfileMock = vi.fn<NonNullable<ChannelConnector['fetchProfile']>>(async () => ({
    name: 'Chị Lan',
    avatarUrl: 'http://media.test/avatar.jpg',
  }));
  const publisher: RealtimePublisher = {
    emit: (rooms, event, payload) => published.push({ rooms, event, payload }),
  };
  const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  deps = {
    connectors: { messenger: fakeConnector() },
    storage,
    cipher: {
      encryptJson: (v) => JSON.stringify(v),
      decryptJson: <T>(s: string) => JSON.parse(s) as T,
    },
    publisher,
    ctx: {
      signUrl: async (key) => `signed:${key}`,
      now: () => new Date(),
      policy: { metaHumanAgentEnabled: false, zaloOaAllowPaidBot: false },
    },
    logger: silent,
    maxMediaBytes: 25 * 1024 * 1024,
    ownAppIds: { messenger: OWN_APP_ID },
    fetch: fakeFetch,
  };
});

describe('processInboundJob / tin khách', () => {
  it('tin text mới tạo contact (tên + avatar), identity, conversation và phát message.created', async () => {
    await processInboundJob(db, deps, {
      channelType: 'messenger',
      payload: { pageId: PAGE_ID, events: [inbound('psid-1', 'm_1')] },
      receivedAt: new Date().toISOString(),
    });

    const { conversation, contact } = await conversationOf('psid-1');
    expect(contact.displayName).toBe('Chị Lan');
    expect(contact.avatarUrl).toMatch(/^avatars\/\d{4}\/\d{2}\/.+\.jpg$/);
    expect(storage.objects.has(contact.avatarUrl!)).toBe(true);
    expect(conversation).toMatchObject({
      status: 'open',
      aiMode: 'off',
      unreadCount: 1,
      windowSource: 'organic',
      assignedUserId: null,
    });
    expect(conversation.lastCustomerMessageAt).not.toBeNull();
    expect(conversation.lastMessageAt).toEqual(conversation.lastCustomerMessageAt);

    const rows = await messagesOf(conversation.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      senderType: 'customer',
      status: 'received',
      text: 'Shop ơi tư vấn giúp em',
    });

    expect(published).toHaveLength(1);
    expect(published[0]!.event).toBe('message.created');
    expect(published[0]!.rooms.sort()).toEqual(['pool:unassigned', 'role:admin']);
    const payload = published[0]!.payload as {
      message: { id: string };
      conversation: { unreadCount: number };
    };
    expect(payload.message.id).toBe(rows[0]!.id);
    expect(payload.conversation.unreadCount).toBe(1);
  });

  it('không lấy được hồ sơ thì dùng tên dự phòng; tin sau lấy được thì thay tên', async () => {
    fetchProfileMock.mockRejectedValueOnce(new Error('(#100) cần Advanced Access'));
    await processInboundEvent(db, deps, inbound('psid-0001234', 'm_np1'));
    let { contact } = await conversationOf('psid-0001234');
    expect(contact.displayName).toBe('Khách Messenger …1234');
    expect(contact.avatarUrl).toBeNull();

    // Lần thử lại tiếp theo bị giới hạn tần suất: lùi đồng hồ để cho phép.
    const later = new Date(Date.now() + 5 * MINUTE);
    deps.ctx = { ...deps.ctx, now: () => later };
    await processInboundEvent(db, deps, inbound('psid-0001234', 'm_np2'));
    ({ contact } = await conversationOf('psid-0001234'));
    expect(contact.displayName).toBe('Chị Lan');
    expect(contact.avatarUrl).toMatch(/^avatars\//);
    expect(fetchProfileMock).toHaveBeenCalledTimes(2);
  });

  it('webhook trùng 2 lần chỉ lưu 1 tin và phát realtime 1 lần', async () => {
    const payload = { pageId: PAGE_ID, events: [inbound('psid-2', 'm_dup')] };
    const job = { channelType: 'messenger' as const, payload, receivedAt: new Date().toISOString() };
    await processInboundJob(db, deps, job);
    await processInboundJob(db, deps, job);
    const { conversation } = await conversationOf('psid-2');
    expect(await messagesOf(conversation.id)).toHaveLength(1);
    expect(conversation.unreadCount).toBe(1);
    expect(published.filter((p) => p.event === 'message.created')).toHaveLength(1);
  });

  it('hai tin đầu tiên của cùng khách xử lý song song: 1 contact, 1 hội thoại, 2 tin', async () => {
    await Promise.all([
      processInboundEvent(db, deps, inbound('psid-race', 'm_r1')),
      processInboundEvent(db, deps, inbound('psid-race', 'm_r2')),
    ]);
    const identities = await db
      .select()
      .from(contactIdentities)
      .where(eq(contactIdentities.externalUserId, 'psid-race'));
    expect(identities).toHaveLength(1);
    const { conversation } = await conversationOf('psid-race');
    expect(await messagesOf(conversation.id)).toHaveLength(2);
    expect(conversation.unreadCount).toBe(2);
    const orphan = await db.select().from(contacts).where(eq(contacts.displayName, 'Chị Lan'));
    const linked = await db.select({ id: contactIdentities.contactId }).from(contactIdentities);
    expect(orphan.every((c) => linked.some((l) => l.id === c.id))).toBe(true);
  });

  it('tin ảnh: tải về S3 (resize 1600px), tệp lỗi giữ original_url và storage_key rỗng', async () => {
    await processInboundEvent(
      db,
      deps,
      inbound('psid-3', 'm_img', {
        text: undefined,
        attachments: [
          { url: 'http://media.test/photo.jpg', type: 'image' },
          { url: 'http://media.test/broken', type: 'file', name: 'bao-gia.pdf' },
        ],
      }),
    );
    const { conversation } = await conversationOf('psid-3');
    const [msg] = await messagesOf(conversation.id);
    expect(msg!.text).toBeNull();
    expect(msg!.attachments).toHaveLength(2);
    expect(msg!.attachments[0]).toMatchObject({
      type: 'image',
      mime: 'image/jpeg',
      width: 1600,
      height: 1067,
      original_url: 'http://media.test/photo.jpg',
    });
    expect(msg!.attachments[0]!.storage_key).toMatch(/^media\/\d{4}\/\d{2}\/.+\.jpg$/);
    expect(storage.objects.has(msg!.attachments[0]!.storage_key)).toBe(true);
    expect(msg!.attachments[1]).toMatchObject({
      type: 'file',
      storage_key: '',
      original_url: 'http://media.test/broken',
      name: 'bao-gia.pdf',
    });
  });

  it('referral ADS đặt window_source = ads (kể cả đến sau)', async () => {
    await processInboundEvent(db, deps, inbound('psid-ads', 'm_a1'));
    expect((await conversationOf('psid-ads')).conversation.windowSource).toBe('organic');
    await processInboundEvent(
      db,
      deps,
      inbound('psid-ads', 'm_a2', { referral: { source: 'ADS', adId: '42' } }),
    );
    expect((await conversationOf('psid-ads')).conversation.windowSource).toBe('ads');
  });

  it('hội thoại resolved được mở lại khi khách nhắn', async () => {
    await processInboundEvent(db, deps, inbound('psid-4', 'm_4a'));
    const { conversation } = await conversationOf('psid-4');
    await db
      .update(conversations)
      .set({ status: 'resolved', unreadCount: 0 })
      .where(eq(conversations.id, conversation.id));
    await processInboundEvent(db, deps, inbound('psid-4', 'm_4b'));
    const after = (await conversationOf('psid-4')).conversation;
    expect(after.status).toBe('open');
    expect(after.unreadCount).toBe(1);
  });

  it('tài khoản kênh không có trong hệ thống hoặc đã ngắt: bỏ qua', async () => {
    await processInboundJob(db, deps, {
      channelType: 'messenger',
      payload: { pageId: 'page-khac', events: [inbound('psid-x', 'm_x')] },
      receivedAt: new Date().toISOString(),
    });
    expect(published).toHaveLength(0);
  });

  it('chưa cấu hình connector thì job thất bại với thông điệp rõ', async () => {
    deps.connectors = {};
    await expect(
      processInboundJob(db, deps, { channelType: 'messenger', payload: {}, receivedAt: '' }),
    ).rejects.toThrow(/Chưa cấu hình connector/);
  });
});

describe('tin echo', () => {
  const echo = (psid: string, mid: string, appId: number) =>
    inbound(psid, mid, {
      direction: 'out',
      senderType: 'agent',
      text: 'Dạ shop gửi chị bảng giá',
      raw: { message: { mid, is_echo: true, app_id: appId } },
    });

  it('echo từ app khác (Business Suite) lưu thành tin agent, không tăng unread', async () => {
    await processInboundEvent(db, deps, inbound('psid-5', 'm_5in'));
    await processInboundEvent(db, deps, echo('psid-5', 'm_5echo', 263902037430900));
    const { conversation } = await conversationOf('psid-5');
    const rows = await messagesOf(conversation.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ senderType: 'agent', senderUserId: null, status: 'sent' });
    expect(conversation.unreadCount).toBe(1);
    const created = published.filter((p) => p.event === 'message.created');
    expect((created[1]!.payload as { message: { senderLabel: string | null } }).message.senderLabel).toBe(
      'Meta Business Suite',
    );
  });

  it('echo của chính app bị bỏ qua (không tạo tin mới)', async () => {
    await processInboundEvent(db, deps, inbound('psid-6', 'm_6in'));
    published = [];
    await processInboundEvent(db, deps, echo('psid-6', 'm_6echo', Number(OWN_APP_ID)));
    const { conversation } = await conversationOf('psid-6');
    expect(await messagesOf(conversation.id)).toHaveLength(1);
    expect(published).toHaveLength(0);
  });
});

describe('delivery / read', () => {
  it('delivery theo mids và read theo watermark cập nhật status, phát message.updated', async () => {
    await processInboundEvent(db, deps, inbound('psid-7', 'm_7in'));
    const { conversation } = await conversationOf('psid-7');
    const t0 = new Date(Date.now() - 30_000);
    const t1 = new Date(Date.now() - 20_000);
    const [a] = await db
      .insert(messages)
      .values({
        conversationId: conversation.id,
        channelAccountId: accountId,
        senderType: 'agent',
        externalMessageId: 'm_7a',
        status: 'sent',
        sentAt: t0,
      })
      .returning();
    const [b] = await db
      .insert(messages)
      .values({
        conversationId: conversation.id,
        channelAccountId: accountId,
        senderType: 'agent',
        externalMessageId: 'm_7b',
        status: 'sent',
        sentAt: t1,
      })
      .returning();
    published = [];

    await processInboundEvent(db, deps, {
      kind: 'delivery',
      channelAccountId: accountId,
      externalUserId: 'psid-7',
      externalMessageIds: ['m_7a'],
      watermark: null,
    });
    let rows = await messagesOf(conversation.id);
    expect(rows.find((r) => r.id === a!.id)!.status).toBe('delivered');
    expect(rows.find((r) => r.id === b!.id)!.status).toBe('sent');
    expect(published.map((p) => p.event)).toEqual(['message.updated']);

    await processInboundEvent(db, deps, {
      kind: 'read',
      channelAccountId: accountId,
      externalUserId: 'psid-7',
      watermark: new Date(t1.getTime()),
    });
    rows = await messagesOf(conversation.id);
    expect(rows.find((r) => r.id === a!.id)!.status).toBe('seen');
    expect(rows.find((r) => r.id === b!.id)!.status).toBe('seen');
    // Tin của khách không bị đổi.
    expect(rows.find((r) => r.senderType === 'customer')!.status).toBe('received');
    expect(published).toHaveLength(3);
  });
});

describe('processOutboundMessage', () => {
  let conversationId: string;

  beforeEach(async () => {
    await db
      .update(channelAccounts)
      .set({ status: 'connected', lastError: null })
      .where(eq(channelAccounts.id, accountId));
    await processInboundEvent(db, deps, inbound('psid-out', `m_out_in_${Date.now()}`));
    conversationId = (await conversationOf('psid-out')).conversation.id;
    // Dọn tin queued còn sót của test trước (để không chặn thứ tự gửi) và cửa sổ quảng cáo.
    await db
      .update(messages)
      .set({ status: 'failed' })
      .where(and(eq(messages.conversationId, conversationId), eq(messages.status, 'queued')));
    await db
      .update(conversations)
      .set({ windowSource: 'organic', lastCustomerMessageAt: new Date(Date.now() - MINUTE) })
      .where(eq(conversations.id, conversationId));
    published = [];
  });

  it('gửi thành công: status sent + external id, phát message.updated', async () => {
    const id = await queuedMessage(conversationId);
    sendMock.mockResolvedValueOnce({ externalMessageId: 'm_ok_1' });
    await processOutboundMessage(db, deps, id);
    const [row] = await db.select().from(messages).where(eq(messages.id, id));
    expect(row).toMatchObject({ status: 'sent', externalMessageId: 'm_ok_1', error: null });
    expect(sendMock).toHaveBeenCalledOnce();
    const [account, to, part, options] = sendMock.mock.calls[0]!;
    expect(account).toMatchObject({ id: accountId, credentials: { pageAccessToken: 'page-token' } });
    expect(to).toEqual({ externalUserId: 'psid-out' });
    expect(part).toEqual({ kind: 'text', text: 'Dạ em chào chị' });
    expect(options).toEqual({ messageId: id });
    expect(published.map((p) => p.event)).toEqual(['message.updated']);

    // Chạy lại (job lặp): không gửi lần 2.
    await processOutboundMessage(db, deps, id);
    expect(sendMock).toHaveBeenCalledOnce();
  });

  it('tệp đính kèm được đọc từ storage và gửi dạng attachment', async () => {
    await storage.put('uploads/2026/11/a.png', Buffer.from('png-bytes'), 'image/png');
    const id = await queuedMessage(conversationId, {
      text: null,
      attachments: [
        { type: 'image', storage_key: 'uploads/2026/11/a.png', mime: 'image/png', name: 'mau.png' },
      ],
    });
    await processOutboundMessage(db, deps, id);
    const part = sendMock.mock.calls[0]![2] as Extract<OutboundPart, { kind: 'attachment' }>;
    expect(part).toMatchObject({ kind: 'attachment', type: 'image', mime: 'image/png', filename: 'mau.png' });
    expect(part.data.toString()).toBe('png-bytes');
  });

  it('lỗi vĩnh viễn do token: failed + kênh expired', async () => {
    const id = await queuedMessage(conversationId);
    sendMock.mockRejectedValueOnce(new PermanentSendError('Token của Fanpage đã hết hạn', true, 190));
    await processOutboundMessage(db, deps, id);
    const [row] = await db.select().from(messages).where(eq(messages.id, id));
    expect(row).toMatchObject({ status: 'failed', error: 'Token của Fanpage đã hết hạn' });
    const [account] = await db.select().from(channelAccounts).where(eq(channelAccounts.id, accountId));
    expect(account).toMatchObject({ status: 'expired', lastError: 'Token của Fanpage đã hết hạn' });
    expect(published.map((p) => p.event)).toEqual(['message.updated']);
  });

  it('lỗi tạm thời: ném lại để thử lại, tin vẫn queued; hết lượt thì markOutboundFailed', async () => {
    const id = await queuedMessage(conversationId);
    sendMock.mockRejectedValueOnce(new TransientSendError('Graph API 500'));
    await expect(processOutboundMessage(db, deps, id)).rejects.toBeInstanceOf(TransientSendError);
    let [row] = await db.select().from(messages).where(eq(messages.id, id));
    expect(row!.status).toBe('queued');
    expect(published).toHaveLength(0);

    await markOutboundFailed(db, deps, id, 'Gửi thất bại sau nhiều lần thử');
    [row] = await db.select().from(messages).where(eq(messages.id, id));
    expect(row).toMatchObject({ status: 'failed', error: 'Gửi thất bại sau nhiều lần thử' });
    expect(published.map((p) => p.event)).toEqual(['message.updated']);
  });

  it('hết cửa sổ gửi: failed kèm lý do, không gọi nền tảng', async () => {
    await db
      .update(conversations)
      .set({ lastCustomerMessageAt: new Date(Date.now() - 3 * 24 * 3600 * 1000) })
      .where(eq(conversations.id, conversationId));
    const id = await queuedMessage(conversationId);
    await processOutboundMessage(db, deps, id);
    const [row] = await db.select().from(messages).where(eq(messages.id, id));
    expect(row!.status).toBe('failed');
    expect(row!.error).toBeTruthy();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('kênh mất kết nối: failed, không gọi nền tảng', async () => {
    await db.update(channelAccounts).set({ status: 'expired' }).where(eq(channelAccounts.id, accountId));
    const id = await queuedMessage(conversationId);
    await processOutboundMessage(db, deps, id);
    const [row] = await db.select().from(messages).where(eq(messages.id, id));
    expect(row!.status).toBe('failed');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('giữ thứ tự: tin sau chờ khi tin trước còn queued; tin trước quá cũ (mồ côi) không chặn', async () => {
    const t0 = new Date(Date.now() - 1_000);
    const first = await queuedMessage(conversationId, { text: 'phần 1', sentAt: t0 });
    const second = await queuedMessage(conversationId, {
      text: 'phần 2',
      sentAt: new Date(t0.getTime() + 1),
    });
    await expect(processOutboundMessage(db, deps, second)).rejects.toBeInstanceOf(OutboundNotReadyError);
    expect(sendMock).not.toHaveBeenCalled();

    await processOutboundMessage(db, deps, first);
    await processOutboundMessage(db, deps, second);
    expect(sendMock.mock.calls.map((c) => (c[2] as { text: string }).text)).toEqual(['phần 1', 'phần 2']);

    // Tin queued "mồ côi" từ 10 phút trước không chặn tin mới.
    await queuedMessage(conversationId, { text: 'mồ côi', sentAt: new Date(Date.now() - 10 * MINUTE) });
    const fresh = await queuedMessage(conversationId, { text: 'mới' });
    await processOutboundMessage(db, deps, fresh);
    const [row] = await db.select().from(messages).where(eq(messages.id, fresh));
    expect(row!.status).toBe('sent');
  });

  it('phần trước lỗi hẳn: các phần sau cùng batch bị hủy (failed), không gửi', async () => {
    const t0 = new Date(Date.now() - 1_000);
    const raw = { outbound: { batchId: 'batch-1' } };
    const a = await queuedMessage(conversationId, { text: 'a', raw, sentAt: t0 });
    const b = await queuedMessage(conversationId, { text: 'b', raw, sentAt: new Date(t0.getTime() + 1) });
    const other = await queuedMessage(conversationId, {
      text: 'tin khác',
      raw: { outbound: { batchId: 'batch-2' } },
      sentAt: new Date(t0.getTime() + 2),
    });
    sendMock.mockRejectedValueOnce(new PermanentSendError('Khách không nhận được tin'));
    await processOutboundMessage(db, deps, a);
    await processOutboundMessage(db, deps, b);
    const rows = await db.select().from(messages).where(eq(messages.conversationId, conversationId));
    expect(rows.find((r) => r.id === a)!.status).toBe('failed');
    expect(rows.find((r) => r.id === b)).toMatchObject({ status: 'failed', error: MSG_BATCH_ABORTED });
    expect(rows.find((r) => r.id === other)!.status).toBe('queued');
    expect(sendMock).toHaveBeenCalledOnce();
    expect(published.filter((p) => p.event === 'message.updated')).toHaveLength(2);

    // Hết lượt thử lại (markOutboundFailed) cũng hủy phần sau.
    const batch3 = { outbound: { batchId: 'batch-3' } };
    const c = await queuedMessage(conversationId, { text: 'c', raw: batch3 });
    const d = await queuedMessage(conversationId, {
      text: 'd',
      raw: batch3,
      sentAt: new Date(Date.now() + 1_000),
    });
    await markOutboundFailed(db, deps, c, 'Gửi thất bại sau nhiều lần thử');
    const [rowD] = await db.select().from(messages).where(eq(messages.id, d));
    expect(rowD).toMatchObject({ status: 'failed', error: MSG_BATCH_ABORTED });
  });

  const outsideWindow = () =>
    new PermanentSendError(
      'Đã ngoài cửa sổ gửi tin của Messenger (mã 10/2018278)',
      false,
      '10/2018278',
      'outside_window',
    );
  const THREE_DAYS_AGO = () => new Date(Date.now() - 3 * 24 * 3600 * 1000);

  it('Meta báo ngoài cửa sổ (hội thoại quảng cáo): window_source -> organic, gửi lại kèm HUMAN_AGENT nếu bật', async () => {
    await db
      .update(conversations)
      .set({ windowSource: 'ads', lastCustomerMessageAt: THREE_DAYS_AGO() })
      .where(eq(conversations.id, conversationId));
    deps.ctx = { ...deps.ctx, policy: { metaHumanAgentEnabled: true, zaloOaAllowPaidBot: false } };
    const id = await queuedMessage(conversationId);
    sendMock.mockRejectedValueOnce(outsideWindow());
    sendMock.mockResolvedValueOnce({ externalMessageId: 'm_tagged' });
    await processOutboundMessage(db, deps, id);

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[0]![3]).toEqual({ messageId: id });
    expect(sendMock.mock.calls[1]![3]).toEqual({ messageId: id, tag: 'HUMAN_AGENT' });
    const [row] = await db.select().from(messages).where(eq(messages.id, id));
    expect(row).toMatchObject({ status: 'sent', externalMessageId: 'm_tagged' });
    expect((await conversationOf('psid-out')).conversation.windowSource).toBe('organic');
    const updated = published.find((p) => p.event === 'conversation.updated');
    const payload = updated!.payload as { conversation: { sendWindow: { tag?: string } } };
    expect(payload.conversation.sendWindow.tag).toBe('HUMAN_AGENT');
  });

  it('Meta báo ngoài cửa sổ, không dùng được HUMAN_AGENT: failed và sendWindow khóa', async () => {
    await db
      .update(conversations)
      .set({ windowSource: 'ads', lastCustomerMessageAt: THREE_DAYS_AGO() })
      .where(eq(conversations.id, conversationId));
    const id = await queuedMessage(conversationId);
    sendMock.mockRejectedValueOnce(outsideWindow());
    await processOutboundMessage(db, deps, id);
    expect(sendMock).toHaveBeenCalledOnce();
    const [row] = await db.select().from(messages).where(eq(messages.id, id));
    expect(row!.status).toBe('failed');
    const updated = published.find((p) => p.event === 'conversation.updated');
    const payload = updated!.payload as { conversation: { sendWindow: { allowed: boolean } } };
    expect(payload.conversation.sendWindow.allowed).toBe(false);
  });

  it('echo của chính app mang id message: đánh dấu sent ngay, lần thử lại không gửi trùng', async () => {
    const id = await queuedMessage(conversationId);
    const before = (await messagesOf(conversationId)).length;
    await processInboundEvent(
      db,
      deps,
      inbound('psid-out', 'm_echo_meta', {
        direction: 'out',
        senderType: 'agent',
        text: 'Dạ em chào chị',
        raw: {
          message: {
            mid: 'm_echo_meta',
            is_echo: true,
            app_id: Number(OWN_APP_ID),
            metadata: `dezon-inbox:${id}`,
          },
        },
      }),
    );
    const [row] = await db.select().from(messages).where(eq(messages.id, id));
    expect(row).toMatchObject({ status: 'sent', externalMessageId: 'm_echo_meta' });
    expect(published.map((p) => p.event)).toEqual(['message.updated']);
    expect(await messagesOf(conversationId)).toHaveLength(before);

    // Job thử lại sau timeout: không gửi trùng.
    await processOutboundMessage(db, deps, id);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('delivery về trước khi tin được ghi sent: job inbound xử lý sự kiện khác rồi ném ReceiptNotReadyError', async () => {
    const id = await queuedMessage(conversationId, { sentAt: new Date(Date.now() - 1_000) });
    const events: InboundEvent[] = [
      {
        kind: 'delivery',
        channelAccountId: accountId,
        externalUserId: 'psid-out',
        externalMessageIds: ['m_race'],
        watermark: new Date(),
      },
      inbound('psid-out', 'm_after_receipt'),
    ];
    const job = {
      channelType: 'messenger' as const,
      payload: { pageId: PAGE_ID, events },
      receivedAt: new Date().toISOString(),
    };
    await expect(processInboundJob(db, deps, job)).rejects.toBeInstanceOf(ReceiptNotReadyError);
    // Tin khách đi sau receipt vẫn được lưu ngay.
    const saved = await messagesOf(conversationId);
    expect(saved.some((m) => m.externalMessageId === 'm_after_receipt')).toBe(true);

    sendMock.mockResolvedValueOnce({ externalMessageId: 'm_race' });
    await processOutboundMessage(db, deps, id);
    await processInboundJob(db, deps, job); // BullMQ chạy lại
    const [row] = await db.select().from(messages).where(eq(messages.id, id));
    expect(row!.status).toBe('delivered');
  });

  it('delivery chỉ có mid đã biết: không thử lại dù còn tin queued', async () => {
    await queuedMessage(conversationId, { sentAt: new Date(Date.now() - 1_000) });
    const [known] = await db
      .insert(messages)
      .values({
        conversationId,
        channelAccountId: accountId,
        senderType: 'agent',
        externalMessageId: 'm_known',
        status: 'sent',
        sentAt: new Date(Date.now() - 2_000),
      })
      .returning();
    await processInboundEvent(db, deps, {
      kind: 'delivery',
      channelAccountId: accountId,
      externalUserId: 'psid-out',
      externalMessageIds: ['m_known'],
      watermark: new Date(),
    });
    const [row] = await db.select().from(messages).where(eq(messages.id, known!.id));
    expect(row!.status).toBe('delivered');
  });
});
