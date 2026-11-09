import { createDb, users } from '@dezon/db';
import { type LoginResponse, REFRESH_TOKEN_COOKIE } from '@dezon/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.factory';
import { INVALID_CREDENTIALS_MESSAGE } from '../src/modules/auth/auth.constants';
import { AuthService } from '../src/modules/auth/auth.service';
import { ADMIN, AGENT, INACTIVE, startInfra, type TestInfra } from './test-env';

type InjectResponse = Awaited<ReturnType<NestFastifyApplication['inject']>>;

let infra: TestInfra;
let app: NestFastifyApplication;

beforeAll(async () => {
  infra = await startInfra();
  app = await createApp();
});

afterAll(async () => {
  await app?.close();
  await infra?.stop();
});

const login = (email: string, password: string) =>
  app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function refreshCookie(res: InjectResponse) {
  return res.cookies.find((c) => c.name === REFRESH_TOKEN_COOKIE);
}

async function loginOk(email: string, password: string) {
  const res = await login(email, password);
  expect(res.statusCode).toBe(200);
  const cookie = refreshCookie(res);
  expect(cookie).toBeDefined();
  return { body: res.json<LoginResponse>(), refreshToken: cookie!.value };
}

describe('hệ thống', () => {
  it('GET /health => 200 khi DB và Redis sống', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', checks: { db: 'up', redis: 'up' } });
  });

  it('GET /config => cờ tính năng mặc định false', async () => {
    const res = await app.inject({ method: 'GET', url: '/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ featureAiEnabled: false, zaloPersonalEnabled: false });
  });

  it('GET /config => true khi env bật', async () => {
    process.env.FEATURE_AI_ENABLED = 'true';
    process.env.ZALO_PERSONAL_ENABLED = 'true';
    const other = await createApp();
    try {
      const res = await other.inject({ method: 'GET', url: '/config' });
      expect(res.json()).toEqual({ featureAiEnabled: true, zaloPersonalEnabled: true });
    } finally {
      process.env.FEATURE_AI_ENABLED = '';
      process.env.ZALO_PERSONAL_ENABLED = '';
      await other.close();
    }
  });

  it('GET /health => 503 và chỉ rõ thành phần bị lỗi', async () => {
    const realRedisUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    const broken = await createApp();
    try {
      const res = await broken.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: 'error', checks: { db: 'up', redis: 'down' } });
    } finally {
      process.env.REDIS_URL = realRedisUrl;
      await broken.close();
    }
  });

  it('header bảo mật (helmet) và CORS cho APP_URL', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/auth/login',
      headers: { origin: 'http://localhost:3100', 'access-control-request-method': 'POST' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3100');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.headers['x-content-type-options']).toBe('nosniff');
  });

  it('CORS vẫn đúng khi APP_URL có dấu / cuối hoặc path', async () => {
    const realAppUrl = process.env.APP_URL;
    process.env.APP_URL = 'http://localhost:3100/inbox/';
    const other = await createApp();
    try {
      const res = await other.inject({
        method: 'OPTIONS',
        url: '/auth/login',
        headers: { origin: 'http://localhost:3100', 'access-control-request-method': 'POST' },
      });
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3100');
    } finally {
      process.env.APP_URL = realAppUrl;
      await other.close();
    }
  });

  it('x-request-id: giữ id hợp lệ từ proxy, thay id không hợp lệ bằng UUID', async () => {
    const kept = await app.inject({
      method: 'GET',
      url: '/config',
      headers: { 'x-request-id': 'req-abc_1' },
    });
    expect(kept.headers['x-request-id']).toBe('req-abc_1');
    const replaced = await app.inject({
      method: 'GET',
      url: '/config',
      headers: { 'x-request-id': 'xấu\nlog-injection' },
    });
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('lỗi có dạng {statusCode, message}: route không tồn tại, JSON hỏng', async () => {
    const notFound = await app.inject({ method: 'GET', url: '/khong-ton-tai' });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toMatchObject({ statusCode: 404, message: expect.any(String) });

    const badJson = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"email":',
    });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json()).toMatchObject({ statusCode: 400, message: expect.any(String) });
    expect(badJson.body).not.toContain('stack');
  });
});

