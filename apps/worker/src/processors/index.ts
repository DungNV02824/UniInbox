// Danh sách processor đăng ký với worker: mỗi hàng đợi một file trong thư mục này.
// Giai đoạn sau thêm memory-update... tại đây.
import type { Job, Processor, Queue } from 'bullmq';
import type { QueueName } from '@dezon/shared';
import type { Logger } from '../logger';
import type { PipelineRuntime } from '../pipeline-runtime';
import {
  AI_REPLY_QUEUE,
  aiReplyHandlers,
  createAiReplyProcessor,
  type AiReplyHandlers,
} from './ai-reply.processor';
import {
  CHANNEL_SYNC_QUEUE,
  channelSyncHandlers,
  createChannelSyncFailedHandler,
  createChannelSyncProcessor,
  registerChannelSyncSchedulers,
  type ChannelSyncConfig,
  type ChannelSyncHandlers,
} from './channel-sync.processor';
import { createInboundProcessor, INBOUND_QUEUE } from './inbound.processor';
import {
  createOutboundFailedHandler,
  createOutboundProcessor,
  OUTBOUND_QUEUE,
  outboundHandlers,
  type OutboundHandlers,
} from './outbound.processor';
import { processSystemJob, registerSystemSchedulers, SYSTEM_QUEUE } from './system.processor';

export interface ProcessorDefinition {
  queue: QueueName;
  /** `queue`: Queue của chính hàng đợi này (để processor đẩy thêm job, ví dụ tick channel-sync). */
  createProcessor: (logger: Logger, queue: Queue) => Processor;
  /** Đăng ký job định kỳ (job scheduler) cho hàng đợi, nếu có. */
  registerSchedulers?: (queue: Queue) => Promise<void>;
  /** Gọi sau mỗi lần job thất bại (kể cả lần còn được thử lại). */
  onFailed?: (job: Job, error: Error, logger: Logger) => Promise<void>;
}

export const SYSTEM_PROCESSOR: ProcessorDefinition = {
  queue: SYSTEM_QUEUE,
  createProcessor: (logger) => (job) => processSystemJob(job, { logger }),
  registerSchedulers: registerSystemSchedulers,
};

/** Processor chỉ cần Redis (dùng khi không có DB/S3, ví dụ test). */
export const PROCESSORS: readonly ProcessorDefinition[] = [SYSTEM_PROCESSOR];

export function inboundProcessor(runtime: PipelineRuntime): ProcessorDefinition {
  return { queue: INBOUND_QUEUE, createProcessor: () => createInboundProcessor(runtime) };
}

export function outboundProcessor(handlers: OutboundHandlers): ProcessorDefinition {
  return {
    queue: OUTBOUND_QUEUE,
    createProcessor: () => createOutboundProcessor(handlers),
    onFailed: createOutboundFailedHandler(handlers),
  };
}

export function channelSyncProcessor(
  handlers: ChannelSyncHandlers,
  config: ChannelSyncConfig,
): ProcessorDefinition {
  return {
    queue: CHANNEL_SYNC_QUEUE,
    createProcessor: (logger, queue) => createChannelSyncProcessor({ handlers, config, queue, logger }),
    registerSchedulers: (queue) => registerChannelSyncSchedulers(queue, config),
    onFailed: createChannelSyncFailedHandler(handlers),
  };
}

export function aiReplyProcessor(handlers: AiReplyHandlers): ProcessorDefinition {
  return { queue: AI_REPLY_QUEUE, createProcessor: (logger) => createAiReplyProcessor(handlers, logger) };
}

export interface ProcessorsConfig {
  channelSync: ChannelSyncConfig;
}

/** Toàn bộ processor của worker khi chạy thật. */
export function createProcessors(runtime: PipelineRuntime, config: ProcessorsConfig): ProcessorDefinition[] {
  return [
    SYSTEM_PROCESSOR,
    inboundProcessor(runtime),
    outboundProcessor(outboundHandlers(runtime)),
    channelSyncProcessor(channelSyncHandlers(runtime), config.channelSync),
    aiReplyProcessor(aiReplyHandlers(runtime)),
  ];
}
