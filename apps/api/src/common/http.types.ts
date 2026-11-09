// Kiểu tối thiểu cho request/reply của Fastify (package `fastify` không phải dependency trực tiếp).
import type { IncomingHttpHeaders } from 'node:http';
import type { AuthUser } from '@dezon/shared';

export interface CookieOptions {
  path?: string;
  domain?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'lax' | 'strict' | 'none' | boolean;
  /** Tính bằng giây */
  maxAge?: number;
  expires?: Date;
}

export interface HttpRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  /** Do @fastify/cookie gắn vào */
  cookies?: Record<string, string | undefined>;
  /** Do JwtAuthGuard gắn vào sau khi xác thực */
  user?: AuthUser;
}

export interface HttpReply {
  status(statusCode: number): HttpReply;
  send(payload?: unknown): HttpReply;
  header(name: string, value: string): HttpReply;
  setCookie(name: string, value: string, options?: CookieOptions): HttpReply;
  clearCookie(name: string, options?: CookieOptions): HttpReply;
}
