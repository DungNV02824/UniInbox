import { REFRESH_TOKEN_COOKIE } from '@dezon/shared';
import type { CookieOptions, HttpReply } from '../../common/http.types';
import type { AppConfig } from '../../config';
import { REFRESH_COOKIE_PATH } from './auth.constants';

function baseOptions(config: AppConfig): CookieOptions {
  return {
    path: REFRESH_COOKIE_PATH,
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
