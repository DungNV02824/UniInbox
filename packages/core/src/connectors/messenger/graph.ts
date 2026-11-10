// Gọi Graph API tối giản: token đặt ở header Authorization (không nằm trong URL/log), timeout 15s.
import type { MessengerConfig } from './config';

export const GRAPH_TIMEOUT_MS = 15_000;

/** Phần `error` của phản hồi Graph (docs/research/messenger-platform.md §7). */
export interface GraphErrorInfo {
  code?: number;
  subcode?: number;
  type?: string;
  /** Chỉ dùng để nhận diện (vd. "outside of allowed window"); KHÔNG đưa nguyên văn cho người dùng. */
  message?: string;
}

export type GraphResponse =
  | { ok: true; status: number; data: Record<string, unknown> }
  | { ok: false; status: number; error: GraphErrorInfo };

/** Lỗi mạng / timeout trước khi có phản hồi HTTP. */
export class GraphNetworkError extends Error {
  override readonly name = 'GraphNetworkError';
  constructor(readonly timeout: boolean) {
    super(timeout ? 'Graph API quá thời gian chờ' : 'Không kết nối được Graph API');
  }
}

export interface GraphRequest {
  method: 'GET' | 'POST' | 'DELETE';
  /** Đường dẫn sau version, vd. `me` hoặc `123/messages`. */
  path: string;
  /** Rỗng = không gửi header Authorization (vd. oauth/access_token dùng client_secret). */
  token: string;
  query?: Record<string, string>;
  /** JSON (object) hoặc FormData (multipart). */
  body?: Record<string, unknown> | FormData;
  /** Ghi đè GRAPH_TIMEOUT_MS (vd. sender_action chỉ chờ ngắn). */
  timeoutMs?: number;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function parseError(json: unknown): GraphErrorInfo {
  const err = json && typeof json === 'object' ? (json as { error?: unknown }).error : undefined;
  if (!err || typeof err !== 'object') return {};
  const e = err as Record<string, unknown>;
  return {
    code: toNumber(e.code),
    subcode: toNumber(e.error_subcode),
    type: typeof e.type === 'string' ? e.type : undefined,
    message: typeof e.message === 'string' ? e.message : undefined,
  };
}

export function graphUrl(config: Pick<MessengerConfig, 'graphBaseUrl' | 'graphVersion'>, path: string): URL {
  const base = config.graphBaseUrl.replace(/\/+$/, '');
  const version = config.graphVersion.replace(/^\/+|\/+$/g, '');
  return new URL(`${base}/${version}/${path.replace(/^\/+/, '')}`);
}

function isTimeout(err: unknown): boolean {
  const name = err && typeof err === 'object' ? (err as { name?: unknown }).name : undefined;
  return name === 'TimeoutError' || name === 'AbortError';
}

export async function graphRequest(config: MessengerConfig, req: GraphRequest): Promise<GraphResponse> {
  const url = graphUrl(config, req.path);
  for (const [key, value] of Object.entries(req.query ?? {})) url.searchParams.set(key, value);

  const headers: Record<string, string> = req.token ? { authorization: `Bearer ${req.token}` } : {};
  let body: string | FormData | undefined;
  if (req.body instanceof FormData) {
    body = req.body; // fetch tự đặt content-type multipart kèm boundary
  } else if (req.body) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(req.body);
  }

  const doFetch = config.fetch ?? globalThis.fetch;
  let res: Response;
  let text: string;
  try {
    res = await doFetch(url, {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(req.timeoutMs ?? GRAPH_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    throw new GraphNetworkError(isTimeout(err));
  }

  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  const hasError = json !== null && typeof json === 'object' && 'error' in json;
  if (!res.ok || hasError) return { ok: false, status: res.status, error: parseError(json) };
  const data = json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
  return { ok: true, status: res.status, data };
}

/** Chuỗi mã lỗi ngắn để ghi vào thông điệp/platformCode, vd. "10/2018278". */
export function graphErrorCode(status: number, error: GraphErrorInfo): string {
  if (error.code === undefined) return `HTTP ${status}`;
  return error.subcode !== undefined ? `${error.code}/${error.subcode}` : String(error.code);
}
