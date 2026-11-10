// Test tích hợp "Danh sách nhãn có màu" (Postgres thật): CRUD, trùng tên, đổi tên/xóa lan sang contacts.tags,
// sắp xếp, và kiểm tra nhãn khi sửa khách (PATCH /contacts/:id).
import { auditLogs, contacts, contactTags, type Db } from '@dezon/db';
import { CONTACT_TAGS_MAX } from '@dezon/shared';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ContactTagConflictError,
  createContactTag,
  deleteContactTag,
  deleteContactTagWithEffects,
  listContactTags,
  reorderContactTags,
  updateContactTag,
  updateContactTagWithEffects,
} from '../src/contact-tags/service';
import { updateContact } from '../src/inbox/commands';
import { InboxNotFoundError, InboxValidationError } from '../src/inbox/errors';
import { createChannel, createConversation, makeCtx, startTestDb, type TestDb } from './inbox-fixtures';

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

beforeEach(async () => {
  await db.delete(contactTags);
  await db.update(contacts).set({ tags: [] });
});

async function newContact(tags: string[]): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({ displayName: 'Khách', tags })
    .returning({ id: contacts.id });
  return row!.id;
}

const tagsOf = async (id: string) =>
  (await db.select({ tags: contacts.tags }).from(contacts).where(eq(contacts.id, id)))[0]!.tags;

describe('CRUD nhãn', () => {
  it('tạo, liệt kê theo sort_order rồi tên, đếm khách không phân biệt hoa thường, ghi audit', async () => {
    const vip = await createContactTag(db, t.admin.id, { name: '  VIP ', color: 'red' });
    expect(vip).toMatchObject({ name: 'VIP', color: 'red', sortOrder: 0, contactCount: 0 });
    const sofa = await createContactTag(db, t.admin.id, { name: 'Sofa', color: 'blue' });
    expect(sofa.sortOrder).toBe(1);
    const c1 = await newContact(['vip', 'khác']);
    await newContact(['VIP']);
    await newContact(['sofa']);

    const list = await listContactTags(db);
    expect(list.map((x) => [x.name, x.contactCount])).toEqual([
      ['VIP', 2],
      ['Sofa', 1],
    ]);
    expect(typeof list[0]!.createdAt).toBe('string');

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, vip.id));
    expect(audit).toMatchObject({ action: 'contact_tag.create', entity: 'contact_tag', userId: t.admin.id });
    await db.delete(contacts).where(eq(contacts.id, c1));
  });

  it('trùng tên (không phân biệt hoa thường) ⇒ ContactTagConflictError "Đã có nhãn này"', async () => {
    const a = await createContactTag(db, t.admin.id, { name: 'Khách quen', color: 'blue' });
    await expect(createContactTag(db, t.admin.id, { name: 'KHÁCH QUEN', color: 'red' })).rejects.toThrow(
      ContactTagConflictError,
    );
    await expect(createContactTag(db, t.admin.id, { name: 'khách quen', color: 'red' })).rejects.toThrow(
      'Đã có nhãn này',
    );
    const b = await createContactTag(db, t.admin.id, { name: 'Khác', color: 'blue' });
    await expect(updateContactTag(db, t.admin.id, b.id, { name: 'KHÁCH quen' })).rejects.toBeInstanceOf(
      ContactTagConflictError,
    );
    // Đổi hoa thường của chính nó thì được.
    expect((await updateContactTag(db, t.admin.id, a.id, { name: 'KHÁCH QUEN' })).name).toBe('KHÁCH QUEN');
  });

  it(`vượt CONTACT_TAGS_MAX (${CONTACT_TAGS_MAX}) ⇒ InboxValidationError`, async () => {
    await db
      .insert(contactTags)
      .values(Array.from({ length: CONTACT_TAGS_MAX }, (_, i) => ({ name: `Nhãn ${i}`, sortOrder: i })));
    await expect(createContactTag(db, t.admin.id, { name: 'Thừa', color: 'blue' })).rejects.toBeInstanceOf(
      InboxValidationError,
    );
  });

  it('sửa màu / sort_order; không tìm thấy ⇒ InboxNotFoundError', async () => {
    const a = await createContactTag(db, t.admin.id, { name: 'A', color: 'blue' });
    expect(await updateContactTag(db, t.admin.id, a.id, { color: 'green', sortOrder: 5 })).toMatchObject({
      color: 'green',
      sortOrder: 5,
    });
    const missing = '7f1c2a9e-3b4d-4c5e-8f60-112233445566';
    await expect(updateContactTag(db, t.admin.id, missing, { color: 'red' })).rejects.toBeInstanceOf(
      InboxNotFoundError,
    );
    await expect(deleteContactTag(db, t.admin.id, missing)).rejects.toBeInstanceOf(InboxNotFoundError);
  });

  it('đổi tên lan sang contacts.tags (không phân biệt hoa thường, giữ thứ tự, bỏ trùng)', async () => {
    const tag = await createContactTag(db, t.admin.id, { name: 'vip', color: 'blue' });
    const c1 = await newContact(['a', 'VIP', 'b']);
    const c2 = await newContact(['Vàng', 'x', 'vip']); // đã có cách viết khác của tên mới ⇒ gộp
    const c3 = await newContact(['khác']);
    const renamed = await updateContactTag(db, t.admin.id, tag.id, { name: 'vàng' });
    expect(renamed).toMatchObject({ name: 'vàng', contactCount: 2 });
    expect(await tagsOf(c1)).toEqual(['a', 'vàng', 'b']);
    expect(await tagsOf(c2)).toEqual(['vàng', 'x']);
    expect(await tagsOf(c3)).toEqual(['khác']);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, tag.id));
    expect(audits.find((a) => a.action === 'contact_tag.update')?.data).toMatchObject({
      name: 'vàng',
      previousName: 'vip',
      renamedOnContacts: 2,
    });
    await db.delete(contacts).where(inArray(contacts.id, [c1, c2, c3]));
  });

  it('*WithEffects trả id các khách bị đổi tên / gỡ nhãn (để phát realtime)', async () => {
    const tag = await createContactTag(db, t.admin.id, { name: 'Lẻ', color: 'red' });
    const c1 = await newContact(['lẻ']);
    const c2 = await newContact(['x']);
    const colorOnly = await updateContactTagWithEffects(db, t.admin.id, tag.id, { color: 'green' });
    expect(colorOnly.affectedContactIds).toEqual([]);
    const renamed = await updateContactTagWithEffects(db, t.admin.id, tag.id, { name: 'Lẻ mới' });
    expect(renamed).toMatchObject({ tag: { name: 'Lẻ mới' }, affectedContactIds: [c1] });
    const removed = await deleteContactTagWithEffects(db, t.admin.id, tag.id);
    expect(removed).toEqual({ result: { removedFromContacts: 1 }, affectedContactIds: [c1] });
    await db.delete(contacts).where(inArray(contacts.id, [c1, c2]));
  });

  it('xóa gỡ nhãn khỏi mọi khách và trả số khách bị gỡ', async () => {
    const tag = await createContactTag(db, t.admin.id, { name: 'Sỉ', color: 'amber' });
    const c1 = await newContact(['a', 'sỉ', 'b']);
    const c2 = await newContact(['SỈ']);
    const c3 = await newContact(['a']);
    expect(await deleteContactTag(db, t.admin.id, tag.id)).toEqual({ removedFromContacts: 2 });
    expect(await tagsOf(c1)).toEqual(['a', 'b']);
    expect(await tagsOf(c2)).toEqual([]);
    expect(await tagsOf(c3)).toEqual(['a']);
    expect(await listContactTags(db)).toEqual([]);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, tag.id));
    expect(audits.find((a) => a.action === 'contact_tag.delete')?.data).toEqual({
      name: 'Sỉ',
      removedFromContacts: 2,
    });
    await db.delete(contacts).where(inArray(contacts.id, [c1, c2, c3]));
  });

  it('sắp xếp: sort_order theo vị trí; nhãn không có trong ids xếp sau; id lạ / trùng ⇒ lỗi', async () => {
    const a = await createContactTag(db, t.admin.id, { name: 'A', color: 'blue' });
    const b = await createContactTag(db, t.admin.id, { name: 'B', color: 'blue' });
    const c = await createContactTag(db, t.admin.id, { name: 'C', color: 'blue' });
    const list = await reorderContactTags(db, t.admin.id, [c.id, a.id]);
    expect(list.map((x) => [x.name, x.sortOrder])).toEqual([
      ['C', 0],
      ['A', 1],
      ['B', 2],
    ]);
    await expect(reorderContactTags(db, t.admin.id, [a.id, a.id])).rejects.toBeInstanceOf(
      InboxValidationError,
    );
    await expect(
      reorderContactTags(db, t.admin.id, ['7f1c2a9e-3b4d-4c5e-8f60-112233445566']),
    ).rejects.toBeInstanceOf(InboxValidationError);
    expect((await listContactTags(db)).map((x) => x.id)).toEqual([c.id, a.id, b.id]);
  });
});

