// Phần đọc của hộp thư (read model) — dùng cho REST và cho payload realtime.
import { channelAccounts, contacts, conversations, messages, type Db } from '@dezon/db';
import { searchMode, VN_ACCENTED_CHARS, VN_PLAIN_CHARS } from '@dezon/shared';
import type {
  ConversationDetail,
  ConversationSummary,
  ListConversationsQuery,
  ListMessagesQuery,
  MessageDto,
  Page,
} from '@dezon/shared';
import { and, desc, eq, gt, isNotNull, isNull, lt, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { assertCanView, CONVERSATION_NOT_FOUND, visibleConversationsWhere } from './access';
import { decodeCursor, encodeCursor } from './cursor';
import { InboxNotFoundError } from './errors';
import {
  type DbLike,
  loadContactDetail,
  loadSummary,
  selectMessageRows,
  selectSummaryRows,
  toMessageDto,
  toSummary,
} from './read-model';
import type { InboxContext, Viewer } from './types';

/** Cột văn bản → dạng so khớp: bỏ dấu (khớp normalizeSearchText) hoặc giữ dấu (khớp foldSearchText). */
function foldSql(col: SQL | AnyColumn, accented: boolean): SQL {
  const folded = sql`lower(normalize(coalesce(${col}, ''), NFC))`;
  return accented ? folded : sql`translate(${folded}, ${VN_ACCENTED_CHARS}, ${VN_PLAIN_CHARS})`;
}

/** Mẫu LIKE '%từ khóa%' (đã thoát % _ \). */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Tên khách hoặc một tin bất kỳ trong hội thoại chứa từ khóa (xem searchMode). Quét bảng messages MỘT lần
 * (semi-join), giới hạn trong kênh đang chọn nếu có, thay vì EXISTS lặp lại cho từng hội thoại.
 */
function searchFilter(rawQuery: string, channelAccountId: string | undefined): SQL | undefined {
  const { accented, term } = searchMode(rawQuery);
  if (!term) return undefined;
  const pattern = likePattern(term);
  const inChannel = channelAccountId ? sql`m.channel_account_id = ${channelAccountId} and` : sql``;
  return or(
    sql`${foldSql(contacts.displayName, accented)} like ${pattern}`,
    sql`${conversations.id} in (select m.conversation_id from ${messages} m where ${inChannel} m.text is not null and ${foldSql(sql`m.text`, accented)} like ${pattern})`,
  );
}

function conversationFilters(viewer: Viewer, query: ListConversationsQuery): (SQL | undefined)[] {
  const f: (SQL | undefined)[] = [visibleConversationsWhere(viewer)];
  if (query.channelType) f.push(eq(channelAccounts.type, query.channelType));
  if (query.channelAccountId) f.push(eq(conversations.channelAccountId, query.channelAccountId));
  if (query.status) f.push(eq(conversations.status, query.status));
  if (query.assignee === 'me') f.push(eq(conversations.assignedUserId, viewer.id));
  else if (query.assignee === 'none') f.push(isNull(conversations.assignedUserId));
  else if (query.assignee) f.push(eq(conversations.assignedUserId, query.assignee));
  // unread=false nghĩa là không lọc (không có bộ lọc "đã đọc").
  if (query.unread) f.push(gt(conversations.unreadCount, 0));
  if (query.aiState === 'handled') {
    f.push(and(isNotNull(conversations.chatbotId), eq(conversations.aiMode, 'auto')));
  }
  if (query.tag) {
    f.push(
      sql`exists (select 1 from unnest(${contacts.tags}) as t(name) where lower(t.name) = lower(${query.tag}))`,
    );
  }
  if (query.q) f.push(searchFilter(query.q, query.channelAccountId));
  if (query.cursor) {
    const c = decodeCursor(query.cursor);
    const lastAt = conversations.lastMessageAt;
    // Thứ tự: last_message_at DESC NULLS LAST, id DESC.
    f.push(
      c.t === null
        ? and(isNull(lastAt), lt(conversations.id, c.id))
        : or(
            lt(lastAt, sql`${c.t}::timestamptz`),
            and(eq(lastAt, sql`${c.t}::timestamptz`), lt(conversations.id, c.id)),
            isNull(lastAt),
          ),
    );
  }
  return f;
}

/** Danh sách hội thoại theo quyền xem + bộ lọc, sắp theo last_message_at giảm dần (cursor). */
export async function listConversations(
  db: Db,
  viewer: Viewer,
  query: ListConversationsQuery,
  ctx: InboxContext,
): Promise<Page<ConversationSummary>> {
  const limit = query.limit;
  const rows = await selectSummaryRows(db, and(...conversationFilters(viewer, query)), {
    orderBy: [sql`${conversations.lastMessageAt} desc nulls last`, desc(conversations.id)],
    limit: limit + 1,
  });
  const pageRows = rows.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  return {
    items: await Promise.all(pageRows.map((r) => toSummary(r, ctx))),
    nextCursor: rows.length > limit && last ? encodeCursor({ t: last.cursorT, id: last.id }) : null,
  };
}

/** Ném InboxNotFoundError nếu không tồn tại, InboxForbiddenError nếu viewer không được xem. */
export async function getConversationDetail(
  db: Db,
  viewer: Viewer,
  conversationId: string,
  ctx: InboxContext,
): Promise<ConversationDetail> {
  const conv = await assertCanView(db, viewer, conversationId);
  const [summary, contactDetail] = await Promise.all([
    loadSummary(db, conversationId, ctx),
    loadContactDetail(db, conv.contactId, ctx),
  ]);
  if (!summary || !contactDetail) throw new InboxNotFoundError(CONVERSATION_NOT_FOUND);
  return { ...summary, contactDetail };
}

/** Tin của hội thoại, trang mới nhất trước; items trong trang tăng dần theo sentAt. Kiểm quyền như trên. */
export async function listMessages(
  db: Db,
  viewer: Viewer,
  conversationId: string,
  query: ListMessagesQuery,
  ctx: InboxContext,
): Promise<Page<MessageDto>> {
  await assertCanView(db, viewer, conversationId);
  const where: (SQL | undefined)[] = [eq(messages.conversationId, conversationId)];
  if (query.cursor) {
    const c = decodeCursor(query.cursor);
    if (c.t !== null) {
      where.push(sql`(${messages.sentAt}, ${messages.id}) < (${c.t}::timestamptz, ${c.id}::uuid)`);
    }
  }
  const rows = await selectMessageRows(
    db,
    and(...where),
    [desc(messages.sentAt), desc(messages.id)],
    query.limit + 1,
  );
  const pageRows = rows.slice(0, query.limit);
  const oldest = pageRows[pageRows.length - 1];
  return {
    items: await Promise.all(pageRows.reverse().map((r) => toMessageDto(r, ctx))),
    nextCursor:
      rows.length > query.limit && oldest ? encodeCursor({ t: oldest.cursorT, id: oldest.id }) : null,
  };
}

/** Summary không kiểm quyền (dùng để phát realtime). Ném InboxNotFoundError nếu không có. */
export async function getConversationSummary(
  db: Db,
  conversationId: string,
  ctx: InboxContext,
): Promise<ConversationSummary> {
  const summary = await loadSummary(db, conversationId, ctx);
  if (!summary) throw new InboxNotFoundError(CONVERSATION_NOT_FOUND);
  return summary;
}

/**
 * Id hội thoại của các khách, mới nhất trước (last_message_at giảm dần, null cuối), tối đa `limit` —
 * dùng để phát conversation.updated khi tag của khách đổi. Không kiểm quyền.
 */
export async function recentConversationIdsOfContacts(
  db: DbLike,
  contactIds: readonly string[],
  limit: number,
): Promise<string[]> {
  if (contactIds.length === 0 || limit <= 0) return [];
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(sql`${conversations.contactId} = any(${sql.param([...contactIds])}::uuid[])`)
    .orderBy(sql`${conversations.lastMessageAt} desc nulls last`, desc(conversations.id))
    .limit(limit);
  return rows.map((r) => r.id);
}

/** MessageDto không kiểm quyền (dùng để phát realtime). */
export async function getMessageDto(db: Db, messageId: string, ctx: InboxContext): Promise<MessageDto> {
  const [row] = await selectMessageRows(db, eq(messages.id, messageId), []);
  if (!row) throw new InboxNotFoundError('Không tìm thấy tin nhắn');
  return toMessageDto(row, ctx);
}

export { canViewConversation } from './access';
