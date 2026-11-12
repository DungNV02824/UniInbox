// AiJobScheduler bằng BullMQ: debounce job "reply" của ai-reply (6.2), nhắc handoff, outbound tin bot có delay.
import type { JobsOptions, Queue } from 'bullmq';
import {
  AI_REPLY_JOB_NAME,
  aiReplyJobId,
  HANDOFF_REMINDER_JOB_NAME,
  handoffReminderJobId,
  OUTBOUND_JOB_NAME,
  outboundJobId,
  type AiJobScheduler,
  type AiReplyJobData,
  type HandoffReminderJobData,
  type OutboundJobData,
  type PipelineLogger,
} from '@dezon/core';
import { AI_REPLY_JOB_OPTIONS, HANDOFF_REMINDER_JOB_OPTIONS } from '../config';

/** jobId của job "nối tiếp" khi job chính của hội thoại đang chạy (active). */
export const aiReplyFollowUpJobId = (conversationId: string): string =>
  `${aiReplyJobId(conversationId)}-next`;

export interface BullAiJobSchedulerOptions {
  aiReplyQueue: Queue;
  outboundQueue: Queue;
  logger: Pick<PipelineLogger, 'debug' | 'warn'>;
  /**
   * Cả hai khe job của hội thoại đang chạy ⇒ đánh dấu "còn tin chưa lên lịch" (Redis aiDirtyKey, TTL
   * AI_DIRTY_TTL_SEC); processAiReplyJob kiểm-và-xóa cờ khi kết thúc rồi lên lịch lại.
   */
  markDirty?: (conversationId: string) => Promise<void>;
}

type UpsertResult = 'added' | 'active';

/** Số lần thử lại khi job đổi trạng thái giữa lúc đọc và lúc xóa (vd. vừa chuyển sang active). */
const UPSERT_ATTEMPTS = 3;

/**
 * "Xóa và tạo lại" job có jobId cố định: job cũ đang chờ/delayed/xong/lỗi ⇒ remove rồi add với delay mới.
 * Job đang active ⇒ không đụng tới, trả 'active'.
 */
async function upsertJob<Data>(
  queue: Queue,
  name: string,
  jobId: string,
  data: Data,
  opts: JobsOptions,
): Promise<UpsertResult> {
  for (let attempt = 0; attempt < UPSERT_ATTEMPTS; attempt++) {
    const existing = await queue.getJob(jobId);
    if (existing) {
      if ((await existing.getState()) === 'active') return 'active';
      try {
        await existing.remove();
      } catch {
        // Job vừa bị worker khóa (chuyển active) ⇒ đọc lại trạng thái.
        continue;
      }
    }
    await queue.add(name, data, { ...opts, jobId });
    return 'added';
  }
  return 'active';
}

async function isActive(queue: Queue, jobId: string): Promise<boolean> {
  const job = await queue.getJob(jobId);
  return job ? (await job.getState()) === 'active' : false;
}

/** Trạng thái job theo jobId; không có ⇒ null. */
async function jobState(queue: Queue, jobId: string): Promise<string | null> {
  const job = await queue.getJob(jobId);
  return job ? String(await job.getState()) : null;
}

/** Job còn chờ chạy (chưa active, chưa xong/lỗi). */
function isPendingState(state: string | null): boolean {
  return (
    state === 'waiting' || state === 'delayed' || state === 'prioritized' || state === 'waiting-children'
  );
}

/** Xóa job nếu còn chờ (không active); bỏ qua lỗi nếu nó vừa chuyển active. */
async function removeIfPending(queue: Queue, jobId: string): Promise<void> {
  const job = await queue.getJob(jobId);
  if (!job || (await job.getState()) === 'active') return;
  await job.remove().catch(() => undefined);
}

/**
 * Debounce theo hội thoại với hai "khe" jobId: chính `ai-<conv>` và nối tiếp `ai-<conv>-next`.
 * - Không khe nào active ⇒ xóa job nối tiếp còn chờ (job chính bao luôn), "xóa và tạo lại" job chính với delay
 *   mới (gặp tin mới thì dời lịch).
 * - Một khe đang active (job đang gọi LLM) ⇒ "xóa và tạo lại" khe còn lại. Không bỏ qua như gợi ý ban đầu của
 *   core: job active có thể đã qua bước chống đua (đã commit tin bot, hoặc quyết định no_reply) nên sẽ không
 *   thấy tin khách mới. Job nối tiếp chạy sau; nếu không còn tin khách chưa xử lý thì core skip (không ghi
 *   ai_runs). Hai job cùng hội thoại có thể chạy chồng: job cũ thấy tin khách mới sau lúc nó bắt đầu ⇒ hủy ở
 *   bước chống đua, chỉ job mới trả lời.
 * - Cả hai khe active ⇒ đặt cờ ai-dirty (markDirty): job nào kết thúc sau sẽ lên lịch lại, tin không bị rơi.
 */
