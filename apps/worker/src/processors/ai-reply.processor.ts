// Hàng đợi "ai-reply": job "reply" (một lượt chatbot sau debounce), "handoff-reminder" (nhắc Lark một lần)
// "kick" (API đánh thức bot vừa bật lại khi khách đang chờ ⇒ lên lịch "reply" như tin khách mới) và "ai-auto-resume"
// (định kỳ: hội thoại "Cần người" vì lỗi phía AI tự trả lại cho bot khi AI hoạt động lại).
import type { DefaultJobOptions, Job, Queue } from 'bullmq';
import {
  AI_AUTO_RESUME_EVERY_MS,
  AI_AUTO_RESUME_JOB_NAME,
  AI_AUTO_RESUME_SCHEDULER_ID,
  AI_KICK_JOB_NAME,
  AI_REPLY_JOB_NAME,
  HANDOFF_REMINDER_JOB_NAME,
  maybeScheduleChatbotReply,
  processAiReplyJob,
  processHandoffReminderJob,
  reengageGuidanceText,
  resumeAiOutageHandoffs,
  type AiOutageResumeResult,
  type AiKickJobData,
  type AiReplyJobData,
  type AiReplyJobOptions,
  type AiReplyOutcome,
  type HandoffReminderJobData,
} from '@dezon/core';
import { QUEUE_NAMES, REENGAGE_MODES } from '@dezon/shared';
import type { Logger } from '../logger';
import type { PipelineRuntime } from '../pipeline-runtime';

export const AI_REPLY_QUEUE = QUEUE_NAMES.aiReply;

/** Phần core dùng trong processor — tách ra để test có thể thay thế. */
export interface AiReplyHandlers {
  /** false khi thiếu GEMINI_API_KEY: job "reply" bị bỏ qua (không gọi core, không escalate). */
  enabled: boolean;
  /**
   * wakeup = lượt "đánh thức" sau tạm nghỉ (AiReplyJobData.wakeup); reengage = lượt "Tái chăm sóc" (AiReplyJobData.reengage,
   * API đẩy với jobId aiReengageJobId; mode 'followup' = "Khách không bị bỏ sót" — bot chủ động nhắn).
   */
  reply: (conversationId: string, options?: AiReplyJobOptions) => Promise<AiReplyOutcome>;
  handoffReminder: (data: HandoffReminderJobData) => Promise<boolean>;
  /** Job "kick": lên lịch job "reply" (debounce) nếu bot còn bật; true nếu đã lên lịch. */
  kick: (conversationId: string) => Promise<boolean>;
  /** Job định kỳ "ai-auto-resume": tự trả lại cho bot các hội thoại "Cần người" vì lỗi AI (resumeAiOutageHandoffs). */
  autoResume: () => Promise<AiOutageResumeResult>;
}

export function aiReplyHandlers(runtime: PipelineRuntime): AiReplyHandlers {
  const { db, ai } = runtime;
  return {
    enabled: ai.enabled,
    reply: (conversationId, options) => processAiReplyJob(db, ai.deps, conversationId, options),
    handoffReminder: (data) => processHandoffReminderJob(db, ai.deps, data),
    // Không truyền typing deps: "kick" có thể không còn gì để trả lời (job sẽ skip no_new_messages) —
    // chỉ báo "đang soạn tin" sẽ bật khi job reply thật sự chạy và qua các điều kiện.
    kick: (conversationId) =>
      maybeScheduleChatbotReply(db, ai.deps.redis, ai.deps.scheduler, conversationId, ai.deps.ctx.now()),
    autoResume: () => resumeAiOutageHandoffs(db, ai.deps),
  };
}

/** Job định kỳ "ai-auto-resume": lỗi thì bỏ (lượt sau chạy lại), giữ ít lịch sử. */
export const AI_AUTO_RESUME_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 1,
  removeOnComplete: { count: 10 },
  removeOnFail: { count: 100 },
};

/**
 * Đăng ký (hoặc cập nhật) job định kỳ "ai-auto-resume" mỗi AI_AUTO_RESUME_EVERY_MS — idempotent (jobId scheduler cố
 * định). AI tắt (thiếu GEMINI_API_KEY) ⇒ gỡ lịch (không đẩy job vô ích).
 */
export async function registerAiReplySchedulers(
  queue: Pick<Queue, 'upsertJobScheduler' | 'removeJobScheduler'>,
  enabled: boolean,
): Promise<void> {
  if (!enabled) {
    await queue.removeJobScheduler(AI_AUTO_RESUME_SCHEDULER_ID);
    return;
  }
  await queue.upsertJobScheduler(
    AI_AUTO_RESUME_SCHEDULER_ID,
    { every: AI_AUTO_RESUME_EVERY_MS },
    { name: AI_AUTO_RESUME_JOB_NAME, data: {}, opts: AI_AUTO_RESUME_JOB_OPTIONS },
  );
}

type AiQueueJob = Pick<
  Job<AiReplyJobData | HandoffReminderJobData | AiKickJobData>,
  'id' | 'name' | 'data' | 'attemptsMade'
>;

/**
 * data.reengage đủ trường hợp lệ (API đẩy — startChatbotReengage). mode chỉ nhận thiếu / 'missed' / 'followup' — giá
 * trị lạ ⇒ job hỏng (chạy nhầm kiểu lượt có thể nuốt tin khách hoặc nhắn chủ động ngoài ý admin).
 */