describe('đăng nhập', () => {
  it('admin đăng nhập OK: nhận JWT và cookie refresh httpOnly', async () => {
    const res = await login(ADMIN.email, ADMIN.password);
    expect(res.statusCode).toBe(200);
    const body = res.json<LoginResponse>();
    expect(body.accessToken.split('.')).toHaveLength(3);
    expect(body.accessTokenExpiresIn).toBe(15 * 60);
    expect(body.user).toEqual({
      id: expect.any(String),
      email: ADMIN.email,
      name: ADMIN.name,
      role: 'admin',
    });
    expect(res.body).not.toContain('argon2');

    const cookie = refreshCookie(res);
    expect(cookie).toMatchObject({ httpOnly: true, path: '/auth', sameSite: 'Lax', maxAge: 30 * 86400 });
    expect(cookie?.secure).toBeFalsy();
    expect(String(res.headers['set-cookie'])).toContain('HttpOnly');
  });

  it('email được chuẩn hóa (hoa/thường, khoảng trắng)', async () => {
    const res = await login(`  ${ADMIN.email.toUpperCase()} `, ADMIN.password);
    expect(res.statusCode).toBe(200);
  });

  it('sai mật khẩu => 401; email không tồn tại => 401 cùng thông báo', async () => {
    const wrongPassword = await login(ADMIN.email, 'sai-mat-khau');
    const unknownEmail = await login('khongco@test.dezon.vn', ADMIN.password);
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual({ statusCode: 401, message: INVALID_CREDENTIALS_MESSAGE });
    expect(unknownEmail.json()).toEqual(wrongPassword.json());
    expect(refreshCookie(wrongPassword)).toBeUndefined();
  });

  it('tài khoản bị khóa không đăng nhập được (cùng thông báo)', async () => {
    const res = await login(INACTIVE.email, INACTIVE.password);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ statusCode: 401, message: INVALID_CREDENTIALS_MESSAGE });
  });

  it('body sai => 400 kèm danh sách lỗi', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'abc' } });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ statusCode: number; message: string; errors: { path: string }[] }>();
    expect(body.statusCode).toBe(400);
    expect(body.errors.map((e) => e.path)).toEqual(expect.arrayContaining(['email', 'password']));
  });
});

describe('xác thực và phân quyền', () => {
  it('không có token => 401 ở /auth/me; token hợp lệ => AuthUser', async () => {
    const none = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(none.statusCode).toBe(401);
    expect(none.json()).toMatchObject({ statusCode: 401 });

    const { body } = await loginOk(ADMIN.email, ADMIN.password);
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(body.accessToken) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual(body.user);
  });

  it('token rác hoặc alg=none bị từ chối', async () => {
    const garbage = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer('abc.def.ghi') });
    expect(garbage.statusCode).toBe(401);

    const { body } = await loginOk(ADMIN.email, ADMIN.password);
    const [, payload] = body.accessToken.split('.');
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const unsigned = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearer(`${header}.${payload}.`),
    });
    expect(unsigned.statusCode).toBe(401);
  });

  it('agent gọi GET /users => 403', async () => {
    const { body } = await loginOk(AGENT.email, AGENT.password);
    const res = await app.inject({ method: 'GET', url: '/users', headers: bearer(body.accessToken) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ statusCode: 403, message: expect.any(String) });
  });

  it('admin gọi GET /users => 200, không có password hash', async () => {
    const { body } = await loginOk(ADMIN.email, ADMIN.password);
    const res = await app.inject({ method: 'GET', url: '/users', headers: bearer(body.accessToken) });
    expect(res.statusCode).toBe(200);
    const list = res.json<Record<string, unknown>[]>();
    expect(list.map((u) => u.email)).toEqual(
      expect.arrayContaining([ADMIN.email, AGENT.email, INACTIVE.email]),
    );
    for (const user of list) {
      expect(Object.keys(user).sort()).toEqual(['createdAt', 'email', 'id', 'isActive', 'name', 'role']);
    }
    expect(res.body).not.toMatch(/argon2|password/i);
  });
});

