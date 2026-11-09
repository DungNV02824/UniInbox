import { auditLogs, channelAccounts, type Db } from '@dezon/db';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHANNEL_COLOR_PALETTE,
  connectMessengerPage,
  disconnectChannel,
  listChannels,
  loadResolvedAccount,
  updateChannel,
  type CredentialsCipher,
} from '../src/channels/service';
import type { MessengerGraphApi } from '../src/connectors/messenger';
import { InboxNotFoundError, InboxValidationError } from '../src/inbox/errors';
import { startTestDb, type TestDb } from './inbox-fixtures';

let t: TestDb;
let db: Db;

beforeAll(async () => {
  t = await startTestDb();
  db = t.db;
});

afterAll(async () => {
  await t?.stop();
});

const TOKEN = 'EAAG-page-token-rat-dai-1234567890';

/** Cipher giả: base64 của JSON, có tiền tố để chắc chắn không lưu token dạng rõ. */
const cipher: CredentialsCipher = {
  encryptJson: (v) => `fake:${Buffer.from(JSON.stringify(v)).toString('base64')}`,
  decryptJson: <T>(p: string) => JSON.parse(Buffer.from(p.slice(5), 'base64').toString()) as T,
};

function fakeGraph(pages: Record<string, { id: string; name: string }>) {
  const calls: string[] = [];
  let failUnsubscribe = false;
  const graph: MessengerGraphApi = {
    async getPage(token) {
      calls.push('getPage');
      const page = pages[token];
      if (!page) throw new Error('Token không hợp lệ hoặc không phải token của Page');
      return page;
    },
    async subscribeApp(pageId) {
      calls.push(`subscribe:${pageId}`);
    },
    async unsubscribeApp(pageId) {
      calls.push(`unsubscribe:${pageId}`);
      if (failUnsubscribe) throw new Error('Token đã hết hạn');
    },
  };
  return { graph, calls, setFailUnsubscribe: (v: boolean) => (failUnsubscribe = v) };
}

describe('channel service', () => {
  it('kết nối Fanpage: upsert, mã hóa token, DTO không có credentials, audit không có token', async () => {
    const { graph, calls } = fakeGraph({ [TOKEN]: { id: '1001', name: 'Dezon Nội Thất' } });
    const dto = await connectMessengerPage(
      db,
      { graph, cipher, actorUserId: t.admin.id },
      { pageAccessToken: TOKEN },
    );

    expect(dto).toMatchObject({
      type: 'messenger',
      externalId: '1001',
      displayName: 'Dezon Nội Thất',
      status: 'connected',
      lastError: null,
      color: CHANNEL_COLOR_PALETTE[0],
    });
    expect(dto).not.toHaveProperty('credentials');
    expect(JSON.stringify(dto)).not.toContain(TOKEN);
    expect(calls).toEqual(['getPage', 'subscribe:1001']);

    const [row] = await db.select().from(channelAccounts).where(eq(channelAccounts.id, dto.id));
    expect(JSON.stringify(row!.credentials)).not.toContain(TOKEN);
    const resolved = await loadResolvedAccount(db, cipher, dto.id);
    expect(resolved).toEqual({
      id: dto.id,
      type: 'messenger',
      externalId: '1001',
      credentials: { pageAccessToken: TOKEN },
    });

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, dto.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'channel.connect', userId: t.admin.id });
    expect(JSON.stringify(audits[0]!.data)).not.toContain(TOKEN);
  });

  it('kết nối lại cùng Page: giữ id và tên đã đổi, cập nhật token; kênh mới lấy màu kế tiếp', async () => {
    const token2 = `${TOKEN}-moi`;
    const { graph } = fakeGraph({
      [token2]: { id: '1001', name: 'Tên mới trên FB' },
      [TOKEN]: { id: '2002', name: 'Page 2' },
    });
    const [before] = await listChannels(db);
    await updateChannel(db, { actorUserId: t.admin.id }, before!.id, { displayName: 'Fanpage chính' });

    const again = await connectMessengerPage(
      db,
      { graph, cipher, actorUserId: t.admin.id },
      { pageAccessToken: token2 },
    );
    expect(again.id).toBe(before!.id);
    expect(again.displayName).toBe('Fanpage chính');
    expect((await loadResolvedAccount(db, cipher, again.id))!.credentials).toEqual({
      pageAccessToken: token2,
    });

    const second = await connectMessengerPage(
      db,
      { graph, cipher, actorUserId: t.admin.id },
      { pageAccessToken: TOKEN, displayName: 'Showroom' },
    );
    expect(second).toMatchObject({ displayName: 'Showroom', color: CHANNEL_COLOR_PALETTE[1] });
    expect((await listChannels(db)).map((c) => c.id)).toEqual([before!.id, second.id]);
  });

  it('token sai => InboxValidationError tiếng Việt, không tạo kênh', async () => {
    const { graph } = fakeGraph({});
    const err = await connectMessengerPage(
      db,
      { graph, cipher, actorUserId: t.admin.id },
      { pageAccessToken: 'token-sai-0000000000000' },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InboxValidationError);
    expect((err as Error).message).toContain('Không xác minh được Page Access Token');
    expect(await listChannels(db)).toHaveLength(2);
  });

  it('updateChannel: đổi màu, ghi audit; id không tồn tại => InboxNotFoundError', async () => {
    const [ch] = await listChannels(db);
    const dto = await updateChannel(db, { actorUserId: t.admin.id }, ch!.id, { color: '#000000' });
    expect(dto.color).toBe('#000000');
    await expect(
      updateChannel(db, { actorUserId: t.admin.id }, '00000000-0000-4000-8000-000000000000', {
        color: '#111111',
      }),
    ).rejects.toBeInstanceOf(InboxNotFoundError);
  });

  it('ngắt kết nối: gọi unsubscribe (bỏ qua lỗi), xóa credentials, loadResolvedAccount => null', async () => {
    const { graph, calls, setFailUnsubscribe } = fakeGraph({});
    const [first, second] = await listChannels(db);

    const dto = await disconnectChannel(db, { graph, cipher, actorUserId: t.admin.id }, first!.id);
    expect(dto).toMatchObject({ status: 'disconnected', id: first!.id });
    expect(calls).toEqual([`unsubscribe:${first!.externalId}`]);
    expect(await loadResolvedAccount(db, cipher, first!.id)).toBeNull();

    setFailUnsubscribe(true);
    const dto2 = await disconnectChannel(db, { graph, cipher, actorUserId: t.admin.id }, second!.id);
    expect(dto2.status).toBe('disconnected');
    const [row] = await db.select().from(channelAccounts).where(eq(channelAccounts.id, second!.id));
    expect(row!.credentials).toBeNull();
    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'channel.disconnect'))
      .orderBy(asc(auditLogs.createdAt));
    expect(audits.map((a) => a.data.unsubscribed)).toEqual([true, false]);

    expect(await loadResolvedAccount(db, cipher, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});
