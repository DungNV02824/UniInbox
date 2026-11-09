// Nhãn nền tảng + xử lý query `?fbSession` / `?fbError` (trang admin Kênh).
import { FACEBOOK_LOGIN_ERROR_CODES, type ChannelType, type FacebookLoginErrorCode } from '@dezon/shared';

/** Nhãn nền tảng (huy hiệu trên trang Kênh, nhóm trong bộ lọc kênh của hộp thư). */
export const PLATFORM_LABELS: Record<ChannelType, string> = {
  messenger: 'Facebook',
  zalo_oa: 'Zalo OA',
  zalo_personal: 'Zalo cá nhân',
};

// ---------- Query param khi Facebook chuyển về ----------

export const FB_SESSION_PARAM = 'fbSession';
export const FB_ERROR_PARAM = 'fbError';
const SESSION_ID = /^[A-Za-z0-9_-]{20,100}$/;

export interface FacebookReturnParams {
  sessionId: string | null;
  error: FacebookLoginErrorCode | null;
  /** Có tham số cần xóa khỏi URL. */
  hasParams: boolean;
}

export function readFacebookReturnParams(search: string | URLSearchParams): FacebookReturnParams {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const rawSession = params.get(FB_SESSION_PARAM);
  const rawError = params.get(FB_ERROR_PARAM);
  const sessionId = rawSession && SESSION_ID.test(rawSession) ? rawSession : null;
  let error: FacebookLoginErrorCode | null = null;
  if (rawError !== null) {
    error = (FACEBOOK_LOGIN_ERROR_CODES as readonly string[]).includes(rawError)
      ? (rawError as FacebookLoginErrorCode)
      : 'unknown';
  }
  if (rawSession !== null && !sessionId && !error) error = 'state';
  return { sessionId, error, hasParams: rawSession !== null || rawError !== null };
}

/** URL hiện tại bỏ `fbSession`/`fbError` (giữ path, query khác và hash). */
export function stripFacebookReturnParams(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(FB_SESSION_PARAM);
  url.searchParams.delete(FB_ERROR_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

export const FACEBOOK_ERROR_MESSAGES: Record<FacebookLoginErrorCode, string> = {
  denied:
    'Bạn đã hủy đăng nhập Facebook hoặc chưa cấp quyền. Hãy thử lại và đồng ý các quyền được yêu cầu (quản lý Trang, nhắn tin).',
  state:
    'Phiên đăng nhập Facebook không hợp lệ hoặc đã quá 10 phút. Vui lòng bấm “Kết nối → Facebook” để thử lại.',
  exchange:
    'Không lấy được quyền truy cập từ Facebook. Kiểm tra App ID/App Secret và “Valid OAuth Redirect URI” của Meta App rồi thử lại.',
  not_configured: 'Máy chủ chưa cấu hình Meta App (META_APP_ID, META_APP_SECRET). Liên hệ quản trị kỹ thuật.',
  unknown: 'Đăng nhập Facebook không thành công. Vui lòng thử lại.',
};