describe('refresh token', () => {
  it('refresh bằng cookie => access token mới và xoay vòng cookie', async () => {
    const { body, refreshToken } = await loginOk(ADMIN.email, ADMIN.password);
    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { [REFRESH_TOKEN_COOKIE]: refreshToken },
    });
    expect(res.statusCode).toBe(200);
    const refreshed = res.json<LoginResponse>();
    expect(refreshed.accessToken).not.toBe(body.accessToken);
    expect(refreshed.user).toEqual(body.user);
    const rotated = refreshCookie(res);
    expect(rotated?.value).toBeTruthy();
    expect(rotated?.value).not.toBe(refreshToken);

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(refreshed.accessToken) });
    expect(me.statusCode).toBe(200);
  });

  it('refresh bằng body JSON (client không phải trình duyệt)', async () => {
    const { refreshToken } = await loginOk(AGENT.email, AGENT.password);
    const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
    expect(res.statusCode).toBe(200);
    expect(res.json<LoginResponse>().user.role).toBe('agent');
  });

  it('không có refresh token => 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/refresh' });
    expect(res.statusCode).toBe(401);
  });

  it('access token không dùng được làm refresh token', async () => {
    const { body } = await loginOk(ADMIN.email, ADMIN.password);
    const viaCookie = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { [REFRESH_TOKEN_COOKIE]: body.accessToken },
    });
    expect(viaCookie.statusCode).toBe(401);
    const viaBody = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: body.accessToken },
    });
    expect(viaBody.statusCode).toBe(401);
  });

  it('refresh token không hợp lệ => 401 và xóa cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { [REFRESH_TOKEN_COOKIE]: 'rac.rac.rac' },
    });
    expect(res.statusCode).toBe(401);
    expect(refreshCookie(res)).toMatchObject({ value: '' });
  });

  it('lỗi DB tạm thời khi refresh => 500 nhưng KHÔNG xóa cookie', async () => {
    const { refreshToken } = await loginOk(ADMIN.email, ADMIN.password);
    const spy = vi
      .spyOn(app.get(AuthService), 'findActiveUser')
      .mockRejectedValueOnce(new Error('connection terminated'));
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        cookies: { [REFRESH_TOKEN_COOKIE]: refreshToken },
      });
      expect(res.statusCode).toBe(500);
      expect(refreshCookie(res)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('refresh token không dùng được làm access token', async () => {
    const { refreshToken } = await loginOk(ADMIN.email, ADMIN.password);
    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(refreshToken) });
    expect(res.statusCode).toBe(401);
  });

  it('logout xóa cookie refresh', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/logout' });
    expect(res.statusCode).toBe(204);
    const cleared = refreshCookie(res);
    expect(cleared).toMatchObject({ value: '', path: '/auth' });
    expect(cleared?.expires?.getTime()).toBeLessThan(Date.now());
  });
});

describe('khóa tài khoản', () => {
  it('user bị khóa sau khi đăng nhập: access token và refresh token đều bị từ chối', async () => {
    const { body, refreshToken } = await loginOk(AGENT.email, AGENT.password);
    const { db, close } = createDb(infra.databaseUrl, { max: 1 });
    try {
      await db.update(users).set({ isActive: false }).where(eq(users.email, AGENT.email));
      const me = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(body.accessToken) });
      expect(me.statusCode).toBe(401);
      const refresh = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
      expect(refresh.statusCode).toBe(401);
    } finally {
      await db.update(users).set({ isActive: true }).where(eq(users.email, AGENT.email));
      await close();
    }
  });
});
