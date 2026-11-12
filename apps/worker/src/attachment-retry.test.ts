import type { AttachmentRetryDeps, AttachmentRetryResult } from '@dezon/core';
import type { Db } from '@dezon/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ATTACHMENT_RETRY_INTERVAL_MS,
  ATTACHMENT_RETRY_MAX_RUN_MS,
  startAttachmentRetry,
} from './attachment-retry';

const empty: AttachmentRetryResult = {
  candidates: 0,
  messages: 0,
  repaired: 0,
  failed: 0,
  exhausted: 0,
  storageErrors: 0,
  superseded: 0,
  stoppedOnStorageError: false,
};
const deps = {} as AttachmentRetryDeps;
const db = {} as Db;
const logger = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() });

afterEach(() => {
  vi.useRealTimers();
});

describe('startAttachmentRetry', () => {
  it('chạy ngay lúc khởi động rồi mỗi 2 phút; chỉ log số lượng', async () => {
    vi.useFakeTimers();
    const log = logger();
    const result = { ...empty, candidates: 2, messages: 2, repaired: 3 };
    const retry = vi.fn(async () => result);
    const loop = startAttachmentRetry(db, deps, log, { retry: retry as never });
    try {
      expect(ATTACHMENT_RETRY_INTERVAL_MS).toBe(120_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(retry).toHaveBeenCalledTimes(1);
      expect(retry).toHaveBeenCalledWith(db, deps, { signal: expect.any(AbortSignal) });
      expect(log.info).toHaveBeenCalledWith(result, expect.any(String));

      await vi.advanceTimersByTimeAsync(ATTACHMENT_RETRY_INTERVAL_MS - 1);
      expect(retry).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(retry).toHaveBeenCalledTimes(2);

      // Không có gì để làm ⇒ chỉ debug.
      retry.mockResolvedValueOnce(empty);
      log.info.mockClear();
      await vi.advanceTimersByTimeAsync(ATTACHMENT_RETRY_INTERVAL_MS);
      expect(log.info).not.toHaveBeenCalled();
      expect(log.debug).toHaveBeenCalledWith({ candidates: 0 }, expect.any(String));
    } finally {
      await loop.stop();
    }
    await vi.advanceTimersByTimeAsync(10 * ATTACHMENT_RETRY_INTERVAL_MS);
    expect(retry).toHaveBeenCalledTimes(3);
  });

  it('không chạy chồng; lỗi chỉ log warn; stop báo hủy và đợi lượt đang chạy', async () => {
    const log = logger();
    let release: (r: AttachmentRetryResult) => void = () => undefined;
    let signal: AbortSignal | undefined;
    const retry = vi.fn(
      (_db: Db, _deps: AttachmentRetryDeps, opts?: { signal?: AbortSignal }) =>
        new Promise<AttachmentRetryResult>((resolve) => {
          signal = opts?.signal;
          release = resolve;
        }),
    );
    const loop = startAttachmentRetry(db, deps, log, { intervalMs: 3_600_000, retry: retry as never });
    // Lượt khởi động đang chạy ⇒ lượt gọi tay bị bỏ qua.
    expect(await loop.run()).toBeNull();
    expect(retry).toHaveBeenCalledTimes(1);

    const stopped = loop.stop();
    expect(signal?.aborted).toBe(true);
    let done = false;
    void stopped.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    release(empty);
    await stopped;
    // Đã dừng ⇒ không chạy nữa.
    expect(await loop.run()).toBeNull();
    expect(retry).toHaveBeenCalledTimes(1);

    const failing = vi.fn(async () => {
      throw new Error('db down');
    });
    const loop2 = startAttachmentRetry(db, deps, log, { intervalMs: 3_600_000, retry: failing as never });
    await loop2.stop();
    expect(log.warn).toHaveBeenCalledWith({ err: 'db down' }, expect.any(String));
  });

  it('lượt treo quá ATTACHMENT_RETRY_MAX_RUN_MS: báo nó dừng, lượt sau vẫn chạy (không kẹt tới khi khởi động lại)', async () => {
    vi.useFakeTimers();
    const log = logger();
    const signals: AbortSignal[] = [];
    let call = 0;
    const retry = vi.fn((_db: Db, _deps: AttachmentRetryDeps, opts?: { signal?: AbortSignal }) => {
      signals.push(opts!.signal!);
      // Lượt đầu treo mãi (vd. lệnh ghi kho không bao giờ trả lời); các lượt sau xong ngay.
      return ++call === 1 ? new Promise<AttachmentRetryResult>(() => undefined) : Promise.resolve(empty);
    });
    const loop = startAttachmentRetry(db, deps, log, { retry: retry as never });
    try {
      expect(ATTACHMENT_RETRY_MAX_RUN_MS).toBeGreaterThan(ATTACHMENT_RETRY_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(0);
      expect(retry).toHaveBeenCalledTimes(1);
      // Còn trong hạn ⇒ các tick bị bỏ qua.
      await vi.advanceTimersByTimeAsync(ATTACHMENT_RETRY_MAX_RUN_MS - 1);
      expect(retry).toHaveBeenCalledTimes(1);
      expect(log.warn).not.toHaveBeenCalled();
      // Tick đầu tiên sau hạn ⇒ lượt treo bị báo hủy, lượt mới chạy.
      await vi.advanceTimersByTimeAsync(ATTACHMENT_RETRY_INTERVAL_MS);
      expect(retry).toHaveBeenCalledTimes(2);
      expect(signals[0]!.aborted).toBe(true);
      expect(signals[1]!.aborted).toBe(false);
      expect(log.warn).toHaveBeenCalledWith({ runningMs: expect.any(Number) }, expect.any(String));
      // Lượt mới xong ⇒ lượt kế tiếp chạy bình thường (lượt treo không giữ chỗ nữa).
      await vi.advanceTimersByTimeAsync(ATTACHMENT_RETRY_INTERVAL_MS);
      expect(retry).toHaveBeenCalledTimes(3);
    } finally {
      await loop.stop(0);
    }
  });

  it('stop không đợi quá maxWaitMs nếu lượt đang chạy treo', async () => {
    const retry = vi.fn(() => new Promise<AttachmentRetryResult>(() => undefined));
    const loop = startAttachmentRetry(db, deps, logger(), { intervalMs: 3_600_000, retry: retry as never });
    await expect(loop.stop(20)).resolves.toBeUndefined();
  });
});
