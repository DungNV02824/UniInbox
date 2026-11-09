import { describe, expect, it } from 'vitest';
import { createInMemoryLock, createRedisLock, LockTimeoutError, type RedisLockClient } from './locks';

/** Redis giả đủ cho SET NX PX + script nhả khoá. */
function fakeRedis(): RedisLockClient & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    set(key, value) {
      if (store.has(key)) return Promise.resolve(null);
      store.set(key, value);
      return Promise.resolve('OK');
    },
    eval(_script, _n, key, token) {
      if (store.get(String(key)) === String(token)) {
        store.delete(String(key));
        return Promise.resolve(1);
      }
      return Promise.resolve(0);
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.each([
  ['redis', () => createRedisLock(fakeRedis(), { retryDelayMs: 5 })],
  ['memory', () => createInMemoryLock({ retryDelayMs: 5 })],
])('DistributedLock (%s)', (_name, make) => {
  it('chạy tuần tự các lời gọi cùng khoá', async () => {
    const lock = make();
    const order: string[] = [];
    const task = (id: string) =>
      lock.withLock('k', 1000, async () => {
        order.push(`start-${id}`);
        await sleep(20);
        order.push(`end-${id}`);
        return id;
      });
    const results = await Promise.all([task('a'), task('b')]);
    expect(results).toEqual(['a', 'b']);
    expect(order).toEqual(['start-a', 'end-a', 'start-b', 'end-b']);
  });

  it('nhả khoá cả khi fn ném lỗi', async () => {
    const lock = make();
    await expect(lock.withLock('k', 1000, () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(lock.withLock('k', 1000, () => Promise.resolve(1))).resolves.toBe(1);
  });

  it('ném LockTimeoutError khi chờ quá waitMs', async () => {
    const lock = make();
    const holder = lock.withLock('k', 1000, () => sleep(100));
    await sleep(5);
    await expect(lock.withLock('k', 1000, () => Promise.resolve(1), { waitMs: 20 })).rejects.toBeInstanceOf(
      LockTimeoutError,
    );
    await holder;
  });
});
