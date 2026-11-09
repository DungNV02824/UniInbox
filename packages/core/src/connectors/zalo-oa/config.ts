// Kiểu cấu hình/credentials/API của connector Zalo OA. Nguồn sự thật: docs/research/zalo-oa.md.
import type { PipelineLogger } from '../../pipeline/types';

export type ZaloSignatureTimestampSource = 'body' | 'header';

/** Header có thể chứa timeStamp khi ZALO_SIGNATURE_TIMESTAMP_SOURCE=header (chưa xác minh, §4c/§11). */
export const ZALO_SIGNATURE_TIMESTAMP_HEADERS = ['x-zevent-timestamp', 'x-event-timestamp', 'timestamp'] as const;
/** Header chữ ký: tài liệu webhook ghi X-ZEvent-Signature; trang SDK ghi X-Event-Signature (§4c). */
export const ZALO_SIGNATURE_HEADERS = ['x-zevent-signature', 'x-event-signature'] as const;

export interface ZaloOaConfig {
  /** ZALO_APP_ID */
  appId: string;
  /** ZALO_APP_SECRET — header `secret_key` của token endpoint; khoá của appsecret_proof. */
  appSecret: string;
  /** ZALO_OA_SECRET_KEY — "OA Secret Key" ở trang Webhook của app (KHÔNG phải App Secret). */
  oaSecretKey: string;
  /** ZALO_OAUTH_BASE_URL, mặc định https://oauth.zaloapp.com */
  oauthBaseUrl: string;
  /** ZALO_OPENAPI_BASE_URL, mặc định https://openapi.zalo.me */
  openApiBaseUrl: string;
  /** ZALO_SIGNATURE_TIMESTAMP_SOURCE */
  signatureTimestampSource: ZaloSignatureTimestampSource;
  /**
   * Phục hồi access token khi OpenAPI trả -216/-220 (token bị thay bởi lần refresh khác hoặc hết hạn).
   * Worker cài bằng refreshZaloOaTokensIfNeeded(..., { force: true, staleAccessToken }). Thiếu => ném
   * PermanentSendError(credentialsInvalid) như bình thường.
   */
  tokenProvider?: ZaloOaTokenProvider;
  /** Log chẩn đoán (ví dụ biến thể chữ ký khi lệch — KHÔNG log secret/nội dung tin). */
  logger?: Pick<PipelineLogger, 'warn' | 'debug'>;
  /** Cho phép tiêm fetch khi test. */
  fetch?: typeof fetch;
}

export interface ZaloOaTokenProvider {
  /**
   * Trả access token hợp lệ mới nhất cho kênh, biết rằng `staleAccessToken` vừa bị Zalo từ chối.
   * Đọc DB dưới khoá: token trong DB đã khác => trả luôn (không gọi Zalo); vẫn là token cũ => refresh.
   * Không làm mới được => ném PermanentSendError(credentialsInvalid = true).
   */
  recoverAccessToken(channelAccountId: string, staleAccessToken: string): Promise<string>;
}

/** Credentials lưu (mã hoá) trong channel_accounts.credentials cho Zalo OA. */
export interface ZaloOaCredentials {
  accessToken: string;
  /** Dùng MỘT lần; mỗi lần refresh trả refresh token mới. */
  refreshToken: string;
  /** ISO — 25 giờ sau khi cấp (expires_in "90000"). */
  accessTokenExpiresAt: string;
  /** ISO — 3 tháng sau khi cấp (Zalo không trả, tự tính). */
  refreshTokenExpiresAt: string;
  oaId: string;
  oaName: string;
}

/** Cặp token trả về từ token endpoint (cả grant authorization_code và refresh_token). */
export interface ZaloOaTokenPair {
  accessToken: string;
  refreshToken: string;
  /** ISO, = now + expires_in giây (expires_in là CHUỖI, parse phòng thủ; thiếu => 25 giờ). */
  accessTokenExpiresAt: string;
  /** ISO, = now + 3 tháng. */
  refreshTokenExpiresAt: string;
}

/** GET {openApi}/v2.0/oa/getoa — thông tin OA (các trường package_* chưa xác minh trên OA thật). */
export interface ZaloOaInfo {
  oaId: string;
  name: string;
  avatarUrl: string | null;
  isVerified: boolean | null;
  /** Tên gói OA nếu API trả (ví dụ "Gói Tăng trưởng"). */
  packageName: string | null;
  /** Ngày hết hạn gói nếu API trả, ISO hoặc chuỗi gốc. */
  packageValidThrough: string | null;
}

export interface ZaloOaAuthorizeUrlInput {
  /** Phải TRÙNG "Official Account Callback Url" đã đăng ký: `${API_URL}${ZALO_OA_OAUTH_CALLBACK_PATH}`. */
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

/** OAuth v4 cho OA (PKCE). */
export interface ZaloOaAuthApi {
  /** `${oauthBaseUrl}/v4/oa/permission?app_id&redirect_uri&code_challenge&state` (KHÔNG có code_challenge_method). */
  buildAuthorizeUrl(input: ZaloOaAuthorizeUrlInput): string;
  /**
   * POST `${oauthBaseUrl}/v4/oa/access_token` (form: code, app_id, grant_type=authorization_code, code_verifier;
   * header secret_key = App Secret). HTTP 200 không có access_token => ZaloOaAuthError (log error/error_name).
   */
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<ZaloOaTokenPair>;
  /** Như trên với grant_type=refresh_token. Refresh token cũ mất hiệu lực ngay khi thành công. */
  refresh(refreshToken: string): Promise<ZaloOaTokenPair>;
  /** GET `${openApiBaseUrl}/v2.0/oa/getoa` header access_token. */
  getOaInfo(accessToken: string): Promise<ZaloOaInfo>;
}

/** Lỗi OAuth/OA info. `transient` = mạng/5xx/-32 (thử lại được, KHÔNG đánh dấu kênh hết hạn). */
export class ZaloOaAuthError extends Error {
  override readonly name = 'ZaloOaAuthError';
  constructor(
    message: string,
    readonly transient: boolean,
    /** `error` số của Zalo (ví dụ -224) hoặc mã chuỗi của token endpoint, nếu có. */
    readonly platformCode?: string | number,
  ) {
    super(message);
  }
}

/** Vòng đời token theo tài liệu (§2a). */
export const ZALO_OA_ACCESS_TOKEN_TTL_MS = 25 * 60 * 60_000;
export const ZALO_OA_REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60_000;
/** Code verifier: 43 ký tự [A-Za-z0-9]. */
export const ZALO_PKCE_VERIFIER_LENGTH = 43;
/** state → verifier sống 10 phút (bằng hạn authorization code). */
export const ZALO_OAUTH_STATE_TTL_MS = 10 * 60_000;
