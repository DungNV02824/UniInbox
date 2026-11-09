import pino, { type Logger } from 'pino';

export type { Logger };

export interface LoggerOptions {
  level: string;
  /** In đẹp (pino-pretty) — chỉ bật khi NODE_ENV=development. */
  pretty: boolean;
}

export function createLogger({ level, pretty }: LoggerOptions): Logger {
  return pino({
    name: 'worker',
    level,
    // Phòng hờ: không bao giờ in secret dù có lỡ đưa vào log.
    redact: {
      paths: ['password', '*.password', 'token', '*.token', 'accessToken', '*.accessToken', 'credentials'],
      censor: '[redacted]',
    },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
}

/** Logger im lặng — dùng cho test. */
export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}
