// app_settings: giờ làm việc, Lark (secret mã hóa), công tắc AI — Postgres thật (Testcontainers).
import { appSettings, auditLogs, type Db } from '@dezon/db';
import { DEFAULT_AI_SETTINGS, DEFAULT_BUSINESS_HOURS, type BusinessHours } from '@dezon/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getAiSettings,
  getBusinessHours,
  getLarkConfig,
  getLarkSettings,
  putAiSettings,
  putBusinessHours,
  putLarkSettings,
} from '../src/ai/settings';
import type { CredentialsCipher } from '../src/channels/service';
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

const cipher: CredentialsCipher = {
  encryptJson: (v) => `fake:${Buffer.from(JSON.stringify(v)).toString('base64')}`,
  decryptJson: <T>(p: string) => {
    if (!p.startsWith('fake:')) throw new Error('sai khóa');
    return JSON.parse(Buffer.from(p.slice(5), 'base64').toString()) as T;
  },
};

const ENV = { webhookUrl: 'https://open.larksuite.com/hook/env', secret: 'env-secret' };

async function rawValue(key: string) {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key));
  return row;
}

describe('app_settings', () => {
  it('giờ làm việc: mặc định ⇒ upsert ⇒ đọc lại; audit; giá trị hỏng ⇒ mặc định', async () => {
    expect(await getBusinessHours(db)).toEqual(DEFAULT_BUSINESS_HOURS);
    const custom: BusinessHours = {
      timezone: 'Asia/Ho_Chi_Minh',
      days: { ...DEFAULT_BUSINESS_HOURS.days, sat: [{ start: '08:00', end: '12:00' }] },
    };
    expect(await putBusinessHours(db, t.admin.id, custom)).toEqual(custom);
    expect(await getBusinessHours(db)).toEqual(custom);
    const again = { ...custom, days: { ...custom.days, sun: [{ start: '09:00', end: '11:00' }] } };
    await putBusinessHours(db, t.admin.id, again);
    expect(await getBusinessHours(db)).toEqual(again);
    const row = await rawValue('business_hours');
    expect(row?.updatedBy).toBe(t.admin.id);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, 'settings.business_hours'));
    expect(audits).toHaveLength(2);

    await db
      .update(appSettings)
      .set({ value: { timezone: 'Không/Có' } })
      .where(eq(appSettings.key, 'business_hours'));
    expect(await getBusinessHours(db)).toEqual(DEFAULT_BUSINESS_HOURS);
  });

  it('Lark: chưa có dòng ⇒ dùng env fallback; secret mã hóa; giữ/xóa secret; DB thắng env sau khi lưu', async () => {
    expect(await getLarkSettings(db)).toEqual({ webhookUrl: null, hasSecret: false });
    expect(await getLarkConfig(db, cipher)).toBeNull();
    expect(await getLarkConfig(db, cipher, ENV)).toEqual(ENV);
    expect(await getLarkConfig(db, cipher, { webhookUrl: '', secret: 'x' })).toBeNull();
    expect(await getLarkConfig(db, cipher, { webhookUrl: ENV.webhookUrl, secret: '' })).toEqual({
      webhookUrl: ENV.webhookUrl,
      secret: null,
    });

    const url = 'https://open.larksuite.com/open-apis/bot/v2/hook/abc';
    expect(await putLarkSettings(db, t.admin.id, { webhookUrl: url, secret: 'bi-mat-lark' }, cipher)).toEqual(
      {
        webhookUrl: url,
        hasSecret: true,
      },
    );
    const row = await rawValue('lark');
    expect(JSON.stringify(row?.value)).not.toContain('bi-mat-lark');
    expect((row?.value as { secretEnc: string }).secretEnc).toMatch(/^fake:/);
    expect(await getLarkConfig(db, cipher, ENV)).toEqual({ webhookUrl: url, secret: 'bi-mat-lark' });

    // secret bỏ qua ⇒ giữ nguyên
    await putLarkSettings(db, t.admin.id, { webhookUrl: `${url}2` }, cipher);
    expect(await getLarkConfig(db, cipher)).toEqual({ webhookUrl: `${url}2`, secret: 'bi-mat-lark' });

    // '' ⇒ xóa secret
    expect(await putLarkSettings(db, t.admin.id, { webhookUrl: url, secret: '' }, cipher)).toEqual({
      webhookUrl: url,
      hasSecret: false,
    });
    expect(await getLarkConfig(db, cipher)).toEqual({ webhookUrl: url, secret: null });

    // admin xóa webhook ⇒ null, KHÔNG quay về env
    await putLarkSettings(db, t.admin.id, { webhookUrl: null, secret: null }, cipher);
    expect(await getLarkSettings(db)).toEqual({ webhookUrl: null, hasSecret: false });
    expect(await getLarkConfig(db, cipher, ENV)).toBeNull();

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, 'settings.lark'));
    expect(audits).toHaveLength(4);
    expect(JSON.stringify(audits.map((a) => a.data))).not.toContain('bi-mat-lark');
  });

  it('Lark: giải mã lỗi ⇒ secret null', async () => {
    await db
      .update(appSettings)
      .set({ value: { webhookUrl: 'https://x.test/hook', secretEnc: 'hong:abc' } })
      .where(eq(appSettings.key, 'lark'));
    expect(await getLarkConfig(db, cipher)).toEqual({ webhookUrl: 'https://x.test/hook', secret: null });
    expect(await getLarkSettings(db)).toEqual({ webhookUrl: 'https://x.test/hook', hasSecret: true });
  });

  it('AI tổng: mặc định bật ⇒ tắt ⇒ bật', async () => {
    expect(await getAiSettings(db)).toEqual(DEFAULT_AI_SETTINGS);
    expect(await putAiSettings(db, t.admin.id, { enabled: false })).toEqual({ enabled: false });
    expect(await getAiSettings(db)).toEqual({ enabled: false });
    await putAiSettings(db, t.agent.id, { enabled: true });
    expect(await getAiSettings(db)).toEqual({ enabled: true });
    expect((await rawValue('ai'))?.updatedBy).toBe(t.agent.id);
  });
});
