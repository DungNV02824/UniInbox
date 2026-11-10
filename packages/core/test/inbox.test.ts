import { auditLogs, contactTags, conversations, messages, type Db } from '@dezon/db';
import type { ConversationSummary, ListConversationsQuery } from '@dezon/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  markConversationRead,
  sendAgentMessage,
  updateContact,
  updateConversation,
} from '../src/inbox/commands';
import {
  InboxForbiddenError,
  InboxNotFoundError,
  InboxValidationError,
  SendNotAllowedError,
} from '../src/inbox/errors';
import {
  getConversationDetail,
  getConversationSummary,
  getMessageDto,
  listConversations,
  listMessages,
  recentConversationIdsOfContacts,
} from '../src/inbox/queries';
import { splitOutboundText } from '../src/inbox/split-text';
import {
  addMessage,
  ago,
  createChannel,
  createConversation,
  HOUR,
  makeCtx,
  startTestDb,
  type CreateConversationInput,
  type TestDb,
} from './inbox-fixtures';

let t: TestDb;
let db: Db;
const ctx = makeCtx();

beforeAll(async () => {
  t = await startTestDb();
  db = t.db;
});

afterAll(async () => {
  await t?.stop();
});

const q = (over: Partial<ListConversationsQuery> = {}): ListConversationsQuery => ({ limit: 100, ...over });
const ids = (items: { id: string }[]) => items.map((i) => i.id);

/** Lấy hết các trang với limit nhỏ. */
async function collectAll(viewer: TestDb['admin'], query: ListConversationsQuery) {
  const all: ConversationSummary[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await listConversations(db, viewer, { ...query, ...(cursor ? { cursor } : {}) }, ctx);
    all.push(...page.items);
    if (!page.nextCursor) return all;
    cursor = page.nextCursor;
  }
  throw new Error('Phân trang không kết thúc');
}

describe('quyền xem hội thoại', () => {
  it('admin thấy tất cả; agent thấy của mình + chưa phân công; không thấy của người khác', async () => {
    const channel = await createChannel(db);
    const mine = await createConversation(db, {
      channel,
      assignedUserId: t.agent.id,
      lastMessageAt: ago(1000),
    });
    const free = await createConversation(db, { channel, lastMessageAt: ago(2000) });
    const other = await createConversation(db, {
      channel,
      assignedUserId: t.agent2.id,
      lastMessageAt: ago(3000),
    });
    const filter = q({ channelAccountId: channel.id });

    expect(ids((await listConversations(db, t.admin, filter, ctx)).items)).toEqual([
      mine.id,
      free.id,
      other.id,
    ]);
    expect(ids((await listConversations(db, t.agent, filter, ctx)).items)).toEqual([mine.id, free.id]);
    expect(ids((await listConversations(db, t.agent2, filter, ctx)).items)).toEqual([free.id, other.id]);

    await expect(getConversationDetail(db, t.agent, other.id, ctx)).rejects.toBeInstanceOf(
      InboxForbiddenError,
    );
    await expect(listMessages(db, t.agent, other.id, { limit: 10 }, ctx)).rejects.toBeInstanceOf(
      InboxForbiddenError,
    );
    await expect(
      getConversationDetail(db, t.admin, '00000000-0000-4000-8000-000000000000', ctx),
    ).rejects.toBeInstanceOf(InboxNotFoundError);
    const detail = await getConversationDetail(db, t.agent, free.id, ctx);
    expect(detail.id).toBe(free.id);
  });
});

