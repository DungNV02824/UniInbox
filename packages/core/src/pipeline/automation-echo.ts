// Echo "tự động" của Page: Trả lời nhanh (Instant Reply), Tin nhắn vắng mặt (Away message) của Business
// Suite hoặc công cụ tự động khác. Meta gửi chúng như echo bình thường (app_id = Hộp thư Page hoặc app khác),
// KHÔNG có dấu hiệu nào đáng tin để phân biệt với nhân viên thật (docs/research/messenger-platform.md §10).
// Heuristic (docs/DECISIONS.md): echo (không phải của hệ thống) gửi trong AUTOMATION_ECHO_WINDOW_SEC giây SAU
// một tin khách (so theo sent_at — đồng hồ của Meta) ⇒ coi là tự động: KHÔNG tạm dừng AI, KHÔNG tính là
// "nhân viên đã trả lời" khi chatbot xác định tin chưa xử lý. Đánh dấu raw.automatedEcho = true.
// Hai thứ tự đến đều xử lý được (hàng đợi inbound chạy song song nên echo có thể được lưu TRƯỚC tin khách):
// - echo đến sau tin khách: phân loại ngay khi lưu echo;
// - echo đến trước: khi lưu tin khách, đánh dấu lại các echo trong cửa sổ và gỡ pause mà echo đó đã đặt
//   (raw.aiPauseUntil, chỉ khi pause hiện tại vẫn đúng bằng giá trị echo đặt — không có ai kéo dài sau đó — và
//   không có tin nhân viên thật nào sau echo). Giá trị có thể là mốc "dừng hẳn" (AI_PAUSED_INDEFINITELY_ISO) khi
//   bot đặt agent_reply_mode 'stop'; 'continue' không đặt pause nên không có gì để gỡ.
import { conversations, messages } from '@dezon/db';
import { and, eq, sql, type SQLWrapper } from 'drizzle-orm';
import type { DbLike } from '../inbox/read-model';

/** Echo trong khoảng này (giây) sau một tin khách ⇒ coi là tin tự động của Page. */
export const AUTOMATION_ECHO_WINDOW_SEC = 15;
/** Khóa đánh dấu trong messages.raw. */
export const AUTOMATED_ECHO_RAW_KEY = 'automatedEcho';
/** Khóa trong messages.raw: thời điểm pause AI mà echo này đặt (để gỡ nếu sau đó được phân loại tự động). */
export const ECHO_PAUSE_RAW_KEY = 'aiPauseUntil';

/** Điều kiện SQL "không phải echo tự động" cho cột raw (dùng được với alias, ví dụ sql`m.raw`). */
export const notAutomatedEcho = (raw: SQLWrapper) =>
  sql`coalesce((${raw}) ->> 'automatedEcho', '') <> 'true'`;

const iso = (d: Date) => d.toISOString();

/** raw của echo kèm cờ automatedEcho (raw không phải object ⇒ bọc trong { original }). */
export function withAutomatedFlag(raw: unknown): Record<string, unknown> {
  const base =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : raw === null || raw === undefined
        ? {}
        : { original: raw };
  return { ...base, [AUTOMATED_ECHO_RAW_KEY]: true };
}

/** Có tin khách trong hội thoại gửi trong [sentAt − cửa sổ, sentAt] không (echo đến sau tin khách). */
export async function isLikelyAutomatedEcho(
  db: DbLike,
  conversationId: string,
  sentAt: Date,
): Promise<boolean> {
  const from = new Date(sentAt.getTime() - AUTOMATION_ECHO_WINDOW_SEC * 1000);
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.senderType, 'customer'),
        sql`${messages.sentAt} between ${iso(from)}::timestamptz and ${iso(sentAt)}::timestamptz`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Echo vừa đặt pause AI = `until` (pause sau cập nhật đúng bằng giá trị của nó) ⇒ ghi vào raw để gỡ sau. */
export async function recordEchoPause(db: DbLike, messageId: string, until: Date): Promise<void> {
  await db
    .update(messages)
    .set({
      raw: sql`(case when jsonb_typeof(${messages.raw}) = 'object' then ${messages.raw} else '{}'::jsonb end)
        || jsonb_build_object(${ECHO_PAUSE_RAW_KEY}::text, ${iso(until)}::text)`,
    })
    .where(eq(messages.id, messageId));
}

/**
 * Gọi khi lưu tin KHÁCH (echo đến trước): đánh dấu automatedEcho các echo từ nền tảng (sender 'agent',
 * không có sender_user_id, không phải tin hệ thống gửi — raw.outbound null) gửi trong [sentAt, sentAt + cửa sổ];
 * gỡ pause AI mà các echo đó đã đặt nếu pause hiện tại vẫn đúng bằng giá trị đó. Trả số echo đã đánh dấu.
 */
export async function reclassifyEchoesAfterCustomer(
  db: DbLike,
  conversationId: string,
  customerSentAt: Date,
): Promise<number> {
  const to = new Date(customerSentAt.getTime() + AUTOMATION_ECHO_WINDOW_SEC * 1000);
  const marked = await db
    .update(messages)
    .set({
      raw: sql`(case when jsonb_typeof(${messages.raw}) = 'object' then ${messages.raw}
          when ${messages.raw} is null then '{}'::jsonb
          else jsonb_build_object('original', ${messages.raw}) end)
        || jsonb_build_object(${AUTOMATED_ECHO_RAW_KEY}::text, true)`,
    })
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.senderType, 'agent'),
        sql`${messages.senderUserId} is null`,
        sql`(${messages.raw} -> 'outbound') is null`,
        notAutomatedEcho(messages.raw),
        sql`${messages.sentAt} between ${iso(customerSentAt)}::timestamptz and ${iso(to)}::timestamptz`,
      ),
    )
    .returning({
      pauseUntil: sql<string | null>`${messages.raw} ->> ${ECHO_PAUSE_RAW_KEY}::text`,
      sentAt: messages.sentAt,
    });
  for (const { pauseUntil, sentAt } of marked) {
    if (!pauseUntil) continue;
    // Gỡ khi pause vẫn đúng bằng giá trị echo đặt VÀ không có tin nhân viên thật nào (không phải echo tự động) từ
    // lúc echo gửi: mốc "dừng hẳn" (agent_reply_mode 'stop') luôn cùng một giá trị nên so bằng nhau chưa đủ để
    // biết echo còn "sở hữu" nó — nhân viên khác nhắn sau đó cũng muốn bot dừng.
    await db
      .update(conversations)
      .set({ aiPausedUntil: null })
      .where(
        and(
          eq(conversations.id, conversationId),
          sql`${conversations.aiPausedUntil} = ${pauseUntil}::timestamptz`,
          sql`not exists (select 1 from ${messages} a
            where a.conversation_id = ${conversationId} and a.sender_type = 'agent'
              and ${notAutomatedEcho(sql`a.raw`)} and a.sent_at >= ${iso(sentAt)}::timestamptz)`,
        ),
      );
  }
  return marked.length;
}
