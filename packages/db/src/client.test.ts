import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DbHandle } from './client';

// Không cần Postgres: pool chỉ kết nối khi có truy vấn.
const URL = 'postgres://dezon:dezon@127.0.0.1:1/khong_ton_tai';

describe('createDb — lỗi kết nối rảnh trong pool', () => {
  let handle: DbHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    vi.restoreAllMocks();
  });

  it('pool luôn có listener error: emit không ném (process không chết)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    handle = createDb(URL);
    expect(handle.pool.listenerCount('error')).toBe(1);
    expect(() => handle!.pool.emit('error', new Error('terminating connection'))).not.toThrow();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('onError được gọi thay cho log mặc định', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onError = vi.fn();
    handle = createDb(URL, { onError });
    handle.pool.emit('error', new Error('x'));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'x' }));
    expect(spy).not.toHaveBeenCalled();
  });

  it('có listener khác (API gắn logger) thì không ghi log mặc định', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    handle = createDb(URL);
    const other = vi.fn();
    handle.pool.on('error', other);
    handle.pool.emit('error', new Error('y'));
    expect(other).toHaveBeenCalledOnce();
    expect(spy).not.toHaveBeenCalled();
  });
});
