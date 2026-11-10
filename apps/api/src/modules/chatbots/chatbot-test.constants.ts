// Giới hạn riêng của "Chat thử" khi kèm ảnh (base64 trong JSON).

/**
 * Giới hạn body cho riêng POST /chatbots/:id/test và /chatbots/test-draft (route khác giữ mặc định 1 MB).
 * 10 ảnh × 4 MB (CHATBOT_LIMITS) mã hóa base64 ≈ 54 MB, nhưng core chỉ gửi model tổng ~16 MB ảnh mỗi lượt
 * (ảnh vượt bị bỏ kèm ghi chú) ⇒ 45 MB là đủ rộng cho thực tế (ảnh điện thoại đã nén ≈ 1–3 MB) mà không cho
 * một request nuốt quá nhiều RAM. Số ảnh / dung lượng từng ảnh vẫn kiểm riêng (400).
 */
export const CHATBOT_TEST_BODY_LIMIT_BYTES = 45 * 1024 * 1024;

/** URL route (theo cú pháp Fastify) được nới giới hạn body ở trên. */
export const CHATBOT_TEST_ROUTE_URLS: ReadonlySet<string> = new Set([
  '/chatbots/:id/test',
  '/chatbots/test-draft',
]);

/** Thông điệp 413 cho hai route trên (gắn vào route config, AllExceptionsFilter đọc ra). */
export const CHATBOT_TEST_BODY_TOO_LARGE_MESSAGE = `Ảnh chạy thử quá lớn: tổng dữ liệu gửi lên tối đa ${
  CHATBOT_TEST_BODY_LIMIT_BYTES / 1024 / 1024
} MB. Vui lòng bớt ảnh hoặc dùng ảnh nhỏ hơn.`;
