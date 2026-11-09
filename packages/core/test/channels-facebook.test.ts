import { channelAccounts, type Db } from '@dezon/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectMessengerPage,
  listChannels,
  readConnectionSettings,
  type CredentialsCipher,
} from '../src/channels/service';
import type { MessengerGraphApi } from '../src/connectors/messenger';
import { InboxValidationError } from '../src/inbox/errors';
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

const TOKEN_A = 'EAAG-page-token-A-1234567890';
const TOKEN_B = 'EAAG-page-token-B-1234567890';

const cipher: CredentialsCipher = {
  encryptJson: (v) => `fake:${Buffer.from(JSON.stringify(v)).toString('base64')}`,
  decryptJson: <T>(p: string) => JSON.parse(Buffer.from(p.slice(5), 'base64').toString()) as T,
};

const pages: Record<string, { id: string; name: string }> = {
  [TOKEN_A]: { id: '5001', name: 'Demo app' },
  [TOKEN_B]: { id: '5002', name: 'Trang B' },
};
const graph: MessengerGraphApi = {
  async getPage(token) {
    const page = pages[token];
    if (!page) throw new Error('Token không hợp lệ');
    return page;
  },
  async subscribeApp() {},
  async unsubscribeApp() {},
};

describe('connectMessengerPage + settings (Facebook Login)', () => {
  it('lưu connectedBy + pictureUrl vào settings, DTO trả ra (không token)', async () => {
    const dto = await connectMessengerPage(
      db,
      { graph, cipher, actorUserId: t.admin.id },
      { pageAccessToken: TOKEN_A },
      {
        connectedBy: { provider: 'facebook_login', fbUserId: '42', fbUserName: 'Đúng Văn' },
        pictureUrl: 'https://cdn.test/a.jpg',
        expectedPageId: '5001',
      },
    );
    expect(dto.connectedBy).toEqual({ provider: 'facebook_login', fbUserId: '42', fbUserName: 'Đúng Văn' });
    expect(dto.pictureUrl).toBe('https://cdn.test/a.jpg');
    expect(JSON.stringify(dto)).not.toContain(TOKEN_A);
    const [row] = await db.select().from(channelAccounts).where(eq(channelAccounts.id, dto.id));
    expect(row!.settings).toMatchObject({ connectedBy: { provider: 'facebook_login' } });
    expect(JSON.stringify(row!.settings)).not.toContain(TOKEN_A);
  });

  it('kết nối lại bằng token dán: connectedBy = token, giữ ảnh cũ và key settings khác', async () => {
    const [before] = await listChannels(db);
    await db
      .update(channelAccounts)
      .set({ settings: { ...((await db.select().from(channelAccounts))[0]!.settings ?? {}), other: 1 } })
      .where(eq(channelAccounts.id, before!.id));
    const dto = await connectMessengerPage(
      db,
      { graph, cipher, actorUserId: t.admin.id },
      { pageAccessToken: TOKEN_A },
    );
    expect(dto.id).toBe(before!.id);
    expect(dto.connectedBy).toEqual({ provider: 'token' });
    expect(dto.pictureUrl).toBe('https://cdn.test/a.jpg');
    const [row] = await db.select().from(channelAccounts).where(eq(channelAccounts.id, dto.id));
    expect(row!.settings).toMatchObject({ other: 1 });
  });

  it('expectedPageId không khớp => InboxValidationError, không tạo kênh', async () => {
    const err = await connectMessengerPage(
      db,
      { graph, cipher, actorUserId: t.admin.id },
      { pageAccessToken: TOKEN_B },
      { expectedPageId: '9999' },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InboxValidationError);
    expect(await listChannels(db)).toHaveLength(1);
  });
});

describe('readConnectionSettings', () => {
  it('bỏ qua dữ liệu sai kiểu / URL không phải https', () => {
    expect(
      readConnectionSettings({ connectedBy: { provider: 'x' }, pictureUrl: 'javascript:alert(1)' }),
    ).toEqual({
      connectedBy: null,
      pictureUrl: null,
    });
    expect(readConnectionSettings(undefined)).toEqual({ connectedBy: null, pictureUrl: null });
    expect(readConnectionSettings({ connectedBy: { provider: 'token', fbUserId: 5 } })).toEqual({
      connectedBy: { provider: 'token' },
      pictureUrl: null,
    });
  });
});