describe('listConversations', () => {
  it('bộ lọc channelType, channelAccountId, status, assignee, unread', async () => {
    const fb = await createChannel(db);
    const zalo = await createChannel(db, { type: 'zalo_oa', displayName: 'OA Dezon' });
    const a = await createConversation(db, { channel: fb, assignedUserId: t.agent.id, unreadCount: 2 });
    const b = await createConversation(db, { channel: fb, status: 'resolved' });
    const c = await createConversation(db, { channel: zalo, assignedUserId: t.agent2.id, unreadCount: 1 });

    const zaloIds = ids((await listConversations(db, t.admin, q({ channelType: 'zalo_oa' }), ctx)).items);
    expect(zaloIds).toContain(c.id);
    expect(zaloIds).not.toContain(a.id);

    const inFb = (over: Partial<ListConversationsQuery>) =>
      listConversations(db, t.admin, q({ channelAccountId: fb.id, ...over }), ctx).then((p) => ids(p.items));
    expect(await inFb({ status: 'resolved' })).toEqual([b.id]);
    expect(await inFb({ unread: true })).toEqual([a.id]);
    expect((await inFb({ unread: false })).sort()).toEqual([a.id, b.id].sort());
    expect(await inFb({ assignee: 'none' })).toEqual([b.id]);
    expect(await inFb({ assignee: t.agent.id })).toEqual([a.id]);
    const mine = await listConversations(db, t.agent, q({ channelAccountId: fb.id, assignee: 'me' }), ctx);
    expect(ids(mine.items)).toEqual([a.id]);
    // Agent lọc theo người khác: quyền xem vẫn áp dụng => rỗng.
    const others = await listConversations(
      db,
      t.agent,
      q({ channelAccountId: zalo.id, assignee: t.agent2.id }),
      ctx,
    );
    expect(others.items).toEqual([]);
  });

  it('cursor: không trùng, không sót, kể cả mốc thời gian trùng nhau và NULL', async () => {
    const channel = await createChannel(db);
    const same = ago(5 * HOUR);
    const created: string[] = [];
    for (let i = 0; i < 13; i++) {
      // 5 hội thoại cùng mốc, 3 hội thoại chưa có tin (NULL), còn lại mốc khác nhau (có micro giây).
      const lastMessageAt = i < 5 ? same : i < 8 ? null : new Date(Date.now() - i * 60_000 + 0.5);
      created.push((await createConversation(db, { channel, lastMessageAt })).id);
    }
    // Mốc có phần micro giây (không biểu diễn được bằng Date của JS).
    await db
      .update(conversations)
      .set({ lastMessageAt: new Date(Date.now() - 30 * HOUR) })
      .where(eq(conversations.id, created[12]!));
    await db.execute(
      sql`update conversations set last_message_at = last_message_at + interval '123 microseconds' where id = ${created[12]!}`,
    );

    const full = await listConversations(db, t.admin, q({ channelAccountId: channel.id }), ctx);
    expect(full.items).toHaveLength(13);
    expect(full.nextCursor).toBeNull();
    // NULLS LAST
    expect(full.items.slice(-3).every((s) => s.lastMessageAt === null)).toBe(true);

    for (const limit of [1, 2, 4, 5]) {
      const paged = await collectAll(t.admin, q({ channelAccountId: channel.id, limit }));
      expect(ids(paged)).toEqual(ids(full.items));
    }
  });

  it('cursor sai định dạng => InboxValidationError', async () => {
    await expect(listConversations(db, t.admin, q({ cursor: 'rác' }), ctx)).rejects.toBeInstanceOf(
      InboxValidationError,
    );
  });

  it('preview tin cuối, avatar ký URL, cửa sổ gửi', async () => {
    const channel = await createChannel(db, { displayName: 'Fanpage A', color: '#16a34a' });
    const lastAt = ago(HOUR);
    const conv = await createConversation(db, {
      channel,
      contactName: 'Chị Mai',
      avatarKey: 'avatars/mai.jpg',
      assignedUserId: t.agent.id,
      lastCustomerMessageAt: ago(2 * HOUR),
      lastMessageAt: lastAt,
      windowSource: 'organic',
    });
    await addMessage(db, conv, { text: 'Chào shop', sentAt: ago(2 * HOUR) });
    await addMessage(db, conv, {
      senderType: 'agent',
      senderUserId: t.agent.id,
      text: null,
      attachments: [{ type: 'image', storage_key: 'uploads/a.jpg', mime: 'image/jpeg' }],
      sentAt: lastAt,
    });

    const [s] = (await listConversations(db, t.admin, q({ channelAccountId: channel.id }), ctx)).items;
    expect(s).toMatchObject({
      id: conv.id,
      assignedUser: { id: t.agent.id, name: 'Hương' },
      contact: { displayName: 'Chị Mai', avatarUrl: 'https://signed.test/avatars/mai.jpg', tags: [] },
      channel: { id: channel.id, type: 'messenger', displayName: 'Fanpage A', color: '#16a34a' },
      lastMessage: { text: null, senderType: 'agent', hasAttachments: true },
      sendWindow: { allowed: true },
    });
    expect(s!.lastMessage!.sentAt).toBe(conv.lastMessageAt!.toISOString());
    expect(s!.sendWindow.expiresAt).toBe(
      new Date(conv.lastCustomerMessageAt!.getTime() + 24 * HOUR).toISOString(),
    );

    const empty = await createConversation(db, { channel });
    const summary = await getConversationSummary(db, empty.id, ctx);
    expect(summary.lastMessage).toBeNull();
    expect(summary.contact.avatarUrl).toBeNull();
    expect(summary.sendWindow.allowed).toBe(false);
  });

  it('hội thoại từ quảng cáo: cửa sổ 7 ngày tính từ tin đầu tiên của khách', async () => {
    const channel = await createChannel(db);
    const conv = await createConversation(db, {
      channel,
      windowSource: 'ads',
      lastCustomerMessageAt: ago(3 * 24 * HOUR),
    });
    const first = ago(4 * 24 * HOUR);
    await addMessage(db, conv, { text: 'Tôi thấy quảng cáo', sentAt: first });
    await addMessage(db, conv, { text: 'Còn hàng không?', sentAt: ago(3 * 24 * HOUR) });
    const s = await getConversationSummary(db, conv.id, ctx);
    expect(s.sendWindow).toMatchObject({ allowed: true });
    expect(s.sendWindow.expiresAt).toBe(new Date(first.getTime() + 7 * 24 * HOUR).toISOString());
  });
});

