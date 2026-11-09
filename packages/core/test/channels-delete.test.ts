import {
  auditLogs,
  channelAccounts,
  contactIdentities,
  contacts,
  conversations,
  customerMemories,
  messages,
  type Db,
} from '@dezon/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteChannel } from '../src/channels/delete';
import { listChannels } from '../src/channels/service';
import { ChannelDeleteConflictError, InboxNotFoundError, InboxValidationError } from '../src/inbox/errors';
import type { MediaStorage } from '../src/media/types';
import { createMemoryStorage } from './helpers/memory-storage';
import {
  addMessage,
  ago,
  createChannel,
  createConversation,
  HOUR,
  startTestDb,
  type TestDb,
} from './inbox-fixtures';

let t: TestDb;
let db: Db;

beforeAll(async () => {
  t = await startTestDb();
  db = t.db;
});

afterAll(async () => {
  await t?.stop();
});

const media = (key: string) => ({ type: 'image' as const, mime: 'image/jpeg', storage_key: key });

function silentLogger() {
  const warnings: string[] = [];
  return {
    warnings,
    logger: { warn: (_o: object, msg?: string) => warnings.push(msg ?? ''), info: () => undefined },
  };
}

describe('deleteChannel', () => {
  it('xóa kênh đã ngắt: tin, hội thoại, danh tính, khách chỉ có ở kênh này; giữ khách còn ở kênh khác', async () => {
    const doomed = await createChannel(db, {
      displayName: 'Trang cũ',
      status: 'disconnected',
      credentials: null,
    });
    const keep = await createChannel(db, { displayName: 'Trang đang dùng' });

    // Khách chỉ có ở kênh bị xóa (có avatar S3 + bộ nhớ khách).
    const onlyHere = await createConversation(db, {
      channel: doomed,
      contactName: 'Chỉ kênh cũ',
      avatarKey: 'avatars/only-here.jpg',
    });
    await addMessage(db, onlyHere, {
      sentAt: ago(2 * HOUR),
      text: 'xin chào',
      attachments: [media('media/a.jpg'), media(''), media('media/b.jpg')],
    });
    const m2 = await addMessage(db, onlyHere, { sentAt: ago(HOUR), text: 'giá bao nhiêu?' });
    await db.insert(customerMemories).values({ contactId: onlyHere.contactId, updatedFromMessageId: m2 });

    // Khách có avatar là URL http (không phải tệp của mình) => không xóa trên S3.
    const httpAvatar = await createConversation(db, {
      channel: doomed,
      contactName: 'Avatar ngoài',
      avatarKey: 'https://cdn.example.com/a.jpg',
    });
    await addMessage(db, httpAvatar, { sentAt: ago(HOUR), attachments: [media('media/a.jpg')] });

    // Khách có mặt ở cả hai kênh: phải giữ khách + danh tính/hội thoại ở kênh còn lại.
    const shared = await createConversation(db, {
      channel: keep,
      contactName: 'Khách hai kênh',
      avatarKey: 'avatars/shared.jpg',
    });
    const keptMsg = await addMessage(db, shared, {
      sentAt: ago(HOUR),
      attachments: [media('media/keep.jpg')],
    });
    const [sharedIdentity] = await db
      .insert(contactIdentities)
      .values({
        contactId: shared.contactId,
        channelAccountId: doomed.id,
        externalUserId: 'psid-shared-doomed',
      })
      .returning();
    const [sharedDoomedConv] = await db
      .insert(conversations)
      .values({
        contactId: shared.contactId,
        channelAccountId: doomed.id,
        contactIdentityId: sharedIdentity!.id,
      })
      .returning();
    await addMessage(db, sharedDoomedConv!, { sentAt: ago(HOUR), attachments: [media('media/c.pdf')] });

    const before = (await listChannels(db)).find((c) => c.id === doomed.id);
    expect(before?.stats).toEqual({ conversations: 3, messages: 4 });

    const storage = createMemoryStorage();
    for (const key of [
      'media/a.jpg',
      'media/b.jpg',
      'media/c.pdf',
      'media/keep.jpg',
      'avatars/only-here.jpg',
      'avatars/shared.jpg',
    ]) {
      await storage.put(key, Buffer.from('x'), 'application/octet-stream');
    }
    const deletedKeys: string[] = [];
    const spy: MediaStorage = {
      ...storage,
      delete: async (key) => {
        deletedKeys.push(key);
        await storage.delete(key);
      },
    };

    const result = await deleteChannel(db, { storage: spy, actorUserId: t.admin.id }, doomed.id, {
      confirmName: '  Trang cũ ',
    });
    expect(result).toEqual({ deleted: true, conversations: 3, messages: 4, contacts: 2 });

    // DB: không còn gì của kênh.
    expect(await db.select().from(channelAccounts).where(eq(channelAccounts.id, doomed.id))).toEqual([]);
    expect(await db.select().from(messages).where(eq(messages.channelAccountId, doomed.id))).toEqual([]);
    expect(
      await db.select().from(conversations).where(eq(conversations.channelAccountId, doomed.id)),
    ).toEqual([]);
    expect(
      await db.select().from(contactIdentities).where(eq(contactIdentities.channelAccountId, doomed.id)),
    ).toEqual([]);
    expect(await db.select().from(contacts).where(eq(contacts.id, onlyHere.contactId))).toEqual([]);
    expect(await db.select().from(contacts).where(eq(contacts.id, httpAvatar.contactId))).toEqual([]);
    expect(
      await db.select().from(customerMemories).where(eq(customerMemories.contactId, onlyHere.contactId)),
    ).toEqual([]);

    // Khách hai kênh vẫn còn, cùng danh tính/hội thoại/tin ở kênh còn lại.
    expect(await db.select().from(contacts).where(eq(contacts.id, shared.contactId))).toHaveLength(1);
    expect(
      await db
        .select()
        .from(contactIdentities)
        .where(
          and(
            eq(contactIdentities.contactId, shared.contactId),
            eq(contactIdentities.channelAccountId, keep.id),
          ),
        ),
    ).toHaveLength(1);
    expect(await db.select().from(conversations).where(eq(conversations.id, shared.id))).toHaveLength(1);
    expect(await db.select().from(messages).where(eq(messages.id, keptMsg))).toHaveLength(1);

    // S3: xóa media của kênh + avatar của khách bị xóa; không đụng tệp của kênh khác / khách còn lại.
    expect(deletedKeys.sort()).toEqual([
      'avatars/only-here.jpg',
      'media/a.jpg',
      'media/b.jpg',
      'media/c.pdf',
    ]);
    expect([...storage.objects.keys()].sort()).toEqual(['avatars/shared.jpg', 'media/keep.jpg']);

    // Audit: đủ thông tin, không có token.
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, doomed.id), eq(auditLogs.action, 'channel.delete')));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      userId: t.admin.id,
      entity: 'channel_account',
      data: {
        type: 'messenger',
        externalId: doomed.externalId,
        displayName: 'Trang cũ',
        counts: { conversations: 3, messages: 4, contacts: 2 },
      },
    });

    const after = await listChannels(db);
    expect(after.map((c) => c.id)).not.toContain(doomed.id);
    expect(after.find((c) => c.id === keep.id)?.stats).toEqual({ conversations: 1, messages: 1 });
  });

  it('kênh đang kết nối => ChannelDeleteConflictError, không xóa gì', async () => {
    const ch = await createChannel(db, { displayName: 'Đang chạy' });
    const conv = await createConversation(db, { channel: ch });
    await addMessage(db, conv, { sentAt: ago(HOUR), text: 'hi' });
    await expect(
      deleteChannel(db, { storage: null, actorUserId: t.admin.id }, ch.id, { confirmName: 'Đang chạy' }),
    ).rejects.toThrow(ChannelDeleteConflictError);
    // Trạng thái được kiểm tra trước tên: gõ sai tên vẫn là 409 (điều chặn thực sự là phải ngắt kết nối).
    await expect(
      deleteChannel(db, { storage: null, actorUserId: t.admin.id }, ch.id, { confirmName: 'sai tên' }),
    ).rejects.toThrow(ChannelDeleteConflictError);
    expect(await db.select().from(channelAccounts).where(eq(channelAccounts.id, ch.id))).toHaveLength(1);
    expect(await db.select().from(messages).where(eq(messages.channelAccountId, ch.id))).toHaveLength(1);
  });

  it('tên xác nhận sai => InboxValidationError; id không tồn tại => InboxNotFoundError', async () => {
    const ch = await createChannel(db, { displayName: 'Hết hạn', status: 'expired' });
    await createConversation(db, { channel: ch });
    await expect(
      deleteChannel(db, { storage: null, actorUserId: t.admin.id }, ch.id, { confirmName: 'hết hạn' }),
    ).rejects.toThrow(InboxValidationError);
    expect(
      await db.select().from(conversations).where(eq(conversations.channelAccountId, ch.id)),
    ).toHaveLength(1);

    await expect(
      deleteChannel(db, { storage: null, actorUserId: t.admin.id }, '00000000-0000-4000-8000-000000000000', {
        confirmName: 'x',
      }),
    ).rejects.toThrow(InboxNotFoundError);
  });

  it('tên xác nhận so khớp sau chuẩn hóa NFC (bộ gõ sinh chữ tổ hợp NFD)', async () => {
    const name = 'Xây Dựng Thử Nghiệm';
    const ch = await createChannel(db, { displayName: name, status: 'disconnected' });
    const nfd = ` ${name.normalize('NFD')} `;
    expect(nfd.trim()).not.toBe(name);
    const res = await deleteChannel(db, { storage: null, actorUserId: t.admin.id }, ch.id, {
      confirmName: nfd,
    });
    expect(res.deleted).toBe(true);
    expect(await db.select().from(channelAccounts).where(eq(channelAccounts.id, ch.id))).toHaveLength(0);
  });

  it('kênh expired/error xóa được; S3 chưa cấu hình hoặc lỗi không làm hỏng request', async () => {
    const { logger, warnings } = silentLogger();
    const expired = await createChannel(db, { displayName: 'Lỗi token', status: 'error' });
    const conv = await createConversation(db, { channel: expired, avatarKey: 'avatars/x.jpg' });
    await addMessage(db, conv, { sentAt: ago(HOUR), attachments: [media('media/x.jpg')] });
    const res = await deleteChannel(db, { storage: null, actorUserId: t.admin.id, logger }, expired.id, {
      confirmName: 'Lỗi token',
    });
    expect(res).toEqual({ deleted: true, conversations: 1, messages: 1, contacts: 1 });
    expect(warnings).toHaveLength(1);

    // S3 lỗi: vẫn trả kết quả, dừng sau vài lỗi liên tiếp thay vì thử hết.
    const broken = await createChannel(db, { displayName: 'S3 hỏng', status: 'expired' });
    const conv2 = await createConversation(db, { channel: broken });
    await addMessage(db, conv2, {
      sentAt: ago(HOUR),
      attachments: Array.from({ length: 40 }, (_, i) => media(`media/broken-${i}.jpg`)),
    });
    let calls = 0;
    const failing: MediaStorage = {
      ...createMemoryStorage(),
      delete: async () => {
        calls++;
        throw new Error('S3 down');
      },
    };
    const res2 = await deleteChannel(db, { storage: failing, actorUserId: t.admin.id }, broken.id, {
      confirmName: 'S3 hỏng',
    });
    expect(res2).toMatchObject({ deleted: true, messages: 1 });
    expect(calls).toBeLessThan(40);
  });

  it('listChannels: stats = 0 cho kênh chưa có hội thoại', async () => {
    const empty = await createChannel(db, { displayName: 'Trống' });
    const dto = (await listChannels(db)).find((c) => c.id === empty.id);
    expect(dto?.stats).toEqual({ conversations: 0, messages: 0 });
  });
});
