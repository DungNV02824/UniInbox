import { describe, expect, it, vi } from 'vitest';
import { ApiError, LOGIN_FAILED, createApiClient, errorMessageFrom } from './api';

const BASE = 'http://api.test';
const user = { id: 'u1', email: 'admin@dezon.vn', name: 'Admin', role: 'admin' as const };

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function session(token: string) {
  return { accessToken: token, accessTokenExpiresIn: 900, user };
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** fetch giả: ghi lại mọi lời gọi, trả lời theo handler. */
function mockFetch(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const authHeader = (init: RequestInit) => (init.headers as Record<string, string>).Authorization;
const countPath = (calls: { url: string }[], path: string) =>
  calls.filter((c) => c.url === BASE + path).length;

describe('createApiClient', () => {
  it('đăng nhập lưu access token trong bộ nhớ và gắn Bearer cho request sau', async () => {
    const { fetch, calls } = mockFetch((url) => {
      if (url.endsWith('/auth/login')) return json(200, session('t1'));
      if (url.endsWith('/auth/me')) return json(200, user);
      return json(404);
    });
    const api = createApiClient({ baseUrl: BASE + '/', fetch });

    await expect(api.login({ email: 'admin@dezon.vn', password: 'x' })).resolves.toEqual(user);
    expect(api.getAccessToken()).toBe('t1');
    await api.me();

    const me = calls.find((c) => c.url === `${BASE}/auth/me`)!;
    expect(authHeader(me.init)).toBe('Bearer t1');
    expect(me.init.credentials).toBe('include');
    expect(calls.every((c) => c.init.credentials === 'include')).toBe(true);
  });

  it('401 -> refresh một lần rồi gửi lại với token mới', async () => {
    const { fetch, calls } = mockFetch((url, init) => {
      if (url.endsWith('/auth/login')) return json(200, session('old'));
      if (url.endsWith('/auth/refresh')) return json(200, session('new'));
      if (url.endsWith('/auth/me')) return authHeader(init) === 'Bearer new' ? json(200, user) : json(401);
      return json(404);
    });
    const api = createApiClient({ baseUrl: BASE, fetch });
    await api.login({ email: 'admin@dezon.vn', password: 'x' });

    await expect(api.me()).resolves.toEqual(user);
    expect(countPath(calls, '/auth/refresh')).toBe(1);
    expect(countPath(calls, '/auth/me')).toBe(2);
    expect(api.getAccessToken()).toBe('new');
  });

  it('nhiều request cùng gặp 401 chỉ gọi /auth/refresh đúng một lần', async () => {
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((r) => (releaseRefresh = r));
    const { fetch, calls } = mockFetch(async (url, init) => {
      if (url.endsWith('/auth/login')) return json(200, session('old'));
      if (url.endsWith('/auth/refresh')) {
        await refreshGate;
        return json(200, session('new'));
      }
      if (url.endsWith('/auth/me')) return authHeader(init) === 'Bearer new' ? json(200, user) : json(401);
      return json(404);
    });
    const api = createApiClient({ baseUrl: BASE, fetch });
    await api.login({ email: 'admin@dezon.vn', password: 'x' });

    const pending = Promise.all([api.me(), api.me(), api.me()]);
    await vi.waitFor(() => expect(countPath(calls, '/auth/refresh')).toBe(1));
    releaseRefresh();

    await expect(pending).resolves.toEqual([user, user, user]);
    expect(countPath(calls, '/auth/refresh')).toBe(1);
    expect(countPath(calls, '/auth/me')).toBe(6);
  });

  it('request gặp 401 sau khi request khác đã refresh xong thì dùng luôn token mới', async () => {
    let refreshCount = 0;
    let releaseSecondMe!: () => void;
    const secondMeGate = new Promise<void>((r) => (releaseSecondMe = r));
    let meCalls = 0;
    const { fetch } = mockFetch(async (url, init) => {
      if (url.endsWith('/auth/login')) return json(200, session('old'));
      if (url.endsWith('/auth/refresh')) {
        refreshCount += 1;
        return json(200, session(`new${refreshCount}`));
      }
      if (url.endsWith('/auth/me')) {
        meCalls += 1;
        // Lời gọi thứ 2 (token cũ) bị giữ lại tới khi lời gọi 1 refresh xong.
        if (meCalls === 2) await secondMeGate;
        return authHeader(init) === 'Bearer old' ? json(401) : json(200, user);
      }
      return json(404);
    });
    const api = createApiClient({ baseUrl: BASE, fetch });
    await api.login({ email: 'admin@dezon.vn', password: 'x' });

    const first = api.me();
    const second = api.me();
    await first;
    releaseSecondMe();
    await second;
    expect(refreshCount).toBe(1);
  });

  it('refresh thất bại -> đăng xuất (báo listener null) và ném ApiError 401', async () => {
    const { fetch } = mockFetch((url) => {
      if (url.endsWith('/auth/login')) return json(200, session('old'));
      if (url.endsWith('/auth/refresh')) return json(401, { statusCode: 401, message: 'Unauthorized' });
      return json(401);
    });
    const api = createApiClient({ baseUrl: BASE, fetch });
    const events: unknown[] = [];
    api.subscribe((u) => events.push(u));
    await api.login({ email: 'admin@dezon.vn', password: 'x' });

    const err = await api.me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(api.getAccessToken()).toBeNull();
    expect(events).toEqual([user, null]);
  });

  it('refresh gặp 5xx hoặc lỗi mạng -> giữ phiên, ném lỗi tạm thời (không phải 401)', async () => {
    let refreshStatus: number | 'network' = 503;
    const { fetch } = mockFetch((url) => {
      if (url.endsWith('/auth/login')) return json(200, session('old'));
      if (url.endsWith('/auth/refresh')) {
        if (refreshStatus === 'network') throw new TypeError('Failed to fetch');
        return json(refreshStatus, { statusCode: refreshStatus, message: 'Internal server error' });
      }
      return json(401);
    });
    const api = createApiClient({ baseUrl: BASE, fetch });
    const events: unknown[] = [];
    api.subscribe((u) => events.push(u));
    await api.login({ email: 'admin@dezon.vn', password: 'x' });

    await expect(api.me()).rejects.toMatchObject({ status: 503 });
    refreshStatus = 'network';
    await expect(api.me()).rejects.toMatchObject({ status: 0 });
    expect(api.getAccessToken()).toBe('old');
    expect(events).toEqual([user]);
  });

  it('restoreSession gặp 5xx -> false, báo chưa đăng nhập', async () => {
    const { fetch } = mockFetch(() => json(500));
    const api = createApiClient({ baseUrl: BASE, fetch });
    const events: unknown[] = [];
    api.subscribe((u) => events.push(u));
    await expect(api.restoreSession()).resolves.toBe(false);
    expect(events).toEqual([null]);
  });

  it('restoreSession: các lời gọi đồng thời (React StrictMode) dùng chung một refresh', async () => {
    const { fetch, calls } = mockFetch((url) =>
      url.endsWith('/auth/refresh') ? json(200, session('t')) : json(404),
    );
    const api = createApiClient({ baseUrl: BASE, fetch });
    const results = await Promise.all([api.restoreSession(), api.restoreSession()]);
    expect(results).toEqual([true, true]);
    expect(countPath(calls, '/auth/refresh')).toBe(1);
    expect(api.getAccessToken()).toBe('t');
  });

  it('restoreSession không có cookie -> false, request cần auth ném 401 mà không gọi API', async () => {
    const { fetch, calls } = mockFetch(() => json(401));
    const api = createApiClient({ baseUrl: BASE, fetch });
    await expect(api.restoreSession()).resolves.toBe(false);
    calls.length = 0;
    await expect(api.me()).rejects.toMatchObject({ status: 401 });
    expect(countPath(calls, '/auth/me')).toBe(0);
  });

  it('login sai: dùng thông báo của API nếu có, mặc định "Email hoặc mật khẩu không đúng"', async () => {
    const withMessage = createApiClient({
      baseUrl: BASE,
      fetch: mockFetch(() => json(401, { statusCode: 401, message: 'Tài khoản đã bị khóa' })).fetch,
    });
    await expect(withMessage.login({ email: 'a@dezon.vn', password: 'x' })).rejects.toMatchObject({
      status: 401,
      message: 'Tài khoản đã bị khóa',
    });

    const generic = createApiClient({
      baseUrl: BASE,
      fetch: mockFetch(() => json(401, { statusCode: 401, message: 'Unauthorized' })).fetch,
    });
    const calls = generic.login({ email: 'a@dezon.vn', password: 'x' });
    await expect(calls).rejects.toMatchObject({ status: 401, message: LOGIN_FAILED });
  });

  it('body FormData (upload): gửi nguyên FormData, không đặt Content-Type JSON', async () => {
    const { fetch, calls } = mockFetch((url) => {
      if (url.endsWith('/auth/login')) return json(200, session('t1'));
      return json(201, { storageKey: 'uploads/a.jpg' });
    });
    const api = createApiClient({ baseUrl: BASE, fetch });
    await api.login({ email: 'admin@dezon.vn', password: 'x' });
    const form = new FormData();
    form.append('file', new Blob(['x']), 'a.jpg');
    await api.request('/media/uploads', { method: 'POST', body: form });
    const upload = calls.find((c) => c.url.endsWith('/media/uploads'))!;
    expect(upload.init.body).toBe(form);
    expect((upload.init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    expect(authHeader(upload.init)).toBe('Bearer t1');
  });

  it('refreshAccessToken: lấy token mới và báo listener', async () => {
    const { fetch } = mockFetch((url) =>
      url.endsWith('/auth/refresh') ? json(200, session('fresh')) : json(404),
    );
    const api = createApiClient({ baseUrl: BASE, fetch });
    const events: unknown[] = [];
    api.subscribe((u) => events.push(u));
    await expect(api.refreshAccessToken()).resolves.toBe('fresh');
    expect(events).toEqual([user]);
  });

  it('lỗi mạng -> ApiError status 0', async () => {
    const api = createApiClient({
      baseUrl: BASE,
      fetch: (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch,
    });
    await expect(api.getConfig()).rejects.toMatchObject({ status: 0 });
  });

  it('getConfig không gửi Authorization và validate bằng schema', async () => {
    const { fetch, calls } = mockFetch(() =>
      json(200, { featureAiEnabled: false, zaloPersonalEnabled: true }),
    );
    const api = createApiClient({ baseUrl: BASE, fetch });
    await expect(api.getConfig()).resolves.toEqual({ featureAiEnabled: false, zaloPersonalEnabled: true });
    expect(authHeader(calls[0]!.init)).toBeUndefined();
  });
});

describe('errorMessageFrom', () => {
  it('lấy message chuỗi hoặc mảng từ body NestJS', () => {
    expect(errorMessageFrom(400, { message: ['Email không hợp lệ', 'Thiếu mật khẩu'] })).toBe(
      'Email không hợp lệ. Thiếu mật khẩu',
    );
    expect(errorMessageFrom(429, { message: 'Too Many Requests' })).toMatch(/quá nhanh/);
    expect(errorMessageFrom(503, undefined)).toMatch(/sự cố/);
  });
});
