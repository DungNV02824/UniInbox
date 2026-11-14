// Test tích hợp "Thu thập thông tin" (Postgres thật): applyCapturedFields (bot ghi SĐT / trường vào hồ sơ khách, tự
// gắn nhãn khi có SĐT) và updateContact (nhân viên sửa SĐT / trường ⇒ source 'user', bot không ghi đè).
import { auditLogs, contacts, contactTags, type Db } from '@dezon/db';
import { DEFAULT_CAPTURE_CONFIG, type CaptureConfig } from '@dezon/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyCapturedFields } from '../src/contacts/capture';
import { updateContact } from '../src/inbox/commands';
import { makeCtx, startTestDb, type TestDb } from './inbox-fixtures';

let t: TestDb;
let db: Db;
const ctx = makeCtx();
const NOW = new Date('2026-11-14T08:00:00.000Z');

const config: CaptureConfig = {
  ...DEFAULT_CAPTURE_CONFIG,
  enabled: true,
  fields: [
    ...DEFAULT_CAPTURE_CONFIG.fields,
    { key: 'khu_vuc', label: 'Khu vực', hint: '', enabled: true },
    { key: 'ngan_sach', label: 'Ngân sách', hint: '', enabled: false },
  ],
};

beforeAll(async () => {
  t = await startTestDb();
  db = t.db;
});

afterAll(async () => {
  await t?.stop();
});

beforeEach(async () => {
  await db.delete(contactTags);
  await db.insert(contactTags).values({ name: 'Tiềm Năng', color: 'green', sortOrder: 0 });
});

async function newContact(values: Partial<typeof contacts.$inferInsert> = {}): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({ displayName: 'Khách', ...values })
    .returning({ id: contacts.id });
  return row!.id;
}

const rowOf = async (id: string) => (await db.select().from(contacts).where(eq(contacts.id, id)))[0]!;

const capture = (
  contactId: string,
  captured: Parameters<typeof applyCapturedFields>[1]['captured'],
  c = config,
) => db.transaction((tx) => applyCapturedFields(tx, { contactId, config: c, captured, now: NOW }));

