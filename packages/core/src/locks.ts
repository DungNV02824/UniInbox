// Khoá phân tán (single-flight giữa nhiều process api/worker), ví dụ làm mới token Zalo OA.
// Cài đặt Redis ở đây chỉ cần một client "giống ioredis" (api và worker truyền ioredis của mình vào),
// nên core không phụ thuộc ioredis.
import { randomUUID } from 'node:crypto';

export interface DistributedLock {
  /**
   * Chạy `fn` khi giữ khoá `key`. Khoá đang bị giữ => chờ (poll) tới khi lấy được hoặc quá `waitMs`
   * (mặc định = ttlMs + 5s) thì ném LockTimeoutError. Khoá tự hết hạn sau `ttlMs` (process chết giữa chừng).
   * Luôn nhả khoá sau khi `fn` xong (kể cả khi ném lỗi); chỉ nhả khoá do chính mình giữ.
   */
  withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>, opts?: { waitMs?: number }): Promise<T>;
}

export class LockTimeoutError extends Error {
  override readonly name = 'LockTimeoutError';
  constructor(readonly key: string) {
    super(`Không lấy được khoá ${key} (đang bị giữ quá lâu)`);
  }
}

/** Tập con của ioredis mà createRedisLock dùng. */
export interface RedisLockClient {
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<'OK' | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/** Chỉ xoá khoá nếu giá trị còn là token của mình (không nhả nhầm khoá của process khác). */
const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export interface LockPollOptions {
  /** Khoảng chờ giữa hai lần thử lấy khoá. Mặc định 100ms. */
  retryDelayMs?: number;
  /** Tiền tố khoá trong Redis. Mặc định 'lock:'. */
  prefix?: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function runWithLock<T>(
  key: string,
  ttlMs: number,
  waitMs: number,
  retryDelayMs: number,
  acquire: () => Promise<boolean>,
  release: () => Promise<void>,
  fn: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + waitMs;
  while (!(await acquire())) {
    if (Date.now() >= deadline) throw new LockTimeoutError(key);
    await sleep(retryDelayMs);
  }
  try {
    return await fn();
  } finally {
    await release().catch(() => undefined); // khoá vẫn tự hết hạn theo TTL
  }
}

/** Khoá Redis: SET key token PX ttl NX; nhả bằng Lua so token. */
export function createRedisLock(client: RedisLockClient, opts: LockPollOptions = {}): DistributedLock {
  const retryDelayMs = opts.retryDelayMs ?? 100;
  const prefix = opts.prefix ?? 'lock:';
  return {
    withLock(key, ttlMs, fn, o) {
      const fullKey = prefix + key;
      const token = randomUUID();
      return runWithLock(
        fullKey,
        ttlMs,
        o?.waitMs ?? ttlMs + 5000,
        retryDelayMs,
        async () => (await client.set(fullKey, token, 'PX', ttlMs, 'NX')) === 'OK',
        async () => {
          await client.eval(RELEASE_SCRIPT, 1, fullKey, token);
        },
        fn,
      );
    },
  };
}

/** Khoá trong bộ nhớ (một process) — cho test và môi trường không có Redis. */
export function createInMemoryLock(opts: LockPollOptions = {}): DistributedLock {
  const retryDelayMs = opts.retryDelayMs ?? 10;
  const held = new Map<string, { token: string; expiresAt: number }>();
  return {
    withLock(key, ttlMs, fn, o) {
      const token = randomUUID();
      return runWithLock(
        key,
        ttlMs,
        o?.waitMs ?? ttlMs + 5000,
        retryDelayMs,
        () => {
          const cur = held.get(key);
          if (cur && cur.expiresAt > Date.now()) return Promise.resolve(false);
          held.set(key, { token, expiresAt: Date.now() + ttlMs });
          return Promise.resolve(true);
        },
        () => {
          if (held.get(key)?.token === token) held.delete(key);
          return Promise.resolve();
        },
        fn,
      );
    },
  };
}
