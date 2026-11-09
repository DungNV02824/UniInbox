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
export const zaloOaTokenRefreshJobId = (channelAccountId: string): string => `zalo-refresh-${channelAccountId}`;
