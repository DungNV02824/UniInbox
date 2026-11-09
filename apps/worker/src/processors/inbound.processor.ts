// Hàng đợi "inbound": chuẩn hóa webhook bằng connector rồi chạy pipeline tin đến (6.1).
import type { Job } from 'bullmq';
import { processInboundJob, type InboundJobData } from '@dezon/core';
import { QUEUE_NAMES } from '@dezon/shared';
import type { PipelineRuntime } from '../pipeline-runtime';

export const INBOUND_QUEUE = QUEUE_NAMES.inbound;

export function createInboundProcessor(runtime: PipelineRuntime) {
  // Không log payload (nội dung tin nhắn); lỗi được BullMQ thử lại vì xử lý idempotent.
  return async (job: Pick<Job<InboundJobData>, 'data'>): Promise<void> => {
    await processInboundJob(runtime.db, runtime.deps, job.data);
  };
}
