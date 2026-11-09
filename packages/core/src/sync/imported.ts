// Hội thoại do đồng bộ lịch sử tạo mới: không làm ngập hàng "Đang mở" bằng hội thoại đã xử lý từ lâu.
import { contactIdentities, conversations, type Db } from '@dezon/db';
import { and, eq, sql } from 'drizzle-orm';
import { MESSENGER_STANDARD_WINDOW_MS } from '../policy';

/** id hội thoại hiện có của khách (psid) trên kênh, null nếu chưa có. */
export async function findConversationId(
  db: Db,
  channelAccountId: string,
  externalUserId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .innerJoin(contactIdentities, eq(contactIdentities.id, conversations.contactIdentityId))
    .where(
      and(
        eq(contactIdentities.channelAccountId, channelAccountId),
        eq(contactIdentities.externalUserId, externalUserId),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * Hội thoại MỚI do đồng bộ lịch sử tạo: chuyển sang 'resolved' trừ khi còn việc thật — có tin chưa đọc
 * (tin mới sau mốc đồng bộ trước), đã phân công, hoặc tin cuối là của khách và còn trong cửa sổ 24 giờ.
 * Không bao giờ đổi trạng thái hội thoại đã có trước lần đồng bộ.
 */
export async function settleImportedConversation(db: Db, conversationId: string, now: Date): Promise<void> {
  const windowStart = new Date(now.getTime() - MESSENGER_STANDARD_WINDOW_MS);
  await db
    .update(conversations)
    .set({ status: 'resolved' })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.status, 'open'),
        eq(conversations.unreadCount, 0),
        sql`${conversations.assignedUserId} IS NULL`,
        sql`NOT (
          ${conversations.lastCustomerMessageAt} IS NOT NULL
          AND ${conversations.lastCustomerMessageAt} >= ${conversations.lastMessageAt}
          AND ${conversations.lastCustomerMessageAt} > ${windowStart}
        )`,
      ),
    );
}
