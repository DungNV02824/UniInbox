// "Danh sách nhãn có màu": admin quản lý bộ nhãn khách hàng; nhân viên chỉ gắn nhãn có trong danh sách.
// contacts.tags vẫn lưu TÊN nhãn — đổi tên/xóa nhãn cập nhật luôn mảng của mọi khách trong cùng transaction.
// Hàm KHÔNG phát realtime: API phát 'contact_tags.updated' sau mỗi thao tác ghi (và conversation.updated cho
// hội thoại của khách bị đổi/gỡ nhãn — dùng bản *WithEffects).
import { auditLogs, contacts, contactTags, type Db } from '@dezon/db';
import {
  CONTACT_TAGS_MAX,
  type ContactTagDto,
  type CreateContactTagRequest,
  type DeleteContactTagResponse,
  type UpdateContactTagRequest,
} from '@dezon/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { InboxNotFoundError, InboxValidationError } from '../inbox/errors';
import type { DbLike } from '../inbox/read-model';
import { isUniqueViolation } from '../pipeline/helpers';

const TAG_NOT_FOUND = 'Không tìm thấy nhãn';

/** Tên nhãn đã có (unique lower(name)). API ánh xạ sang 409. */
export class ContactTagConflictError extends Error {
  override readonly name = 'ContactTagConflictError';
  constructor(message = 'Đã có nhãn này') {
    super(message);
  }
}

type TagRow = typeof contactTags.$inferSelect;

/** Khóa so khớp tên nhãn không phân biệt hoa thường. */
const tagKey = (name: string) => name.trim().toLowerCase();