function isValidReengage(
  reengage: AiReplyJobData['reengage'],
): reengage is NonNullable<AiReplyJobData['reengage']> {
  return (
    typeof reengage?.chatbotId === 'string' &&
    reengage.chatbotId !== '' &&
    typeof reengage.pendingMaxAgeHours === 'number' &&
    Number.isFinite(reengage.pendingMaxAgeHours) &&
    (reengage.mode === undefined || REENGAGE_MODES.includes(reengage.mode))
  );
}

/** Tùy chọn processAiReplyJob từ data job; undefined ⇒ lượt thường. */
function jobOptions(
  wakeup: boolean | undefined,
  reengage: AiReplyJobData['reengage'],
): AiReplyJobOptions | undefined {
  const withReengage = isValidReengage(reengage);
  if (!wakeup && !withReengage) return undefined;
  return {
    ...(wakeup ? { wakeup: true } : {}),
    ...(withReengage ? { reengage: reengageJobOptions(reengage) } : {}),
  };
}

/**
 * Tùy chọn tái chăm sóc cho core: chỉ dẫn gõ tay (rules/content) chuẩn hóa lại — dữ liệu job lạ không phình prompt;
 * mode chỉ chuyển khi 'followup' ('missed' = như thiếu).
 */
function reengageJobOptions(
  reengage: NonNullable<AiReplyJobData['reengage']>,
): NonNullable<AiReplyJobOptions['reengage']> {
  const rules = reengageGuidanceText(reengage.rules);
  const content = reengageGuidanceText(reengage.content);
  return {
    pendingMaxAgeHours: reengage.pendingMaxAgeHours,
    chatbotId: reengage.chatbotId,
    ...(rules ? { rules } : {}),
    ...(content ? { content } : {}),
    ...(reengage.mode === 'followup' ? { mode: 'followup' as const } : {}),
  };
}

/** Chỉ log id/trạng thái/lý do — không log nội dung tin nhắn. */
export function createAiReplyProcessor(handlers: AiReplyHandlers, logger: Logger) {
  return async (
    job: AiQueueJob,
  ): Promise<
    AiReplyOutcome | { reminded: boolean } | { scheduled: boolean } | AiOutageResumeResult | null
  > => {
    switch (job.name) {
      case AI_REPLY_JOB_NAME: {
        const { conversationId, wakeup, reengage } = job.data as AiReplyJobData;
        if (!handlers.enabled) {
          logger.debug(
            { jobId: job.id, conversationId },
            'Chatbot AI tắt (thiếu GEMINI_API_KEY): bỏ qua job',
          );
          return null;
        }
        // Job "Tái chăm sóc" hỏng data ⇒ bỏ hẳn (chạy như lượt thường có thể "nuốt" tin khách khi bị chặn).
        if (reengage !== undefined && !isValidReengage(reengage)) {
          logger.warn({ jobId: job.id, conversationId }, 'Job tái chăm sóc thiếu dữ liệu: bỏ qua');
          return null;
        }
        const options = jobOptions(wakeup, reengage);
        const outcome = options
          ? await handlers.reply(conversationId, options)
          : await handlers.reply(conversationId);
        logger.info(
          {
            jobId: job.id,
            conversationId,
            status: outcome.status,
            ...(outcome.status === 'done' ? { decision: outcome.decision } : { reason: outcome.reason }),
            aiRunId: outcome.aiRunId,
            attemptsMade: job.attemptsMade,
            ...(options?.reengage ? { reengage: true, reengageMode: options.reengage.mode ?? 'missed' } : {}),
          },
          'Chatbot đã xử lý hội thoại',
        );
        return outcome;
      }
      case HANDOFF_REMINDER_JOB_NAME: {
        const data = job.data as HandoffReminderJobData;
        const reminded = await handlers.handoffReminder(data);
        logger.info(
          { jobId: job.id, conversationId: data.conversationId, handoffId: data.handoffId, reminded },
          'Đã xử lý job nhắc handoff',
        );
        return { reminded };
      }
      case AI_KICK_JOB_NAME: {
        const { conversationId } = job.data as AiKickJobData;
        if (!handlers.enabled) {
          logger.debug(
            { jobId: job.id, conversationId },
            'Chatbot AI tắt (thiếu GEMINI_API_KEY): bỏ qua kick',
          );
          return null;
        }
        const scheduled = await handlers.kick(conversationId);
        logger.info({ jobId: job.id, conversationId, scheduled }, 'Đã đánh thức chatbot');
        return { scheduled };
      }
      case AI_AUTO_RESUME_JOB_NAME: {
        if (!handlers.enabled) return null;
        const result = await handlers.autoResume();
        // Chỉ log khi có việc (mỗi 3 phút một lượt — không làm ồn log).
        if (result.candidates > 0) {
          logger.info({ jobId: job.id, ...result }, 'Quét tự trả lại hội thoại cho bot (lỗi AI)');
        }
        return result;
      }
      default:
        logger.warn({ jobId: job.id, job: job.name }, 'Job ai-reply không rõ loại: bỏ qua');
        return null;
    }
  };
}
