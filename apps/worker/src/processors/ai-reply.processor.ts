// Hàng đợi "ai-reply": job "reply" (một lượt chatbot sau debounce), "handoff-reminder" (nhắc Lark một lần)
// và "kick" (API đánh thức bot vừa bật lại khi khách đang chờ ⇒ lên lịch "reply" như tin khách mới).
import type { Job } from 'bullmq';
import {
  AI_KICK_JOB_NAME,
  AI_REPLY_JOB_NAME,
  HANDOFF_REMINDER_JOB_NAME,
  maybeScheduleChatbotReply,
  processAiReplyJob,
  processHandoffReminderJob,
  type AiKickJobData,
  type AiReplyJobData,
  type AiReplyJobOptions,
  type AiReplyOutcome,
  type HandoffReminderJobData,
} from '@dezon/core';
import { QUEUE_NAMES } from '@dezon/shared';
import type { Logger } from '../logger';
import type { PipelineRuntime } from '../pipeline-runtime';

export const AI_REPLY_QUEUE = QUEUE_NAMES.aiReply;

/** Phần core dùng trong processor — tách ra để test có thể thay thế. */
export interface AiReplyHandlers {
  /** false khi thiếu GEMINI_API_KEY: job "reply" bị bỏ qua (không gọi core, không escalate). */
  enabled: boolean;
  /**
   * wakeup = lượt "đánh thức" sau tạm nghỉ (AiReplyJobData.wakeup); reengage = lượt "Tái chăm sóc khách bị bỏ sót"
   * (AiReplyJobData.reengage, API đẩy với jobId aiReengageJobId).
   */
  reply: (conversationId: string, options?: AiReplyJobOptions) => Promise<AiReplyOutcome>;
  handoffReminder: (data: HandoffReminderJobData) => Promise<boolean>;
  /** Job "kick": lên lịch job "reply" (debounce) nếu bot còn bật; true nếu đã lên lịch. */
  kick: (conversationId: string) => Promise<boolean>;
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
  };
}

type AiQueueJob = Pick<
  Job<AiReplyJobData | HandoffReminderJobData | AiKickJobData>,
  'id' | 'name' | 'data' | 'attemptsMade'
>;

/** data.reengage đủ trường hợp lệ (API đẩy — startChatbotReengage). */
function isValidReengage(
  reengage: AiReplyJobData['reengage'],
): reengage is NonNullable<AiReplyJobData['reengage']> {
  return (
    typeof reengage?.chatbotId === 'string' &&
    reengage.chatbotId !== '' &&
    typeof reengage.pendingMaxAgeHours === 'number' &&
    Number.isFinite(reengage.pendingMaxAgeHours)
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
    ...(withReengage
      ? { reengage: { pendingMaxAgeHours: reengage.pendingMaxAgeHours, chatbotId: reengage.chatbotId } }
      : {}),
  };
}

/** Chỉ log id/trạng thái/lý do — không log nội dung tin nhắn. */
export function createAiReplyProcessor(handlers: AiReplyHandlers, logger: Logger) {
  return async (
    job: AiQueueJob,
  ): Promise<AiReplyOutcome | { reminded: boolean } | { scheduled: boolean } | null> => {
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
            ...(options?.reengage ? { reengage: true } : {}),
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
      default:
        logger.warn({ jobId: job.id, job: job.name }, 'Job ai-reply không rõ loại: bỏ qua');
        return null;
    }
  };
}
