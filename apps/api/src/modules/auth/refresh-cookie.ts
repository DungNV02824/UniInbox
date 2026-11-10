import { REFRESH_TOKEN_COOKIE } from '@dezon/shared';
import type { CookieOptions, HttpReply } from '../../common/http.types';
import type { AppConfig } from '../../config';
import { REFRESH_COOKIE_PATH } from './auth.constants';

/**
 * Path của cookie refresh theo URL công khai của API: API sau tiền tố (vd. https://host/api, proxy bỏ
 * `/api`) thì trình duyệt thấy `/api/auth/...` nên cookie phải là `/api/auth`; API ở gốc (dev) => `/auth`.
 */
export function refreshCookiePath(apiUrl: string): string {
  const prefix = new URL(apiUrl).pathname.replace(/\/+$/, '');
  return `${prefix}${REFRESH_COOKIE_PATH}`;
}

function baseOptions(config: AppConfig): CookieOptions {
  return {
    path: refreshCookiePath(config.API_URL),
    httpOnly: true,
    sameSite: 'lax',
    secure: config.NODE_ENV === 'production',
  };
}

export function setRefreshCookie(reply: HttpReply, token: string, maxAgeSeconds: number, config: AppConfig) {
  reply.setCookie(REFRESH_TOKEN_COOKIE, token, { ...baseOptions(config), maxAge: maxAgeSeconds });
}

export function clearRefreshCookie(reply: HttpReply, config: AppConfig) {
  reply.clearCookie(REFRESH_TOKEN_COOKIE, baseOptions(config));
}