describe('getConversationDetail', () => {
  it('kèm contactDetail và identities có kênh + conversationId', async () => {
    const channel = await createChannel(db, { displayName: 'Fanpage B' });
    const conv = await createConversation(db, { channel, contactName: 'Anh Tuấn' });
    const d = await getConversationDetail(db, t.admin, conv.id, ctx);
    expect(d.contactDetail).toMatchObject({
      id: conv.contactId,
      displayName: 'Anh Tuấn',
      tags: [],
      notes: null,
      identities: [{ conversationId: conv.id, channel: { id: channel.id, displayName: 'Fanpage B' } }],
    });
  });
});

describe('listMessages', () => {
  it('phân trang ngược, items tăng dần, tệp đính kèm ký URL, người gửi', async () => {
    const channel = await createChannel(db);
    const conv = await createConversation(db, { channel });
    const base = Date.now() - 10 * HOUR;
    const created: string[] = [];
    for (let i = 0; i < 7; i++) {
      created.push(await addMessage(db, conv, { text: `tin ${i}`, sentAt: new Date(base + i * 60_000) }));
    }
    // Hai tin cùng thời điểm: thứ tự theo id.
    created.push(await addMessage(db, conv, { text: 'tin 7a', sentAt: new Date(base + 7 * 60_000) }));
    created.push(await addMessage(db, conv, { text: 'tin 7b', sentAt: new Date(base + 7 * 60_000) }));

    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = await listMessages(db, t.admin, conv.id, { limit: 3, ...(cursor ? { cursor } : {}) }, ctx);
      const times = page.items.map((m) => m.sentAt);
      expect([...times].sort()).toEqual(times);
      pages.push(ids(page.items));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(pages).toHaveLength(3);
    const all = pages.reverse().flat();
    expect(new Set(all).size).toBe(9);
    expect(all.slice(0, 7)).toEqual(created.slice(0, 7));
  });

  it('attachments, senderUser, senderLabel cho tin echo', async () => {
    const channel = await createChannel(db);
    const conv = await createConversation(db, { channel });
    const t0 = Date.now() - HOUR;
    await addMessage(db, conv, {
      text: 'ảnh',
      attachments: [
        { type: 'image', storage_key: 'media/x.jpg', mime: 'image/jpeg', width: 800, height: 600 },
        { type: 'file', storage_key: '', mime: 'application/pdf', name: 'bao-gia.pdf' },
      ],
      sentAt: new Date(t0),
    });
    await addMessage(db, conv, {
      senderType: 'agent',
      senderUserId: t.agent.id,
      text: 'dạ',
      sentAt: new Date(t0 + 1000),
    });
    const echoId = await addMessage(db, conv, {
      senderType: 'agent',
      text: 'gửi từ Business Suite',
      raw: { message: { is_echo: true } },
      sentAt: new Date(t0 + 2000),
    });

    const { items } = await listMessages(db, t.agent, conv.id, { limit: 50 }, ctx);
    expect(items[0]!.attachments).toEqual([
      { type: 'image', mime: 'image/jpeg', url: 'https://signed.test/media/x.jpg', width: 800, height: 600 },
      { type: 'file', mime: 'application/pdf', url: null, name: 'bao-gia.pdf' },
    ]);
    expect(items[0]!.senderUser).toBeNull();
    expect(items[1]).toMatchObject({ senderUser: { id: t.agent.id, name: 'Hương' }, senderLabel: null });
    expect(items[2]).toMatchObject({ senderUser: null, senderLabel: 'Meta Business Suite' });
    expect((await getMessageDto(db, echoId, ctx)).senderLabel).toBe('Meta Business Suite');
  });
});

