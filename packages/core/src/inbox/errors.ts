// Lỗi nghiệp vụ hộp thư; API ánh xạ sang HTTP (404/403/422/400).
export class InboxNotFoundError extends Error {
  override readonly name = 'InboxNotFoundError';
}
export class InboxForbiddenError extends Error {
  override readonly name = 'InboxForbiddenError';
}
/** Ngoài cửa sổ gửi, kênh mất kết nối... `message` là lý do tiếng Việt cho nhân viên. */
export class SendNotAllowedError extends Error {
  override readonly name = 'SendNotAllowedError';
}
export class InboxValidationError extends Error {
  override readonly name = 'InboxValidationError';
}

/**
 * Tin sẽ bị tính phí (Zalo OA 48 giờ–7 ngày) mà request chưa có `confirmCostly: true`.
 * API ánh xạ sang 409 với body `{ statusCode: 409, message, code: 'COSTLY_CONFIRM_REQUIRED' }`.
 */
export class CostlyConfirmRequiredError extends Error {
  override readonly name = 'CostlyConfirmRequiredError';
  readonly code = 'COSTLY_CONFIRM_REQUIRED' as const;
}

/** Thao tác trên kênh xung đột với trạng thái hiện tại (vd. xóa kênh đang kết nối). API ánh xạ sang 409. */
export class ChannelDeleteConflictError extends Error {
  override readonly name = 'ChannelDeleteConflictError';
}
