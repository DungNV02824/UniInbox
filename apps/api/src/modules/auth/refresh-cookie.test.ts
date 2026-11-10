import { REFRESH_TOKEN_COOKIE } from '@dezon/shared';
import { describe, expect, it, vi } from 'vitest';
import type { HttpReply } from '../../common/http.types';
import type { AppConfig } from '../../config';
import { clearRefreshCookie, refreshCookiePath, setRefreshCookie } from './refresh-cookie';

describe('refreshCookiePath', () => {
  it('API ở gốc (dev) => /auth', () => {
    expect(refreshCookiePath('http://localhost:4000')).toBe('/auth');
    expect(refreshCookiePath('http://localhost:4000/')).toBe('/auth');
  });

  it('API sau tiền tố (proxy bỏ /api) => /api/auth', () => {
    expect(refreshCookiePath('https://alo.vuathau.com.vn/api')).toBe('/api/auth');
    expect(refreshCookiePath('https://alo.vuathau.com.vn/api/')).toBe('/api/auth');
  });
});

describe('set/clearRefreshCookie', () => {
  const reply = () =>
    ({ setCookie: vi.fn(), clearCookie: vi.fn() }) as unknown as HttpReply & {
      setCookie: ReturnType<typeof vi.fn>;
      clearCookie: ReturnType<typeof vi.fn>;
    };

  it('production sau tiền tố => Path=/api/auth, Secure, HttpOnly, SameSite=Lax', () => {
    const config = { NODE_ENV: 'production', API_URL: 'https://alo.vuathau.com.vn/api' } as AppConfig;
    const r = reply();
    setRefreshCookie(r, 'tok', 60, config);
    expect(r.setCookie).toHaveBeenCalledWith(REFRESH_TOKEN_COOKIE, 'tok', {
      path: '/api/auth',
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      maxAge: 60,
    });
    clearRefreshCookie(r, config);
    expect(r.clearCookie).toHaveBeenCalledWith(REFRESH_TOKEN_COOKIE, {
      path: '/api/auth',
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
    });
  });

  it('dev => Path=/auth, không Secure', () => {
    const config = { NODE_ENV: 'development', API_URL: 'http://localhost:4000' } as AppConfig;
    const r = reply();
    setRefreshCookie(r, 'tok', 60, config);
    expect(r.setCookie).toHaveBeenCalledWith(
      REFRESH_TOKEN_COOKIE,
      'tok',
      expect.objectContaining({ path: '/auth', secure: false }),
    );
  });
});