describe('sửa nhãn của khách (updateContact)', () => {
  it('nhãn mới phải có trong danh sách, đổi về cách viết của danh sách; nhãn cũ ngoài danh sách được giữ', async () => {
    await createContactTag(db, t.admin.id, { name: 'Khách VIP', color: 'red' });
    await createContactTag(db, t.admin.id, { name: 'Sofa', color: 'blue' });
    const channel = await createChannel(db);
    const conv = await createConversation(db, { channel });
    await db
      .update(contacts)
      .set({ tags: ['cũ-lạ'] })
      .where(eq(contacts.id, conv.contactId));

    const d = await updateContact(
      db,
      t.agent,
      conv.contactId,
      { tags: ['cũ-lạ', 'khách vip', 'SOFA', 'Sofa'] },
      ctx,
    );
    expect(d.tags).toEqual(['cũ-lạ', 'Khách VIP', 'Sofa']);

    await expect(
      updateContact(db, t.agent, conv.contactId, { tags: ['Khách VIP', 'Gõ sai'] }, ctx),
    ).rejects.toThrow('Nhãn "Gõ sai" chưa có trong danh sách nhãn');
    expect(await tagsOf(conv.contactId)).toEqual(['cũ-lạ', 'Khách VIP', 'Sofa']);

    // Gỡ nhãn cũ thì không thêm lại được nữa (không còn trong danh sách).
    await updateContact(db, t.agent, conv.contactId, { tags: ['Sofa'] }, ctx);
    await expect(
      updateContact(db, t.agent, conv.contactId, { tags: ['Sofa', 'cũ-lạ'] }, ctx),
    ).rejects.toBeInstanceOf(InboxValidationError);
  });
});