describe('applyCapturedFields', () => {
  it('SĐT mới + trường bật ⇒ ghi, phoneSource ai, gắn nhãn theo cách viết của danh sách, audit không có giá trị', async () => {
    const id = await newContact({ tags: ['VIP'] });
    const result = await capture(id, {
      phone: '+84 912 345 678',
      fields: { need: '  Sofa góc chữ L  ', khu_vuc: 'Quận 7', ngan_sach: '50tr', la: 'x', phone: '0999' },
    });
    expect(result).toEqual({
      changedKeys: ['phone', 'need', 'khu_vuc'],
      phoneCaptured: true,
      tagged: 'Tiềm Năng',
    });
    const row = await rowOf(id);
    expect(row.phone).toBe('0912345678');
    expect(row.phoneSource).toBe('ai');
    expect(row.tags).toEqual(['VIP', 'Tiềm Năng']);
    expect(row.updatedAt.toISOString()).toBe(NOW.toISOString());
    expect(row.profileFields).toEqual({
      need: { label: 'Nhu cầu', value: 'Sofa góc chữ L', source: 'ai', updatedAt: NOW.toISOString() },
      khu_vuc: { label: 'Khu vực', value: 'Quận 7', source: 'ai', updatedAt: NOW.toISOString() },
    });
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, 'contact.capture')));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.data).toEqual({ keys: ['phone', 'need', 'khu_vuc'], tagged: true });
    expect(JSON.stringify(audits[0]!.data)).not.toContain('0912345678');
  });

  it('không đổi gì ⇒ không ghi, không audit', async () => {
    const id = await newContact();
    await capture(id, { phone: '0912345678', fields: { need: 'Bàn ăn' } });
    const again = await capture(id, { phone: '0912 345 678', fields: { need: 'Bàn ăn ' } });
    expect(again).toEqual({ changedKeys: [], phoneCaptured: false, tagged: null });
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, 'contact.capture')));
    expect(audits).toHaveLength(1);
  });

  it('SĐT do bot điền ⇒ được cập nhật (không gắn nhãn lại); SĐT có sẵn / nhân viên sửa ⇒ không ghi đè', async () => {
    const ai = await newContact();
    await capture(ai, { phone: '0912345678', fields: {} });
    expect(await capture(ai, { phone: '0987654321', fields: {} })).toEqual({
      changedKeys: ['phone'],
      phoneCaptured: false,
      tagged: null,
    });
    expect((await rowOf(ai)).phone).toBe('0987654321');

    const preset = await newContact({ phone: '0901111111' });
    expect((await capture(preset, { phone: '0912345678', fields: {} })).changedKeys).toEqual([]);
    const user = await newContact({ phone: '0902222222', phoneSource: 'user' });
    expect((await capture(user, { phone: '0912345678', fields: {} })).changedKeys).toEqual([]);
    expect((await rowOf(user)).phone).toBe('0902222222');
  });

  it('SĐT sai dạng / trường phone tắt ⇒ bỏ qua; khách đã có nhãn ⇒ không gắn trùng', async () => {
    const id = await newContact({ tags: ['tiềm năng'] });
    expect((await capture(id, { phone: '12345', fields: {} })).changedKeys).toEqual([]);
    const phoneOff: CaptureConfig = {
      ...config,
      fields: config.fields.map((f) => (f.key === 'phone' ? { ...f, enabled: false } : f)),
    };
    expect((await capture(id, { phone: '0912345678', fields: {} }, phoneOff)).changedKeys).toEqual([]);
    expect(await capture(id, { phone: '0912345678', fields: {} })).toEqual({
      changedKeys: ['phone'],
      phoneCaptured: true,
      tagged: null,
    });
    expect((await rowOf(id)).tags).toEqual(['tiềm năng']);
  });

  it('nhãn không có trong danh sách / phoneTag null ⇒ không gắn; capture tắt ⇒ không ghi gì', async () => {
    const a = await newContact();
    expect(
      (await capture(a, { phone: '0912345678', fields: {} }, { ...config, phoneTag: 'Không có' })).tagged,
    ).toBe(null);
    expect((await rowOf(a)).tags).toEqual([]);
    const b = await newContact();
    expect(
      (await capture(b, { phone: '0912345678', fields: {} }, { ...config, phoneTag: null })).tagged,
    ).toBeNull();
    const c = await newContact();
    expect(
      await capture(c, { phone: '0912345678', fields: { need: 'x' } }, { ...config, enabled: false }),
    ).toEqual({ changedKeys: [], phoneCaptured: false, tagged: null });
    expect((await rowOf(c)).phone).toBeNull();
  });

  it('trường nhân viên đã sửa ⇒ bot không ghi đè; trường bot ⇒ cập nhật; giá trị dài bị cắt', async () => {
    const id = await newContact({
      profileFields: {
        need: {
          label: 'Nhu cầu',
          value: 'Do nhân viên ghi',
          source: 'user',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        khu_vuc: { label: 'Khu vực', value: 'Q1', source: 'ai', updatedAt: '2026-01-01T00:00:00.000Z' },
      },
    });
    const long = 'a'.repeat(1200);
    const result = await capture(id, { fields: { need: 'Bot ghi', khu_vuc: long } });
    expect(result.changedKeys).toEqual(['khu_vuc']);
    const row = await rowOf(id);
    expect(row.profileFields.need!.value).toBe('Do nhân viên ghi');
    expect(row.profileFields.khu_vuc!.value).toHaveLength(1000);
  });
});

