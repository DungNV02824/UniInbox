// Điều kiện SQL "handoff lỗi AI còn được tự trả lại cho bot" — module lá (chỉ @dezon/db + drizzle) để read model,
// nhắc lại Lark và job tự trả lại (auto-resume.ts) dùng CHUNG một định nghĩa, không vòng import.
import { chatbots, conversations, messages } from '@dezon/db';
import { sql, type SQL } from 'drizzle-orm';
import { notAutomatedEcho } from '../pipeline/automation-echo';

/** Chỉ tự trả lại handoff tạo trong chừng này ngày (cũ hơn ⇒ để nhân viên tự xử lý). */
export const AI_AUTO_RESUME_MAX_AGE_DAYS = 14;

/**
 * Handoff (alias `alias`, vd. 'h' hoặc '"handoffs"') lỗi AI mà worker VẪN SẼ tự trả lại cho bot (bỏ qua các điều kiện
 * tạm thời: AI tổng, tạm dừng AI, chống vòng lặp, handoff khác đang mở): đang mở, auto_resume, chưa ai "Nhận xử lý",
 * tạo trong AI_AUTO_RESUME_MAX_AGE_DAYS ngày tính tới `now`, hội thoại còn gắn bot đang bật, và KHÔNG có tin nhân viên
 * (trừ echo tự động của Page) từ lúc handoff tạo. Sai ⇒ banner/Lark KHÔNG được hứa "bot sẽ tự trả lời lại".
 */
export function aiOutageResumableSql(alias: string, now: SQL): SQL {
  const h = sql.raw(alias);
  return sql`(${h}.auto_resume and ${h}.resolved_at is null and ${h}.acknowledged_by is null
    and ${h}.created_at >= ${now} - make_interval(days => ${AI_AUTO_RESUME_MAX_AGE_DAYS})
    and exists (select 1 from ${conversations} rc inner join ${chatbots} rb on rb.id = rc.chatbot_id
      where rc.id = ${h}.conversation_id and rb.is_active)
    and not exists (select 1 from ${messages} ra
      where ra.conversation_id = ${h}.conversation_id and ra.sender_type = 'agent'
        and ${notAutomatedEcho(sql`ra.raw`)} and ra.created_at >= ${h}.created_at))`;
}
