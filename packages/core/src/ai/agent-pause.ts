// "Khi nhân viên vào nhắn tin" (chatbots.agent_reply_mode): nhân viên vừa gửi tin (sendAgentMessage hoặc echo
// Business Suite không phải tự động) ⇒ áp chế độ của bot đang gắn với hội thoại lên conversations.ai_paused_until.
// - 'continue': không đụng ai_paused_until (bot vẫn trả lời song song với nhân viên).
// - 'pause'   : ai_paused_until = max(hiện tại, at + (bot.agent_pause_minutes ?? AI_PAUSE_AFTER_AGENT_MIN)).
// - 'stop'    : ai_paused_until = AI_PAUSED_INDEFINITELY_ISO ("dừng hẳn") — gỡ bằng "Tiếp tục AI" / bật lại bot.
// Pause chỉ được kéo dài, không bao giờ rút ngắn (tin đồng bộ cũ không rút ngắn pause, 'pause' không gỡ 'stop').
import { chatbots, conversations } from '@dezon/db';
import { AI_PAUSED_INDEFINITELY_ISO, type AgentReplyMode } from '@dezon/shared';
import { eq } from 'drizzle-orm';
import type { DbLike } from '../inbox/read-model';

/** Mặc định AI_PAUSE_AFTER_AGENT_MIN (bot không đặt agent_pause_minutes). */
export const DEFAULT_AI_PAUSE_AFTER_AGENT_MIN = 30;

const PAUSED_INDEFINITELY = new Date(AI_PAUSED_INDEFINITELY_ISO);

export interface AgentPauseResult {
  /** Chế độ "Khi nhân viên vào nhắn tin" của bot đang gắn. */
  mode: AgentReplyMode;
  /** Mốc tin này muốn đặt: 'pause' = at + số phút, 'stop' = AI_PAUSED_INDEFINITELY_ISO, 'continue' = null. */
  requestedUntil: Date | null;
  /** ai_paused_until sau khi xử lý (có thể là pause cũ dài hơn mốc yêu cầu). */
  pausedUntil: Date | null;
  /**
   * true = chính tin này vừa đặt ai_paused_until (= requestedUntil; trước đó không có pause hoặc pause ngắn hơn).
   * Echo dùng cờ này để "sở hữu" pause (raw.aiPauseUntil) và gỡ nếu sau đó bị phân loại là tin tự động.
   */
  applied: boolean;
}

/** Mốc pause theo chế độ của bot; null = không tạm dừng ('continue'). */
function requestedPauseUntil(mode: AgentReplyMode, pauseMinutes: number, at: Date): Date | null {
  if (mode === 'continue') return null;
  if (mode === 'stop') return PAUSED_INDEFINITELY;
  return new Date(at.getTime() + pauseMinutes * 60_000);
}

/**
 * Nhân viên vừa gửi tin lúc `at` ⇒ áp agent_reply_mode của bot gắn với hội thoại (xem đầu file). Không có bot
 * (chatbot_id null) ⇒ null, không đổi gì. `fallbackPauseMinutes` = AI_PAUSE_AFTER_AGENT_MIN của server, dùng khi
 * bot không đặt agent_pause_minutes. `db` nhận cả transaction (khóa dòng hội thoại để đọc-rồi-ghi an toàn).
 *
 * Khóa FOR NO KEY UPDATE (không phải FOR UPDATE): người gọi thường đã INSERT messages (FK ⇒ FOR KEY SHARE trên
 * dòng hội thoại) rồi UPDATE conversations (NO KEY UPDATE) trong cùng transaction. FOR UPDATE xung đột với KEY SHARE
 * của transaction khác vừa chèn tin vào cùng hội thoại (echo + tin khách xử lý song song) ⇒ deadlock 40P01.
 * NO KEY UPDATE không xung đột với KEY SHARE, vẫn tuần tự hóa các lần đọc-rồi-ghi ai_paused_until với nhau
 * (ai_paused_until không phải cột khóa, UPDATE bên dưới cũng chỉ lấy NO KEY UPDATE).
 */
export async function pauseAiAfterAgentMessage(
  db: DbLike,
  conversationId: string,
  at: Date,
  fallbackPauseMinutes: number = DEFAULT_AI_PAUSE_AFTER_AGENT_MIN,
): Promise<AgentPauseResult | null> {
  const [row] = await db
    .select({
      pausedUntil: conversations.aiPausedUntil,
      mode: chatbots.agentReplyMode,
      pauseMinutes: chatbots.agentPauseMinutes,
    })
    .from(conversations)
    .innerJoin(chatbots, eq(chatbots.id, conversations.chatbotId))
    .where(eq(conversations.id, conversationId))
    .for('no key update', { of: conversations });
  if (!row) return null;

  const requestedUntil = requestedPauseUntil(row.mode, row.pauseMinutes ?? fallbackPauseMinutes, at);
  // 'continue', hoặc pause hiện tại đã dài bằng/hơn mốc yêu cầu (tin cũ, hoặc đang 'stop') ⇒ giữ nguyên.
  if (!requestedUntil || (row.pausedUntil && row.pausedUntil.getTime() >= requestedUntil.getTime())) {
    return { mode: row.mode, requestedUntil, pausedUntil: row.pausedUntil, applied: false };
  }
  await db
    .update(conversations)
    .set({ aiPausedUntil: requestedUntil })
    .where(eq(conversations.id, conversationId));
  return { mode: row.mode, requestedUntil, pausedUntil: requestedUntil, applied: true };
}