describe('splitOutboundText', () => {
  it('ưu tiên cắt ở xuống dòng/khoảng trắng, mỗi đoạn ≤ 1999', () => {
    const words = Array.from({ length: 900 }, (_, i) => `từ${i}`).join(' ');
    const parts = splitOutboundText(words);
    expect(parts.every((p) => p.length <= 1999)).toBe(true);
    expect(parts.join(' ')).toBe(words);
    const lines = `${'a'.repeat(1500)}\n${'b'.repeat(1500)}`;
    expect(splitOutboundText(lines)).toEqual(['a'.repeat(1500), 'b'.repeat(1500)]);
    expect(splitOutboundText('x'.repeat(4500)).map((p) => p.length)).toEqual([1999, 1999, 502]);
    expect(splitOutboundText('   ')).toEqual([]);
  });
});

describe('sendAgentMessage', () => {
  async function openConversation(over: Partial<CreateConversationInput> = {}) {
    const channel = over.channel ?? (await createChannel(db));
    return createConversation(db, {
      lastCustomerMessageAt: ago(HOUR),
      lastMessageAt: ago(HOUR),
      ...over,
      channel,
    });
  }

  it('tách 4500 ký tự thành 3 tin + 1 tin cho tệp, status queued, cập nhật last_message_at', async () => {
    const conv = await openConversation();
    const text = 'x'.repeat(4500);
    const res = await sendAgentMessage(
      db,
      t.agent,
      conv.id,
      {
        text,
        attachments: [{ storageKey: 'uploads/q.pdf', type: 'file', mime: 'application/pdf', name: 'q.pdf' }],
        clientId: 'tmp-1',
      },
      ctx,
    );
    expect(res.messages).toHaveLength(4);
    expect(res.messages.map((m) => m.text?.length ?? null)).toEqual([1999, 1999, 502, null]);
    expect(res.messages[3]!.attachments).toEqual([
      { type: 'file', mime: 'application/pdf', url: 'https://signed.test/uploads/q.pdf', name: 'q.pdf' },
    ]);
    for (const m of res.messages) {
      expect(m).toMatchObject({
        status: 'queued',
        senderType: 'agent',
        senderUser: { id: t.agent.id },
        senderLabel: null,
        clientId: 'tmp-1',
        conversationId: conv.id,
      });
    }
    expect(res.conversation.lastMessageAt).toBe(res.messages[3]!.sentAt);
    expect(res.conversation.lastMessage).toMatchObject({ senderType: 'agent', hasAttachments: true });

    const rows = await db.select().from(messages).where(eq(messages.conversationId, conv.id));
    expect(rows.every((r) => r.channelAccountId === conv.channelAccountId)).toBe(true);
    // Mọi phần của một lần gửi chung một batchId (worker hủy phần sau nếu phần trước lỗi hẳn).
    const batchId = (rows[0]!.raw as { outbound: { batchId: string } }).outbound.batchId;
    expect(rows[0]!.raw).toEqual({ outbound: { batchId: expect.any(String) } });
    expect(rows.every((r) => (r.raw as { outbound: { batchId: string } }).outbound.batchId === batchId)).toBe(
      true,
    );
    expect(rows.find((r) => r.text === null)!.attachments).toEqual([
      { type: 'file', storage_key: 'uploads/q.pdf', mime: 'application/pdf', name: 'q.pdf' },
    ]);
  });

  it('cùng clientId => trả tin cũ (duplicate), kể cả khi gửi đồng thời; clientId khác => tạo mới', async () => {
    const conv = await openConversation();
    const input = { text: 'y'.repeat(2500), attachments: [], clientId: 'dup-1' };
    const [a, b] = await Promise.all([
      sendAgentMessage(db, t.agent, conv.id, input, ctx),
      sendAgentMessage(db, t.agent, conv.id, input, ctx),
    ]);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    expect(a.messages.map((m) => m.id)).toEqual(b.messages.map((m) => m.id));
    expect(b.messages).toHaveLength(2);
    expect(b.messages.every((m) => m.clientId === 'dup-1')).toBe(true);

    // Lần trước gửi được nhưng nay ngoài cửa sổ: vẫn trả tin cũ thay vì báo lỗi.
    await db
      .update(conversations)
      .set({ lastCustomerMessageAt: ago(25 * HOUR) })
      .where(eq(conversations.id, conv.id));
    const late = await sendAgentMessage(db, t.agent, conv.id, input, ctx);
    expect(late.duplicate).toBe(true);
    expect(await db.select().from(messages).where(eq(messages.conversationId, conv.id))).toHaveLength(2);

    await db
      .update(conversations)
      .set({ lastCustomerMessageAt: ago(HOUR) })
      .where(eq(conversations.id, conv.id));
    const other = await sendAgentMessage(db, t.agent, conv.id, { ...input, clientId: 'dup-2' }, ctx);
    expect(other.duplicate).toBe(false);
    const rows = await db.select().from(messages).where(eq(messages.conversationId, conv.id));
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.clientId === 'dup-2')).toHaveLength(2);
  });

  it('cùng clientId nhưng agent không có quyền xem => vẫn 403', async () => {
    const conv = await openConversation();
    await sendAgentMessage(db, t.admin, conv.id, { text: 'hi', attachments: [], clientId: 'dup-3' }, ctx);
    await db.update(conversations).set({ assignedUserId: t.agent2.id }).where(eq(conversations.id, conv.id));
    await expect(
      sendAgentMessage(db, t.agent, conv.id, { text: 'hi', attachments: [], clientId: 'dup-3' }, ctx),
    ).rejects.toBeInstanceOf(InboxForbiddenError);
  });

  it('chặn khi quá 24h; cho phép kèm tag HUMAN_AGENT nếu bật', async () => {
    const conv = await openConversation({ lastCustomerMessageAt: ago(25 * HOUR) });
    const err = await sendAgentMessage(db, t.agent, conv.id, { text: 'hi', attachments: [] }, ctx).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SendNotAllowedError);
    expect((err as Error).message).toContain('24 giờ');
    expect(await db.select().from(messages).where(eq(messages.conversationId, conv.id))).toHaveLength(0);

    const humanCtx = makeCtx({ policy: { metaHumanAgentEnabled: true, zaloOaAllowPaidBot: false } });
    const res = await sendAgentMessage(db, t.agent, conv.id, { text: 'hi', attachments: [] }, humanCtx);
    const [row] = await db.select().from(messages).where(eq(messages.id, res.messages[0]!.id));
    expect(row!.raw).toEqual({ outbound: { tag: 'HUMAN_AGENT', batchId: expect.any(String) } });
    expect(res.conversation.sendWindow.tag).toBe('HUMAN_AGENT');
  });

  it('chặn khi kênh mất kết nối', async () => {
    const channel = await createChannel(db, { status: 'disconnected', displayName: 'Page cũ' });
    const conv = await openConversation({ channel });
    await expect(
      sendAgentMessage(db, t.admin, conv.id, { text: 'hi', attachments: [] }, ctx),
    ).rejects.toThrow(/Page cũ.*mất kết nối/);
  });

  it('agent không gửi được vào hội thoại của người khác', async () => {
    const conv = await openConversation({ assignedUserId: t.agent2.id });
    await expect(
      sendAgentMessage(db, t.agent, conv.id, { text: 'hi', attachments: [] }, ctx),
    ).rejects.toBeInstanceOf(InboxForbiddenError);
  });
});

