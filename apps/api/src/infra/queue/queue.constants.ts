/** BullMQ Queue `inbound` (webhook đã kiểm chữ ký, worker chuẩn hóa sau). */
export const INBOUND_QUEUE = Symbol('INBOUND_QUEUE');
/** BullMQ Queue `outbound` (gửi tin ra nền tảng). */
export const OUTBOUND_QUEUE = Symbol('OUTBOUND_QUEUE');
/** BullMQ Queue `channel-sync` (đồng bộ hội thoại qua API nền tảng: lịch sử + định kỳ). */
export const CHANNEL_SYNC_QUEUE = Symbol('CHANNEL_SYNC_QUEUE');
/** BullMQ Queue `ai-reply` (API chỉ đẩy job "kick" đánh thức chatbot; worker lo debounce/chạy). */
export const AI_REPLY_QUEUE = Symbol('AI_REPLY_QUEUE');
/** Kết nối Redis riêng cho các Queue. */
export const QUEUE_CONNECTION = Symbol('QUEUE_CONNECTION');

/** Thời gian tối đa chờ Redis khi đẩy job (webhook phải trả lời nhanh). */
export const ENQUEUE_TIMEOUT_MS = 3_000;
