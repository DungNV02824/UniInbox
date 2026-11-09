// Nhận ra bản sao tin do CHÍNH hệ thống gửi khi đọc lại qua Conversations API (không có app_id/metadata).
// - Mỗi phần gửi thành công (và mỗi echo của app) ghi mid vào messages.raw.sentExternalIds
//   (một lần gửi tách nhiều phần nhưng external_message_id chỉ giữ mid của phần đầu).
// - Tin còn 'queued' (Send API đã nhận nhưng worker chưa ghi kết quả): khớp theo nội dung + thời gian.
import { contactIdentities, conversations, messages, type Db } from '@dezon/db';
import type { NormalizedInboundMessage } from '@dezon/shared';
import { and, eq, gt, inArray, lt, or, sql, type SQL } from 'drizzle-orm';

/** Độ lệch tối đa giữa giờ tạo tin queued và created_time của Meta. */
export const OWN_SENT_MATCH_WINDOW_MS = 10 * 60_000;

const outgoing = inArray(messages.senderType, ['agent', 'bot']);

const sentIdsOf = sql`coalesce(${messages.raw} -> 'sentExternalIds', '[]'::jsonb)`;
const hasSentId = (mid: string): SQL => sql`${sentIdsOf} @> jsonb_build_array(${mid}::text)`;

/** Ghi thêm mid của một phần đã gửi vào raw.sentExternalIds (bỏ qua nếu đã có). */
export async function recordSentExternalId(db: Db, messageId: string, mid: string): Promise<void> {
  await db
    .update(messages)
    .set({
      raw: sql`jsonb_set(coalesce(${messages.raw}, '{}'::jsonb), '{sentExternalIds}', ${sentIdsOf} || jsonb_build_array(${mid}::text))`,
    })
    .where(
      and(
        eq(messages.id, messageId),
        sql`jsonb_typeof(coalesce(${messages.raw}, '{}'::jsonb)) = 'object'`,
        sql`not ${hasSentId(mid)}`,
      ),
    );
}

/**
 * true nếu tin 'out' đọc từ đồng bộ là tin hệ thống đã gửi (hoặc đang gửi) trong hội thoại của khách này.
 */
export async function isOwnSentCopy(db: Db, msg: NormalizedInboundMessage): Promise<boolean> {
  if (msg.direction !== 'out') return false;
  const at = msg.sentAt.getTime();
  const queuedMatch = and(
    eq(messages.status, 'queued'),
    gt(messages.sentAt, new Date(at - OWN_SENT_MATCH_WINDOW_MS)),
    lt(messages.sentAt, new Date(at + OWN_SENT_MATCH_WINDOW_MS)),
    // Phần text phải trùng nội dung; phần tệp (không text) chỉ khớp tin queued CÓ tệp đính kèm
    // (không nuốt ảnh gửi từ Business Suite khi đang có một tin chữ khác chờ gửi).
    msg.text
      ? eq(messages.text, msg.text)
      : sql`jsonb_array_length(coalesce(${messages.attachments}, '[]'::jsonb)) > 0`,
  );
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(contactIdentities, eq(contactIdentities.id, conversations.contactIdentityId))
    .where(
      and(
        eq(contactIdentities.channelAccountId, msg.channelAccountId),
        eq(contactIdentities.externalUserId, msg.externalUserId),
        outgoing,
        or(hasSentId(msg.externalMessageId), queuedMatch),
      ),
    )
    .limit(1);
  return row !== undefined;
}