describe('markConversationRead', () => {
  it('đặt unread_count = 0', async () => {
    const channel = await createChannel(db);
    const conv = await createConversation(db, { channel, unreadCount: 4 });
    const s = await markConversationRead(db, t.agent, conv.id, ctx);
    expect(s.unreadCount).toBe(0);
    const other = await createConversation(db, { channel, unreadCount: 1, assignedUserId: t.agent2.id });
    await expect(markConversationRead(db, t.agent, other.id, ctx)).rejects.toBeInstanceOf(
      InboxForbiddenError,
    );
  });
});

describe('updateConversation', () => {
  const auditsOf = (id: string) =>
    db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entity, 'conversation'), eq(auditLogs.entityId, id)))
      .orderBy(asc(auditLogs.createdAt));

  it('agent nhận về mình, không giao cho người khác, bỏ nhận của mình', async () => {
    const channel = await createChannel(db);
    const conv = await createConversation(db, { channel });

    await expect(
      updateConversation(db, t.agent, conv.id, { assignedUserId: t.agent2.id }, ctx),
    ).rejects.toBeInstanceOf(InboxForbiddenError);

    const claimed = await updateConversation(db, t.agent, conv.id, { assignedUserId: t.agent.id }, ctx);
    expect(claimed.previousAssigneeId).toBeNull();
    expect(claimed.conversation.assignedUser).toEqual({ id: t.agent.id, name: 'Hương' });

    // agent2 không còn thấy hội thoại này.
    await expect(
      updateConversation(db, t.agent2, conv.id, { status: 'resolved' }, ctx),
    ).rejects.toBeInstanceOf(InboxForbiddenError);

    const released = await updateConversation(db, t.agent, conv.id, { assignedUserId: null }, ctx);
    expect(released.previousAssigneeId).toBe(t.agent.id);
    expect(released.conversation.assignedUser).toBeNull();

    const audits = await auditsOf(conv.id);
    expect(audits.map((a) => a.action)).toEqual(['conversation.assign', 'conversation.assign']);
    expect(audits[0]).toMatchObject({ userId: t.agent.id, data: { from: null, to: t.agent.id } });
  });

  it('admin phân công cho nhân viên đang hoạt động, đổi trạng thái', async () => {
    const channel = await createChannel(db);
    const conv = await createConversation(db, { channel, assignedUserId: t.agent.id });

    await expect(
      updateConversation(db, t.admin, conv.id, { assignedUserId: t.inactiveUserId }, ctx),
    ).rejects.toBeInstanceOf(InboxValidationError);

    const res = await updateConversation(
      db,
      t.admin,
      conv.id,
      { assignedUserId: t.agent2.id, status: 'resolved' },
      ctx,
    );
    expect(res.previousAssigneeId).toBe(t.agent.id);
    expect(res.conversation).toMatchObject({ status: 'resolved', assignedUser: { id: t.agent2.id } });
    expect((await auditsOf(conv.id)).map((a) => a.action).sort()).toEqual([
      'conversation.assign',
      'conversation.status',
    ]);

    // Không đổi gì => không ghi audit.
    await updateConversation(db, t.admin, conv.id, { status: 'resolved' }, ctx);
    expect(await auditsOf(conv.id)).toHaveLength(2);
  });
});

