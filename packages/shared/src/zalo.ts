// Hợp đồng Zalo OA (Giai đoạn 1B) dùng chung giữa api, worker và web.
// Nguồn sự thật về nền tảng: docs/research/zalo-oa.md (ưu tiên hơn đặc tả khi khác nhau).

// ---------- Kết nối OA bằng OAuth v4 (PKCE) ----------

/** Đường dẫn API nhận callback OAuth của Zalo (đăng ký ở "Official Account Callback Url"). */
export const ZALO_OA_OAUTH_CALLBACK_PATH = '/channels/zalo-oa/oauth/callback';
/** Đường dẫn API nhận webhook Zalo OA (POST). */
export const ZALO_OA_WEBHOOK_PATH = '/webhooks/zalo-oa';

/** POST /channels/zalo-oa/oauth/start (admin) — mở bằng window.location.assign (chuyển hẳn sang Zalo). */
export interface ZaloOaLoginStartResponse {
  authorizeUrl: string;
}

/**
 * Callback xong, API 302 về `${APP_URL}/admin/channels?zaloResult=ok&channelId=<uuid>`
 * hoặc `?zaloResult=error&zaloError=<ZaloOaConnectErrorCode>`. Tên tham số query:
 */
export const ZALO_OA_RESULT_QUERY = {
  result: 'zaloResult',
  channelId: 'channelId',
  error: 'zaloError',
} as const;

export const ZALO_OA_RESULTS = ['ok', 'error'] as const;
export type ZaloOaResult = (typeof ZALO_OA_RESULTS)[number];

/** Mã lỗi ngắn trong `?zaloError=`. */
export const ZALO_OA_CONNECT_ERROR_CODES = [
  /** Admin OA bấm từ chối / callback không có code. */
  'denied',
  /** state không khớp / hết hạn (quá 10 phút). */
  'state',
  /** Đổi code lấy token thất bại. */
  'exchange',
  /** Lấy thông tin OA thất bại (thường do OA chưa có gói Tăng trưởng/Toàn diện: lỗi -224). */
  'oa_info',
  /** Máy chủ thiếu ZALO_APP_ID / ZALO_APP_SECRET. */
  'not_configured',
  'unknown',
] as const;
export type ZaloOaConnectErrorCode = (typeof ZALO_OA_CONNECT_ERROR_CODES)[number];

/** Thông điệp tiếng Việt cho từng mã lỗi kết nối (web hiển thị). */
export const ZALO_OA_CONNECT_ERROR_MESSAGES: Record<ZaloOaConnectErrorCode, string> = {
  denied: 'Bạn đã huỷ cấp quyền cho ứng dụng trên Zalo.',
  state: 'Phiên kết nối đã hết hạn hoặc không hợp lệ, vui lòng thử lại.',
  exchange: 'Không lấy được mã truy cập từ Zalo, vui lòng thử lại.',
  oa_info:
    'Không đọc được thông tin OA. Kiểm tra OA đã xác thực và đang dùng gói Tăng trưởng hoặc Toàn diện.',
  not_configured: 'Máy chủ chưa cấu hình ZALO_APP_ID / ZALO_APP_SECRET.',
  unknown: 'Kết nối Zalo OA thất bại do lỗi không xác định.',
};

// ---------- Thông tin kênh Zalo OA trên trang Kênh (không bao giờ chứa token) ----------

/** ChannelAccountDto.zaloOa — đọc từ channel_accounts.settings.zaloOa. */
export interface ZaloOaChannelInfo {
  /** Access token hết hạn lúc (25 giờ sau khi cấp), ISO. */
  tokenExpiresAt: string | null;
  /** Refresh token hết hạn lúc (3 tháng sau khi cấp, dùng 1 lần), ISO. Quá hạn => phải kết nối lại. */
  refreshTokenExpiresAt: string | null;
  /** Lần làm mới token thành công gần nhất, ISO. */
  lastRefreshedAt?: string | null;
  /** Ghi chú về gói OA (ví dụ "Gói Tăng trưởng, hết hạn 01/01/2027"), null nếu không rõ. */
  packageNote?: string | null;
}

/** Cảnh báo trên trang Kênh khi refresh token còn ít hơn ngần này. */
export const ZALO_OA_REFRESH_TOKEN_WARN_MS = 14 * 24 * 60 * 60 * 1000;

// ---------- Giới hạn gửi tin tư vấn ----------

/** Tin văn bản tối đa 2000 ký tự ("Giới hạn tối đa là 2.000 ký tự"). */
export const ZALO_OA_TEXT_MAX_CHARS = 2000;
/** Ảnh gửi đi: jpg/png ≤ 1 MB (hệ thống tự nén lại trước khi upload). */
export const ZALO_OA_IMAGE_MAX_BYTES = 1024 * 1024;
export const ZALO_OA_IMAGE_MIMES = ['image/jpeg', 'image/png'] as const;
/** Tệp gửi đi: chỉ PDF/DOC/DOCX/CSV ≤ 5 MB. Video, âm thanh, Excel... không gửi được qua Zalo OA. */
export const ZALO_OA_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const ZALO_OA_FILE_MIMES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/csv',
] as const;
export const ZALO_OA_FILE_EXTENSIONS = ['pdf', 'doc', 'docx', 'csv'] as const;

/** Tệp đính kèm có gửi được qua Zalo OA không (ảnh mọi định dạng ảnh: hệ thống chuyển sang JPEG). */
export function isZaloOaSendableAttachment(input: {
  type: string;
  mime: string;
  name?: string;
}): boolean {
  if (input.type === 'image') return input.mime.startsWith('image/');
  if (input.type !== 'file') return false;
  if ((ZALO_OA_FILE_MIMES as readonly string[]).includes(input.mime)) return true;
  const ext = input.name?.split('.').pop()?.toLowerCase();
  return ext !== undefined && (ZALO_OA_FILE_EXTENSIONS as readonly string[]).includes(ext);
}

/** Thông điệp khi tệp không gửi được qua Zalo OA. */
export const ZALO_OA_UNSUPPORTED_ATTACHMENT_MESSAGE =
  'Zalo OA chỉ gửi được ảnh và tệp PDF, DOC, DOCX, CSV (tối đa 5 MB).';
