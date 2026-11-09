import { Queue, type ConnectionOptions } from 'bullmq';
import type { QueueName } from '@dezon/shared';
import { DEFAULT_JOB_OPTIONS, QUEUE_JOB_OPTIONS } from './config';

export function createQueue<Data = unknown, Result = unknown>(
  name: QueueName,
  connection: ConnectionOptions,
): Queue<Data, Result> {
  return new Queue<Data, Result>(name, {
    connection,
    defaultJobOptions: QUEUE_JOB_OPTIONS[name] ?? DEFAULT_JOB_OPTIONS,
  });
}

/** Tạo Queue cho danh sách tên hàng đợi (theo QUEUE_NAMES). */
export function createQueues<N extends QueueName>(
  names: readonly N[],
  connection: ConnectionOptions,
): Record<N, Queue> {
  const entries = names.map((name) => [name, createQueue(name, connection)] as const);
  return Object.fromEntries(entries) as Record<N, Queue>;
}
