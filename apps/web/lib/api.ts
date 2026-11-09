import {
  authUserSchema,
  loginResponseSchema,
  publicConfigSchema,
  type AuthUser,
  type LoginRequest,
  type LoginResponse,
  type PublicConfig,
} from '@dezon/shared';
import type { z } from 'zod';

/** Lỗi trả về từ API (status = 0 khi không kết nối được máy chủ). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type SessionListener = (user: AuthUser | null) => void;

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Gắn Bearer + tự refresh khi 401. Mặc định true. */
  auth?: boolean;
  signal?: AbortSignal;
}

export interface ApiClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
}

const NETWORK_ERROR = 'Không kết nối được máy chủ. Vui lòng thử lại.';
export const LOGIN_FAILED = 'Email hoặc mật khẩu không đúng';

const FALLBACK_MESSAGES: Record<number, string> = {
  400: 'Dữ liệu gửi lên không hợp lệ.',
  401: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
  403: 'Bạn không có quyền thực hiện thao tác này.',
  404: 'Không tìm thấy dữ liệu.',
  413: 'Tệp quá lớn.',
  415: 'Định dạng tệp không được hỗ trợ.',
  429: 'Bạn thao tác quá nhanh, vui lòng thử lại sau ít phút.',
};

// Câu mặc định tiếng Anh của HTTP/NestJS: thay bằng câu tiếng Việt.
const GENERIC_MESSAGES = new Set([
  'Unauthorized',
  'Forbidden',
  'Not Found',
  'Bad Request',
  'Too Many Requests',
  'Internal server error',
  'Internal Server Error',
]);

function fallbackMessage(status: number): string {
  return (
    FALLBACK_MESSAGES[status] ??
    (status >= 500 ? 'Máy chủ đang gặp sự cố. Vui lòng thử lại sau.' : 'Có lỗi xảy ra.')
  );
}

/** Lấy thông báo lỗi từ body kiểu NestJS {statusCode, message}. */
export function errorMessageFrom(status: number, body: unknown): string {
  if (body && typeof body === 'object' && 'message' in body) {
    const raw = (body as { message: unknown }).message;
    const msg = Array.isArray(raw) ? raw.filter((m) => typeof m === 'string').join('. ') : raw;
    if (typeof msg === 'string' && msg.trim() && !GENERIC_MESSAGES.has(msg.trim())) return msg.trim();
  }
  return fallbackMessage(status);
}

async function readBody(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function createApiClient({ baseUrl, fetch: fetchImpl }: ApiClientOptions) {
  const base = baseUrl.replace(/\/+$/, '');
  const doFetch: typeof fetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  // Access token chỉ giữ trong bộ nhớ (không localStorage); refresh token nằm ở cookie httpOnly.
  let accessToken: string | null = null;
  let refreshing: Promise<string | null> | null = null;
  const listeners = new Set<SessionListener>();

  function setSession(session: LoginResponse | null): void {
    accessToken = session?.accessToken ?? null;
    const user = session?.user ?? null;
    for (const listener of listeners) listener(user);
  }

  async function send(path: string, opts: RequestOptions, token: string | null): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    // FormData (upload tệp): để trình duyệt tự đặt Content-Type kèm boundary.
    const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData;
    if (opts.body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      return await doFetch(`${base}${path}`, {
        method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
        headers,
        body:
          opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
        credentials: 'include',
        signal: opts.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new ApiError(0, NETWORK_ERROR);
    }
  }

  /**
   * Chỉ hết phiên khi API trả 401/403. Lỗi mạng/5xx là tạm thời: ném ApiError và giữ nguyên
   * phiên hiện tại (cookie refresh vẫn còn, lần sau thử lại được).
   */
  async function doRefresh(): Promise<string | null> {
    const res = await send('/auth/refresh', { method: 'POST', auth: false }, null);
    const body = await readBody(res);
    if (res.status === 401 || res.status === 403) {
      setSession(null);
      return null;
    }
    if (!res.ok) throw new ApiError(res.status, errorMessageFrom(res.status, body), body);
    const parsed = loginResponseSchema.safeParse(body);
    if (!parsed.success) {
      setSession(null);
      return null;
    }
    setSession(parsed.data);
    return parsed.data.accessToken;
  }

  /** Gọi /auth/refresh; các lời gọi đồng thời dùng chung một request. */
  function refreshToken(): Promise<string | null> {
    refreshing ??= doRefresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function request<T = unknown>(
    path: string,
    opts: RequestOptions = {},
    schema?: z.ZodType<T>,
  ): Promise<T> {
    const useAuth = opts.auth ?? true;
    let token: string | null = null;
    if (useAuth) {
      // Đang refresh dở (vd. khôi phục phiên lúc mở app) thì chờ xong rồi mới gửi.
      token = refreshing ? await refreshing : accessToken;
      if (!token) token = await refreshToken();
      if (!token) throw new ApiError(401, fallbackMessage(401));
    }

    let res = await send(path, opts, token);
    if (res.status === 401 && useAuth) {
      // Nếu request khác đã refresh xong trong lúc chờ thì dùng luôn token mới.
      const fresh = accessToken && accessToken !== token ? accessToken : await refreshToken();
      if (!fresh) throw new ApiError(401, fallbackMessage(401));
      res = await send(path, opts, fresh);
    }

    const body = await readBody(res);
    if (!res.ok) throw new ApiError(res.status, errorMessageFrom(res.status, body), body);
    return schema ? schema.parse(body) : (body as T);
  }

  return {
    request,

    /** Khôi phục phiên từ cookie refresh (gọi khi mở app). true nếu còn phiên. */
    async restoreSession(): Promise<boolean> {
      try {
        return (await refreshToken()) !== null;
      } catch {
        // Lỗi tạm thời lúc mở app: hiển thị như chưa đăng nhập nhưng KHÔNG xóa cookie.
        if (!accessToken) setSession(null);
        return false;
      }
    },

    async login(input: LoginRequest): Promise<AuthUser> {
      try {
        const session = await request(
          '/auth/login',
          { method: 'POST', body: input, auth: false },
          loginResponseSchema,
        );
        setSession(session);
        return session.user;
      } catch (err) {
        // 401 không kèm thông báo riêng của API: báo sai thông tin đăng nhập.
        if (err instanceof ApiError && err.status === 401 && err.message === fallbackMessage(401)) {
          throw new ApiError(401, LOGIN_FAILED, err.body);
        }
        throw err;
      }
    },

    async logout(): Promise<void> {
      const token = accessToken;
      setSession(null);
      try {
        await send('/auth/logout', { method: 'POST' }, token);
      } catch {
        // Bỏ qua: phía client đã đăng xuất.
      }
    },

    me(): Promise<AuthUser> {
      return request('/auth/me', {}, authUserSchema);
    },

    getConfig(): Promise<PublicConfig> {
      return request('/config', { auth: false }, publicConfigSchema);
    },

    getAccessToken(): string | null {
      return accessToken;
    },

    /** Xin access token mới bằng cookie refresh (vd. socket bị từ chối vì token hết hạn). null = hết phiên. */
    refreshAccessToken(): Promise<string | null> {
      return refreshToken();
    },

    /** Lắng nghe thay đổi phiên (đăng nhập, refresh, hết phiên, đăng xuất). */
    subscribe(listener: SessionListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

/** Client dùng chung cho toàn app (trình duyệt). */
export const api = createApiClient({ baseUrl: API_URL });
