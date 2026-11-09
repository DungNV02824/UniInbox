// Hàng đợi "outbound": gửi một message (status = queued) ra nền tảng (6.6).
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import {
  markOutboundFailed,
  OutboundNotReadyError,
  PermanentSendError,
  processOutboundMessage,
  type OutboundJobData,
} from '@dezon/core';
import { QUEUE_NAMES } from '@dezon/shared';
import type { Logger } from '../logger';
import type { PipelineRuntime } from '../pipeline-runtime';

export const OUTBOUND_QUEUE = QUEUE_NAMES.outbound;

/** Phần core dùng trong processor — tách ra để test có thể thay thế. */
export interface OutboundHandlers {
  process: (messageId: string) => Promise<void>;
  markFailed: (messageId: string, error: string) => Promise<void>;
}

export function outboundHandlers(runtime: PipelineRuntime): OutboundHandlers {
  return {
    process: (id) => processOutboundMessage(runtime.db, runtime.deps, id),
    markFailed: (id, error) => markOutboundFailed(runtime.db, runtime.deps, id, error),
  };
}

export function createOutboundProcessor(handlers: OutboundHandlers) {
  return async (job: Pick<Job<OutboundJobData>, 'data' | 'moveToDelayed'>, token?: string): Promise<void> => {
    try {
      await handlers.process(job.data.messageId);
    } catch (error) {
      // Còn tin trước trong hội thoại chưa gửi xong: hoãn job (không tính lượt thử) để giữ thứ tự.
      if (error instanceof OutboundNotReadyError) {
        await job.moveToDelayed(Date.now() + error.retryAfterMs, token);
        throw new DelayedError();
      }
      // Lỗi vĩnh viễn lọt ra (core thường tự đánh dấu failed): không thử lại.
      if (error instanceof PermanentSendError) throw new UnrecoverableError(error.message);
      throw error;
    }
  };
}

/** Job thất bại hẳn (hết lượt hoặc không thử lại được) thì đánh dấu tin failed. */
export function isFinalFailure(job: Pick<Job, 'attemptsMade' | 'opts'>, error: Error): boolean {
  return error.name === 'UnrecoverableError' || job.attemptsMade >= (job.opts.attempts ?? 1);
}

export function createOutboundFailedHandler(handlers: OutboundHandlers) {
  return async (job: Job<OutboundJobData>, error: Error, logger: Logger): Promise<void> => {
    if (!isFinalFailure(job, error)) return;
    try {
      await handlers.markFailed(job.data.messageId, `Gửi thất bại: ${error.message}`);
    } catch (markError) {
      logger.error({ jobId: job.id, err: markError }, 'Không đánh dấu được tin gửi thất bại');
    }
  };
}