function toDto(row: TagRow, contactCount: number): ContactTagDto {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    sortOrder: row.sortOrder,
    contactCount,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Số khách theo từng nhãn (lower(tag)) — một truy vấn gộp, không N+1. */
async function contactCountsByKey(db: DbLike): Promise<Map<string, number>> {
  const result = await db.execute<{ k: string; n: number }>(sql`
    select lower(t.tag) as k, count(distinct c.id)::int as n
    from ${contacts} c cross join lateral unnest(c.tags) as t(tag)
    group by lower(t.tag)`);
  return new Map(result.rows.map((r) => [r.k, Number(r.n)]));
}

/** Đếm khách của một nhãn (so khớp không phân biệt hoa thường). */
async function contactCountOf(db: DbLike, name: string): Promise<number> {
  const result = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from ${contacts} c
    where exists (select 1 from unnest(c.tags) as t(tag) where lower(t.tag) = lower(${name}))`);
  return Number(result.rows[0]?.n ?? 0);
}

async function mapConflict<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isUniqueViolation(error)) throw new ContactTagConflictError();
    throw error;
  }
}

/** GET /contact-tags (mọi nhân viên). Sắp theo sort_order, rồi tên. */
export async function listContactTags(db: DbLike): Promise<ContactTagDto[]> {
  const rows = await db
    .select()
    .from(contactTags)
    .orderBy(asc(contactTags.sortOrder), asc(contactTags.name), asc(contactTags.id));
  const counts = await contactCountsByKey(db);
  return rows.map((r) => toDto(r, counts.get(r.name.toLowerCase()) ?? 0));
}

async function getContactTag(db: DbLike, id: string): Promise<ContactTagDto> {
  const [row] = await db.select().from(contactTags).where(eq(contactTags.id, id));
  if (!row) throw new InboxNotFoundError(TAG_NOT_FOUND);
  return toDto(row, await contactCountOf(db, row.name));
}

/**
 * POST /contact-tags (admin). Trùng tên (không phân biệt hoa thường) ⇒ ContactTagConflictError;
 * đã đủ CONTACT_TAGS_MAX ⇒ InboxValidationError. Nhãn mới xếp cuối. Audit 'contact_tag.create'.
 */
export async function createContactTag(
  db: Db,
  actorUserId: string,
  input: CreateContactTagRequest,
): Promise<ContactTagDto> {
  const name = input.name.trim();
  const row = await mapConflict(() =>
    db.transaction(async (tx) => {
      // Khóa bảng ở mức ghi để hai lần tạo song song không vượt giới hạn.
      await tx.execute(sql`lock table ${contactTags} in share row exclusive mode`);
      const [stats] = await tx
        .select({
          n: sql<number>`count(*)::int`,
          maxOrder: sql<number>`coalesce(max(${contactTags.sortOrder}), -1)::int`,
        })
        .from(contactTags);
      if (Number(stats?.n ?? 0) >= CONTACT_TAGS_MAX) {
        throw new InboxValidationError(`Chỉ tạo được tối đa ${CONTACT_TAGS_MAX} nhãn`);
      }
      const [saved] = await tx
        .insert(contactTags)
        .values({
          name,
          color: input.color,
          sortOrder: Number(stats?.maxOrder ?? -1) + 1,
          createdBy: actorUserId,
        })
        .returning();
      if (!saved) throw new Error('Không tạo được nhãn');
      await tx.insert(auditLogs).values({
        userId: actorUserId,
        action: 'contact_tag.create',
        entity: 'contact_tag',
        entityId: saved.id,
        data: { name: saved.name, color: saved.color },
      });
      return saved;
    }),
  );
  return toDto(row, await contactCountOf(db, row.name));
}

/**
 * PATCH /contact-tags/:id (admin). Đổi tên ⇒ đổi nhãn trong contacts.tags của mọi khách (so khớp không phân
 * biệt hoa thường, giữ thứ tự, bỏ trùng) trong cùng transaction. Trùng tên nhãn khác ⇒ ContactTagConflictError.
 * Audit 'contact_tag.update'.
 */
export async function updateContactTag(
  db: Db,
  actorUserId: string,
  id: string,
  input: UpdateContactTagRequest,
): Promise<ContactTagDto> {
  return (await updateContactTagWithEffects(db, actorUserId, id, input)).tag;
}

/** Như updateContactTag, kèm id các khách bị đổi tên nhãn (để API phát conversation.updated). */
export async function updateContactTagWithEffects(
  db: Db,
  actorUserId: string,
  id: string,
  input: UpdateContactTagRequest,
): Promise<{ tag: ContactTagDto; affectedContactIds: string[] }> {
  let affectedContactIds: string[] = [];
  await mapConflict(() =>
    db.transaction(async (tx) => {
      const [current] = await tx.select().from(contactTags).where(eq(contactTags.id, id)).for('update');
      if (!current) throw new InboxNotFoundError(TAG_NOT_FOUND);
      const set: Partial<typeof contactTags.$inferInsert> = {};
      const newName = input.name?.trim();
      if (newName !== undefined && newName !== current.name) set.name = newName;
      if (input.color !== undefined) set.color = input.color;
      if (input.sortOrder !== undefined) set.sortOrder = input.sortOrder;
      const fields = Object.keys(set);
      if (fields.length === 0) return;
      await tx
        .update(contactTags)
        .set({ ...set, updatedAt: new Date() })
        .where(eq(contactTags.id, id));
      if (set.name !== undefined) {
        affectedContactIds = await renameTagOnContacts(tx, current.name, set.name);
      }
      const renamedOnContacts = affectedContactIds.length;
      await tx.insert(auditLogs).values({
        userId: actorUserId,
        action: 'contact_tag.update',
        entity: 'contact_tag',
        entityId: id,
        data: {
          fields,
          name: set.name ?? current.name,
          ...(set.name !== undefined ? { previousName: current.name, renamedOnContacts } : {}),
        },
      });
    }),
  );
  return { tag: await getContactTag(db, id), affectedContactIds };
}

/**
 * Thay `oldName` bằng `newName` trong contacts.tags (không phân biệt hoa thường). Mục trùng newName (vd. nhãn
 * cũ viết khác hoa thường) gộp về một, giữ vị trí xuất hiện đầu. Trả id các khách bị đổi.
 */
async function renameTagOnContacts(tx: DbLike, oldName: string, newName: string): Promise<string[]> {
  const result = await tx.execute<{ id: string }>(sql`
    update ${contacts} c set
      tags = (
        select coalesce(array_agg(d.v order by d.pos), '{}'::text[]) from (
          select distinct on (lower(m.v)) m.v, m.pos from (
            select case when lower(u.x) in (lower(${oldName}), lower(${newName})) then ${newName}::text else u.x end as v,
                   u.pos
            from unnest(c.tags) with ordinality as u(x, pos)
          ) m
          order by lower(m.v), m.pos
        ) d
      ),
      updated_at = now()
    where exists (select 1 from unnest(c.tags) as t(tag) where lower(t.tag) = lower(${oldName}))
    returning c.id`);
  return result.rows.map((r) => r.id);
}

/**
 * POST /contact-tags/reorder (admin): sort_order = vị trí trong `ids`; nhãn không có trong `ids` xếp sau theo
 * thứ tự cũ. id trùng / không tồn tại ⇒ InboxValidationError. Audit 'contact_tag.reorder'. Trả danh sách mới.
 */
export async function reorderContactTags(
  db: Db,
  actorUserId: string,
  ids: string[],
): Promise<ContactTagDto[]> {
  if (new Set(ids).size !== ids.length) throw new InboxValidationError('Danh sách nhãn bị trùng');
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: contactTags.id })
      .from(contactTags)
      .orderBy(asc(contactTags.sortOrder), asc(contactTags.name), asc(contactTags.id))
      .for('update');
    const existing = new Set(rows.map((r) => r.id));
    if (ids.some((id) => !existing.has(id))) {
      throw new InboxValidationError('Danh sách nhãn đã thay đổi, vui lòng tải lại trang');
    }
    const listed = new Set(ids);
    const order = [...ids, ...rows.map((r) => r.id).filter((id) => !listed.has(id))];
    const now = new Date();
    for (const [index, id] of order.entries()) {
      await tx.update(contactTags).set({ sortOrder: index, updatedAt: now }).where(eq(contactTags.id, id));
    }
    await tx.insert(auditLogs).values({
      userId: actorUserId,
      action: 'contact_tag.reorder',
      entity: 'contact_tag',
      entityId: null,
      data: { count: order.length },
    });
  });
  return listContactTags(db);
}

/**
 * DELETE /contact-tags/:id (admin). Gỡ nhãn khỏi contacts.tags của mọi khách (không phân biệt hoa thường) rồi
 * xóa nhãn, trong cùng transaction. Audit 'contact_tag.delete'.
 */
export async function deleteContactTag(
  db: Db,
  actorUserId: string,
  id: string,
): Promise<DeleteContactTagResponse> {
  return (await deleteContactTagWithEffects(db, actorUserId, id)).result;
}

/** Như deleteContactTag, kèm id các khách bị gỡ nhãn (để API phát conversation.updated). */
export async function deleteContactTagWithEffects(
  db: Db,
  actorUserId: string,
  id: string,
): Promise<{ result: DeleteContactTagResponse; affectedContactIds: string[] }> {
  return db.transaction(async (tx) => {
    const [tag] = await tx.select().from(contactTags).where(eq(contactTags.id, id)).for('update');
    if (!tag) throw new InboxNotFoundError(TAG_NOT_FOUND);
    const result = await tx.execute<{ id: string }>(sql`
      update ${contacts} c set
        tags = coalesce(
          (select array_agg(u.x order by u.pos) from unnest(c.tags) with ordinality as u(x, pos)
           where lower(u.x) <> lower(${tag.name})),
          '{}'::text[]),
        updated_at = now()
      where exists (select 1 from unnest(c.tags) as t(tag) where lower(t.tag) = lower(${tag.name}))
      returning c.id`);
    await tx.delete(contactTags).where(eq(contactTags.id, id));
    const removedFromContacts = result.rows.length;
    await tx.insert(auditLogs).values({
      userId: actorUserId,
      action: 'contact_tag.delete',
      entity: 'contact_tag',
      entityId: id,
      data: { name: tag.name, removedFromContacts },
    });
    return { result: { removedFromContacts }, affectedContactIds: result.rows.map((r) => r.id) };
  });
}

/**
 * Chuẩn hóa nhãn gửi lên ở PATCH /contacts/:id. Nhãn MỚI (khách chưa có, so không phân biệt hoa thường) phải
 * có trong danh sách nhãn — đổi về cách viết của danh sách; không có ⇒ InboxValidationError. Nhãn khách đã có
 * mà không còn trong danh sách (dữ liệu cũ) được giữ nguyên. Bỏ trùng (không phân biệt hoa thường), giữ thứ tự.
 */
export async function normalizeContactTags(
  db: DbLike,
  currentTags: readonly string[],
  requested: readonly string[],
): Promise<string[]> {
  const catalog = await db.select({ name: contactTags.name }).from(contactTags);
  const catalogByKey = new Map(catalog.map((t) => [tagKey(t.name), t.name]));
  const currentByKey = new Map(currentTags.map((t) => [tagKey(t), t]));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of requested) {
    const key = tagKey(raw);
    if (!key || seen.has(key)) continue;
    const name = catalogByKey.get(key) ?? currentByKey.get(key);
    if (name === undefined) {
      throw new InboxValidationError(`Nhãn "${raw.trim()}" chưa có trong danh sách nhãn`);
    }
    seen.add(key);
    out.push(name);
  }
  return out;
}