describe('updateContact — SĐT và trường thông tin', () => {
  it('nhân viên sửa SĐT ⇒ phoneSource user; xóa ⇒ null (hồ sơ); audit chỉ tên trường', async () => {
    const id = await newContact({ phone: '0912345678', phoneSource: 'ai' });
    const detail = await updateContact(db, t.admin, id, { phone: ' 0987 654 321 ' }, ctx);
    expect(detail).toMatchObject({ phone: '0987654321', phoneSource: 'user', profileFields: [] });
    const cleared = await updateContact(db, t.admin, id, { phone: '' }, ctx);
    expect(cleared).toMatchObject({ phone: null, phoneSource: null });
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, 'contact.update')));
    expect(audit!.data).toEqual({ fields: ['phone'] });
  });

  it('nhân viên gõ SĐT: hợp lệ ⇒ lưu dạng chuẩn; không nhận ra ⇒ lưu nguyên văn (đã trim), vẫn source user', async () => {
    const id = await newContact({});
    expect(await updateContact(db, t.admin, id, { phone: '+84 (912) 345-678' }, ctx)).toMatchObject({
      phone: '0912345678',
      phoneSource: 'user',
    });
    expect(await updateContact(db, t.admin, id, { phone: '  028 3822 1234 ' }, ctx)).toMatchObject({
      phone: '02838221234',
      phoneSource: 'user',
    });
    expect(await updateContact(db, t.admin, id, { phone: '  +65 9123 4567  ' }, ctx)).toMatchObject({
      phone: '+65 9123 4567',
      phoneSource: 'user',
    });
    expect(await updateContact(db, t.admin, id, { phone: ' 12345 (máy bàn) ' }, ctx)).toMatchObject({
      phone: '12345 (máy bàn)',
      phoneSource: 'user',
    });
  });

  it('sửa trường: lưu source user, giữ nhãn cũ, nhãn mặc định; rỗng ⇒ ẩn (giữ dấu); chỉ trường gửi lên bị đổi', async () => {
    const id = await newContact({
      notes: 'Ghi chú cũ',
      profileFields: {
        khu_vuc: { label: 'Khu vực', value: 'Q1', source: 'ai', updatedAt: '2026-01-01T00:00:00.000Z' },
        ngan_sach: { label: 'Ngân sách', value: '50tr', source: 'ai', updatedAt: '2026-01-02T00:00:00.000Z' },
      },
    });
    const detail = await updateContact(
      db,
      t.admin,
      id,
      {
        profileFields: [
          { key: 'need', value: 'Tủ bếp' },
          { key: 'khu_vuc', value: 'Quận 7' },
          { key: 'mau', label: 'Màu', value: 'Trắng' },
          { key: 'ngan_sach', value: null },
        ],
      },
      ctx,
    );
    expect(detail.notes).toBe('Ghi chú cũ');
    expect(detail.profileFields.map((f) => [f.key, f.label, f.value, f.source])).toEqual([
      ['need', 'Nhu cầu', 'Tủ bếp', 'user'],
      ['khu_vuc', 'Khu vực', 'Quận 7', 'user'],
      ['mau', 'Màu', 'Trắng', 'user'],
    ]);
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, 'contact.update')));
    expect(audit!.data).toEqual({
      fields: ['profileFields.need', 'profileFields.khu_vuc', 'profileFields.mau', 'profileFields.ngan_sach'],
    });
    expect(JSON.stringify(audit!.data)).not.toContain('Tủ bếp');

    // Bot không ghi đè trường nhân viên vừa sửa.
    expect((await capture(id, { fields: { khu_vuc: 'Thủ Đức' } })).changedKeys).toEqual([]);
    // Trường nhân viên vừa xóa: giữ dấu (value '', source user), bot không điền lại.
    expect((await rowOf(id)).profileFields.ngan_sach).toMatchObject({ value: '', source: 'user' });
  });

  it('nhân viên xóa SĐT / trường bot điền ⇒ bot không điền lại, không gắn lại nhãn', async () => {
    const id = await newContact();
    expect(
      (await capture(id, { phone: '0912345678', fields: { need: 'Nhà phố', khu_vuc: 'Q7' } })).tagged,
    ).toBe('Tiềm Năng');
    await updateContact(
      db,
      t.admin,
      id,
      {
        phone: null,
        tags: [],
        profileFields: [
          { key: 'need', value: null },
          { key: 'khu_vuc', value: '' },
        ],
      },
      ctx,
    );
    expect(await capture(id, { phone: '0912345678', fields: { need: 'Nhà phố', khu_vuc: 'Q7' } })).toEqual({
      changedKeys: [],
      phoneCaptured: false,
      tagged: null,
    });
    const row = await rowOf(id);
    expect(row).toMatchObject({ phone: null, phoneSource: 'user', tags: [] });
    expect(row.profileFields.need).toMatchObject({ value: '', source: 'user' });
    const detail = await updateContact(db, t.admin, id, { notes: 'x' }, ctx);
    expect(detail).toMatchObject({ phone: null, phoneSource: null, profileFields: [] });
  });
});

describe('applyCapturedFields — SĐT đoán (regex) và khóa đặc biệt', () => {
  it('SĐT đoán: chỉ điền khi chưa có SĐT, không gắn nhãn, không ghi đè SĐT bot đã điền', async () => {
    const empty = await newContact();
    expect(await capture(empty, { phone: '0912345678', phoneGuessed: true, fields: {} })).toEqual({
      changedKeys: ['phone'],
      phoneCaptured: true,
      tagged: null,
    });
    expect(await rowOf(empty)).toMatchObject({ phone: '0912345678', phoneSource: 'ai', tags: [] });
    expect(
      (await capture(empty, { phone: '0987654321', phoneGuessed: true, fields: {} })).changedKeys,
    ).toEqual([]);
    expect((await rowOf(empty)).phone).toBe('0912345678');
  });

  it("khóa trùng thuộc tính kế thừa ('constructor') vẫn ghi được", async () => {
    const withCtor: CaptureConfig = {
      ...config,
      fields: [...config.fields, { key: 'constructor', label: 'Constructor', hint: '', enabled: true }],
    };
    const id = await newContact();
    expect((await capture(id, { fields: { constructor: 'Công ty A' } }, withCtor)).changedKeys).toEqual([
      'constructor',
    ]);
    expect((await rowOf(id)).profileFields.constructor).toMatchObject({ value: 'Công ty A', source: 'ai' });
  });
});
