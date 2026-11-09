// Mốc tính cửa sổ mở rộng của hội thoại từ quảng cáo (window_source = 'ads'): tin đầu tiên của khách.
import { conversations, messages } from '@dezon/db';
import { eq, sql, type SQL } from 'drizzle-orm';
import type { DbLike } from '../inbox/read-model';

/**
 * Tin đầu tiên của khách, BỎ QUA tin nhập qua đồng bộ (raw.source = 'sync'): lịch sử cũ kéo về bằng
 * backfill không được kéo lùi mốc (cửa sổ ngắn lại sai). Referral quảng cáo chỉ đến qua webhook nên tin
 * mở cửa sổ luôn là tin webhook. Hội thoại chỉ có tin đồng bộ: dùng tin đầu tiên bất kỳ (thận trọng).
 */
export function firstCustomerMessageAtSql(conversationId: SQL | string): SQL<Date | null> {
  return sql`coalesce(
    (select min(m.sent_at) from ${messages} m
      where m.conversation_id = ${conversationId} and m.sender_type = 'customer'
        and coalesce(m.raw ->> 'source', '') <> 'sync'),
    (select min(m.sent_at) from ${messages} m
      where m.conversation_id = ${conversationId} and m.sender_type = 'customer')
  )`.mapWith(messages.sentAt) as SQL<Date | null>;
}

export async function firstCustomerMessageAt(db: DbLike, conversationId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: firstCustomerMessageAtSql(conversationId) })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return row?.at ?? null;
}
