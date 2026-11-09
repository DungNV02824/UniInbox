import { OutboundNotReadyError, PermanentSendError, TransientSendError } from '@dezon/core';
import { DelayedError, UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { createOutboundProcessor, isFinalFailure } from './outbound.processor';

const handlers = (process: () => Promise<void>) => ({ process, markFailed: vi.fn(async () => undefined) });
const job = () => ({ data: { messageId: 'm1' }, moveToDelayed: vi.fn(async () => undefined) });

describe('outbound processor', () => {
  it('PermanentSendError lọt ra thì chuyển thành UnrecoverableError', async () => {
    const run = createOutboundProcessor(
      handlers(async () => {
        throw new PermanentSendError('Hết cửa sổ');
      }),
    );
    await expect(run(job())).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('lỗi tạm thời giữ nguyên để BullMQ thử lại', async () => {
    const run = createOutboundProcessor(
      handlers(async () => {
        throw new TransientSendError('503');
      }),
    );
    await expect(run(job())).rejects.toBeInstanceOf(TransientSendError);
  });

  it('còn tin trước chưa gửi: hoãn job (moveToDelayed + DelayedError, không tính lượt thử)', async () => {
    const run = createOutboundProcessor(
      handlers(async () => {
        throw new OutboundNotReadyError(1_500);
      }),
    );
    const j = job();
    const before = Date.now();
    await expect(run(j, 'tok')).rejects.toBeInstanceOf(DelayedError);
    expect(j.moveToDelayed).toHaveBeenCalledOnce();
    const [at, token] = j.moveToDelayed.mock.calls[0] as unknown as [number, string];
    expect(at).toBeGreaterThanOrEqual(before + 1_500);
    expect(token).toBe('tok');
  });

  it('isFinalFailure: hết lượt hoặc UnrecoverableError', () => {
    const err = new Error('x');
    expect(isFinalFailure({ attemptsMade: 1, opts: { attempts: 3 } }, err)).toBe(false);
    expect(isFinalFailure({ attemptsMade: 3, opts: { attempts: 3 } }, err)).toBe(true);
    expect(isFinalFailure({ attemptsMade: 1, opts: {} }, err)).toBe(true);
    expect(isFinalFailure({ attemptsMade: 1, opts: { attempts: 3 } }, new UnrecoverableError('y'))).toBe(
      true,
    );
  });
});
