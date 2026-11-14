// Lỗi nghiệp vụ chatbot. Không tìm thấy / không có quyền / dữ liệu sai dùng lại
// InboxNotFoundError / InboxForbiddenError / InboxValidationError (API đã ánh xạ 404/403/422).

/** Tên bot đã tồn tại (unique chatbots_name_unique). API ánh xạ sang 409. */
export class ChatbotNameConflictError extends Error {
  override readonly name = 'ChatbotNameConflictError';
  constructor(message = 'Tên chatbot đã tồn tại') {
    super(message);
  }
}

/** Gửi webhook Lark thất bại (HTTP lỗi hoặc body { code ≠ 0 }). `message` tiếng Việt, không chứa secret. */
export class LarkNotifyError extends Error {
  override readonly name = 'LarkNotifyError';
}

/**
 * AI không soạn được tin cho thao tác của nhân viên (vd. nút "Không đạt": lỗi gọi Gemini, model không gọi `reply`).
 * Chưa gửi gì cho khách. API ánh xạ sang 502.
 */
export class ChatbotComposeError extends Error {
  override readonly name = 'ChatbotComposeError';
  constructor(message = 'AI không soạn được tin, vui lòng thử lại') {
    super(message);
  }
}
