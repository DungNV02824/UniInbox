// Quyền xem hội thoại (quyết định 1A): admin xem tất cả; agent xem hội thoại được phân công cho mình
// và hội thoại chưa phân công.
import { conversations } from '@dezon/db';
import { eq, isNull, or, type SQL } from 'drizzle-orm';
import { InboxForbiddenError, InboxNotFoundError } from './errors';
import type { DbLike } from './read-model';
import type { Viewer } from './types';

export const CONVERSATION_NOT_FOUND = 'Không tìm thấy hội thoại';
const CONVERSATION_FORBIDDEN = 'Bạn không có quyền xem hội thoại này';

/** Viewer có được xem hội thoại này không (admin: luôn; agent: được phân công hoặc chưa phân công). */
export function canViewConversation(
  viewer: Viewer,
  conversation: { assignedUserId: string | null },
): boolean {
  return (
    viewer.role === 'admin' ||
    conversation.assignedUserId === null ||
    conversation.assignedUserId === viewer.id
  );
}

/** Điều kiện SQL tương đương canViewConversation (undefined = không lọc). */
export function visibleConversationsWhere(viewer: Viewer): SQL | undefined {
  if (viewer.role === 'admin') return undefined;
  return or(isNull(conversations.assignedUserId), eq(conversations.assignedUserId, viewer.id));
}

/** Đọc hội thoại tối thiểu + kiểm quyền xem. Ném InboxNotFoundError / InboxForbiddenError. */
export async function assertCanView(
  db: DbLike,
  viewer: Viewer,
  conversationId: string,
): Promise<{ id: string; assignedUserId: string | null; contactId: string }> {
  const [conv] = await db
    .select({
      id: conversations.id,
      assignedUserId: conversations.assignedUserId,
      contactId: conversations.contactId,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  if (!conv) throw new InboxNotFoundError(CONVERSATION_NOT_FOUND);
  if (!canViewConversation(viewer, conv)) throw new InboxForbiddenError(CONVERSATION_FORBIDDEN);
  return conv;
}
