import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';
import type { AppConfig } from '../config';

/** Không bao giờ ghi các trường này ra log (phòng khi có code log nhầm object chứa chúng). */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  'refreshToken',
  'accessToken',
  '*.password',
  '*.refreshToken',
  '*.accessToken',
];

/**
 * Tham số query có thể chứa bí mật: callback OAuth Facebook (code/state), token Graph,
 * và hub.verify_token khi Meta xác minh webhook (GET /webhooks/messenger) — kể cả dạng mã hoá `%2E`.
 */
const SECRET_QUERY_PARAMS =
  /([?&](?:code|state|access_token|fb_exchange_token|client_secret|hub(?:\.|%2E)verify_token)=)[^&#]*/gi;

/** Che giá trị các tham số query nhạy cảm trước khi ghi log. */
export function redactUrl(url: string): string {
  return url.replace(SECRET_QUERY_PARAMS, '$1[REDACTED]');
}

type RawRequest = IncomingMessage & { id?: unknown; originalUrl?: string };

/** middie (middleware của Fastify) có thể cắt prefix khỏi req.url => ưu tiên originalUrl. */
const pathOf = (req: RawRequest) => (req.originalUrl ?? req.url ?? '').split('?')[0];

export function buildLoggerParams(config: AppConfig): Params {
  return {
    pinoHttp: {
      level: config.LOG_LEVEL,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      // Request id do Fastify sinh (genReqId trong app.factory).
      genReqId: (req: RawRequest) => String(req.id ?? ''),
      // Log gọn: không ghi header/body (tránh lộ token, nội dung tin nhắn).
      serializers: {
        req: (req: { id: unknown; method: string; url: string; remoteAddress?: string }) => ({
          id: req.id,
          method: req.method,
          url: redactUrl(req.url),
          remoteAddress: req.remoteAddress,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      // Docker/Caddy gọi /health liên tục => không log.
      autoLogging: { ignore: (req: RawRequest) => pathOf(req) === '/health' },
      customLogLevel: (_req: IncomingMessage, res: ServerResponse, err?: Error) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      // JSON thuần ở mọi môi trường; chỉ dev mới in đẹp (pino-pretty là devDependency).
      transport:
        config.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'SYS:HH:MM:ss.l' } }
          : undefined,
    },
  };
}
