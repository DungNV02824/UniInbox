// Payload các job BullMQ (tên hàng đợi ở QUEUE_NAMES của @dezon/shared).
import type { ChannelType } from '@dezon/shared';

/** Hàng đợi `inbound`: API chỉ kiểm chữ ký rồi đẩy nguyên payload, worker chuẩn hóa sau (6.1). */
export interface InboundJobData {
  channelType: ChannelType;
  /** Body webhook đã parse JSON */
  payload: unknown;
  /** ISO time API nhận webhook */
  receivedAt: string;
}
export const INBOUND_JOB_NAME = 'webhook';

/** Hàng đợi `outbound`: gửi một message (status = queued) ra nền tảng (6.6). */
export interface OutboundJobData {
  messageId: string;
}
export const OUTBOUND_JOB_NAME = 'send';

/** jobId cố định để không gửi trùng một message (BullMQ không cho ':' trong custom id). */
export const outboundJobId = (messageId: string): string => `send-${messageId}`;

/**
 * Hàng đợi `zalo-oa-token-refresh` (QUEUE_NAMES.zaloOaTokenRefresh).
 * - job "tick" (scheduler, mỗi ZALO_OA_TOKEN_REFRESH_TICK_MS): duyệt kênh zalo_oa đang connected và đẩy job
 *   "refresh" cho kênh có access token còn < ZALO_OA_REFRESH_MIN_VALIDITY_MS.
 * - job "refresh": refreshZaloOaTokensIfNeeded(db, deps, channelAccountId, { minValidityMs, force }).
 */
export interface ZaloOaTokenRefreshJobData {
  channelAccountId: string;
  /** Làm mới dù token còn hạn (nút "Làm mới token" của admin, nếu có). */
  force?: boolean;
}
export const ZALO_OA_TOKEN_REFRESH_JOB_NAME = 'refresh';
export const ZALO_OA_TOKEN_REFRESH_TICK_JOB_NAME = 'tick';
export const ZALO_OA_TOKEN_REFRESH_TICK_MS = 30 * 60_000;
/** jobId cố định: không xếp hai job làm mới cùng kênh (khoá Redis vẫn là lớp bảo vệ chính). */
export const zaloOaTokenRefreshJobId = (channelAccountId: string): string =>
  `zalo-refresh-${channelAccountId}`;

/**
 * Hàng đợi `ai-reply` (QUEUE_NAMES.aiReply), job "reply": một lượt chatbot cho hội thoại, sau debounce
 * (scheduleChatbotReply). jobId cố định aiReplyJobId(conv) ⇒ mỗi hội thoại tối đa một job chờ.
 * Worker gọi processAiReplyJob(db, deps, data.conversationId).
 */
export interface AiReplyJobData {
  conversationId: string;
  /** ISO lúc lên lịch (debug). */
  scheduledAt: string;
}
export const AI_REPLY_JOB_NAME = 'reply';
export const aiReplyJobId = (conversationId: string): string => `ai-${conversationId}`;

/**
 * Cùng hàng đợi `ai-reply`, job "handoff-reminder": sau HANDOFF_ESCALATE_AFTER_MIN phút nếu handoff vẫn
 * chưa ai "Nhận xử lý" (và chưa resolve) ⇒ nhắc Lark một lần + realtime handoff.created { reminder: true }.
 * Worker gọi processHandoffReminderJob(db, deps, data).
 */
export interface HandoffReminderJobData {
  conversationId: string;
  handoffId: string;
}
export const HANDOFF_REMINDER_JOB_NAME = 'handoff-reminder';
export const handoffReminderJobId = (handoffId: string): string => `handoff-reminder-${handoffId}`;

/**
 * Cùng hàng đợi `ai-reply`, job "kick": API đẩy sau khi bật bot / "trả lại cho AI" / "Tiếp tục AI" mà tin
 * cuối (không tính tin system) là của khách đang chờ. Worker gọi maybeScheduleChatbotReply (debounce như
 * tin khách mới) — job "reply" vẫn kiểm lại mọi điều kiện 6.3. jobId aiKickJobId(conv), removeOnComplete.
 */
export interface AiKickJobData {
  conversationId: string;
}
export const AI_KICK_JOB_NAME = 'kick';
export const aiKickJobId = (conversationId: string): string => `ai-kick-${conversationId}`;

/** Giãn cách giữa các bong bóng bot (delay BullMQ của job outbound), ngẫu nhiên trong [min, max]. */
export const BOT_BUBBLE_GAP_MIN_MS = 800;
export const BOT_BUBBLE_GAP_MAX_MS = 1500;