describe('updateContact', () => {
  it('agent sửa được khách của hội thoại mình xem được; ghi audit không chứa nội dung', async () => {
    const channel = await createChannel(db);
    const visible = await createConversation(db, { channel, contactName: 'Cũ' });
    const hidden = await createConversation(db, { channel, assignedUserId: t.agent2.id });
    await db
      .insert(contactTags)
      .values([{ name: 'vip' }, { name: 'sofa' }])
      .onConflictDoNothing();

    const d = await updateContact(
      db,
      t.agent,
      visible.contactId,
      { displayName: 'Chị Hoa', notes: 'Thích màu xanh', tags: ['vip', 'vip', 'sofa'] },
      ctx,
    );
    expect(d).toMatchObject({ displayName: 'Chị Hoa', notes: 'Thích màu xanh', tags: ['vip', 'sofa'] });
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, visible.contactId));
    expect(audit).toMatchObject({ action: 'contact.update', userId: t.agent.id });
    expect(JSON.stringify(audit!.data)).not.toContain('xanh');

    await expect(updateContact(db, t.agent, hidden.contactId, { notes: 'x' }, ctx)).rejects.toBeInstanceOf(
      InboxForbiddenError,
    );
    expect((await updateContact(db, t.admin, hidden.contactId, { notes: 'x' }, ctx)).notes).toBe('x');
  });

  it('contact.tags có trong summary danh sách + chi tiết, đúng thứ tự đã lưu', async () => {
    const channel = await createChannel(db);
    const conv = await createConversation(db, { channel, contactName: 'Chị Tag', lastMessageAt: ago(HOUR) });
    await db
      .insert(contactTags)
      .values([{ name: 'vip' }, { name: 'sofa' }])
      .onConflictDoNothing();
    await updateContact(db, t.admin, conv.contactId, { tags: ['sofa', 'VIP'] }, ctx);

    const [s] = (await listConversations(db, t.admin, q({ channelAccountId: channel.id }), ctx)).items;
    expect(s!.contact).toEqual({
      id: conv.contactId,
      displayName: 'Chị Tag',
      avatarUrl: null,
      tags: ['sofa', 'vip'],
    });
    const d = await getConversationDetail(db, t.admin, conv.id, ctx);
    expect(d.contact.tags).toEqual(['sofa', 'vip']);
    expect(d.contactDetail.tags).toEqual(['sofa', 'vip']);
    expect((await getConversationSummary(db, conv.id, ctx)).contact.tags).toEqual(['sofa', 'vip']);
  });
});

describe('recentConversationIdsOfContacts', () => {
  it('hội thoại của các khách, mới nhất trước, giới hạn số lượng', async () => {
    const channel = await createChannel(db);
    const a = await createConversation(db, { channel, lastMessageAt: ago(3 * HOUR) });
    const b = await createConversation(db, { channel, lastMessageAt: ago(HOUR) });
    const never = await createConversation(db, { channel });
    await createConversation(db, { channel, lastMessageAt: ago(10) });
    const contactIds = [a.contactId, b.contactId, never.contactId];
    expect(await recentConversationIdsOfContacts(db, contactIds, 10)).toEqual([b.id, a.id, never.id]);
    expect(await recentConversationIdsOfContacts(db, contactIds, 1)).toEqual([b.id]);
    expect(await recentConversationIdsOfContacts(db, [], 10)).toEqual([]);
  });
});
