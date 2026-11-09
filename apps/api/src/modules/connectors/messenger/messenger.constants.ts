/** MessengerGraphApi (tạo lười; thiếu cấu hình Meta => mỗi lần gọi ném 503). */
export const MESSENGER_GRAPH_API = Symbol('MESSENGER_GRAPH_API');

/** MessengerLoginApi — Facebook Login để chọn Fanpage (tạo lười như trên). */
export const MESSENGER_LOGIN_API = Symbol('MESSENGER_LOGIN_API');

export const META_NOT_CONFIGURED_MESSAGE = 'Chưa cấu hình Meta App';
export const WEBHOOK_ACK = 'EVENT_RECEIVED';
/** Giới hạn body webhook (Meta gom tối đa nhiều sự kiện trong một lần gọi). */
export const WEBHOOK_BODY_LIMIT_BYTES = 5 * 1024 * 1024;
export const WEBHOOK_PATH_PREFIX = '/webhooks/';