export function createBullAiJobScheduler(options: BullAiJobSchedulerOptions): AiJobScheduler {
  const { aiReplyQueue, outboundQueue, logger, markDirty } = options;

  return {
    async scheduleReply(conversationId, delayMs) {
      const delay = Math.max(0, Math.round(delayMs));
      const data: AiReplyJobData = { conversationId, scheduledAt: new Date().toISOString() };
      const opts: JobsOptions = { ...AI_REPLY_JOB_OPTIONS, delay };
      const primary = aiReplyJobId(conversationId);
      const followUp = aiReplyFollowUpJobId(conversationId);

      const [primaryActive, followUpActive] = await Promise.all([
        isActive(aiReplyQueue, primary),
        isActive(aiReplyQueue, followUp),
      ]);
      if (primaryActive && followUpActive) {
        await markDirty?.(conversationId);
        logger.debug({ conversationId }, 'ai-reply: hai job của hội thoại đang chạy, đánh dấu ai-dirty');
        return;
      }
      if (!primaryActive && !followUpActive) {
        await removeIfPending(aiReplyQueue, followUp);
        const result = await upsertJob(aiReplyQueue, AI_REPLY_JOB_NAME, primary, data, opts);
        if (result === 'added') return;
        // Job chính vừa chuyển active giữa chừng ⇒ dùng khe nối tiếp.
      }
      const slot = primaryActive || !followUpActive ? followUp : primary;
      const result = await upsertJob(aiReplyQueue, AI_REPLY_JOB_NAME, slot, data, opts);
      if (result === 'active') {
        await markDirty?.(conversationId);
        logger.debug({ conversationId }, 'ai-reply: job của hội thoại đang chạy, đánh dấu ai-dirty');
      }
    },

    async scheduleWakeup(conversationId, delayMs) {
      const delay = Math.max(0, Math.round(delayMs));
      const data: AiReplyJobData = { conversationId, scheduledAt: new Date().toISOString(), wakeup: true };
      const opts: JobsOptions = { ...AI_REPLY_JOB_OPTIONS, delay };
      const primary = aiReplyJobId(conversationId);
      const followUp = aiReplyFollowUpJobId(conversationId);
      const [primaryState, followUpState] = await Promise.all([
        jobState(aiReplyQueue, primary),
        jobState(aiReplyQueue, followUp),
      ]);
      // Đã có job chờ (kick sau "Tiếp tục AI", debounce tin khách mới…) ⇒ không thay: job đó chạy trước; còn nghỉ
      // thì nó bị chặn và lại tự hẹn lượt đánh thức.
      if (isPendingState(primaryState) || isPendingState(followUpState)) return;
      const slot = primaryState !== 'active' ? primary : followUpState !== 'active' ? followUp : null;
      const result = slot ? await upsertJob(aiReplyQueue, AI_REPLY_JOB_NAME, slot, data, opts) : 'active';
      if (result === 'active') {
        await markDirty?.(conversationId);
        logger.debug({ conversationId }, 'ai-reply: không còn khe cho lượt đánh thức, đánh dấu ai-dirty');
      }
    },

    async scheduleHandoffReminder(data, delayMs) {
      const delay = Math.max(0, Math.round(delayMs));
      const result = await upsertJob<HandoffReminderJobData>(
        aiReplyQueue,
        HANDOFF_REMINDER_JOB_NAME,
        handoffReminderJobId(data.handoffId),
        data,
        { ...HANDOFF_REMINDER_JOB_OPTIONS, delay },
      );
      if (result === 'active') {
        logger.warn({ handoffId: data.handoffId }, 'Job nhắc handoff đang chạy, bỏ qua lên lịch lại');
      }
    },

    async enqueueOutbound(messageId, delayMs) {
      const delay = Math.max(0, Math.round(delayMs));
      // Tùy chọn thử lại lấy từ defaultJobOptions của Queue outbound (QUEUE_JOB_OPTIONS).
      await outboundQueue.add(OUTBOUND_JOB_NAME, { messageId } satisfies OutboundJobData, {
        jobId: outboundJobId(messageId),
        delay,
      });
    },
  };
}
