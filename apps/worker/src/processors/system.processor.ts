// Hàng đợi "system": job bảo trì/kiểm tra sức khỏe của worker (Giai đoạn 0).
import type { Job, Queue } from 'bullmq';
import { QUEUE_NAMES } from '@dezon/shared';
import type { Logger } from '../logger';

export const SYSTEM_QUEUE = QUEUE_NAMES.system;

export const SYSTEM_JOBS = {
  heartbeat: 'heartbeat',
  echo: 'echo',
} as const;

export const HEARTBEAT_SCHEDULER_ID = 'system:heartbeat';
export const HEARTBEAT_EVERY_MS = 60_000;

export interface HeartbeatResult {
  ok: true;
  at: string;
}

export type SystemJob = Pick<Job, 'id' | 'name' | 'data'>;

export interface SystemJobContext {
  logger?: Pick<Logger, 'info'>;
  now?: () => Date;
}

/** Xử lý job của hàng đợi system. Tên job lạ => ném lỗi (job bị đánh dấu failed). */
export async function processSystemJob(job: SystemJob, ctx: SystemJobContext = {}): Promise<unknown> {
  switch (job.name) {
    case SYSTEM_JOBS.heartbeat: {
      const at = (ctx.now?.() ?? new Date()).toISOString();
      // Mức info: tín hiệu "còn sống" mỗi 60s, không chứa dữ liệu nhạy cảm.
      ctx.logger?.info({ jobId: job.id, at }, 'heartbeat');
      return { ok: true, at } satisfies HeartbeatResult;
    }
    case SYSTEM_JOBS.echo:
      return job.data;
    default:
      throw new Error(`Job không hỗ trợ trong hàng đợi "${SYSTEM_QUEUE}": ${job.name}`);
  }
}

/** Đăng ký (hoặc cập nhật) lịch heartbeat mỗi 60s. Idempotent: khởi động lại không tạo trùng. */
export async function registerSystemSchedulers(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    HEARTBEAT_SCHEDULER_ID,
    { every: HEARTBEAT_EVERY_MS },
    {
      name: SYSTEM_JOBS.heartbeat,
      data: {},
      // Heartbeat lỗi thì bỏ qua, lần sau chạy lại; không cần lưu lâu.
      opts: { attempts: 1, removeOnComplete: { count: 10 }, removeOnFail: { count: 100 } },
    },
  );
}
