import {
  AI_AUTO_RESUME_EVERY_MS,
  AI_AUTO_RESUME_JOB_NAME,
  AI_AUTO_RESUME_SCHEDULER_ID,
  AI_KICK_JOB_NAME,
  AI_REPLY_JOB_NAME,
  HANDOFF_REMINDER_JOB_NAME,
  type AiOutageResumeResult,
  type AiReplyOutcome,
} from '@dezon/core';
import { describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '../logger';
import {
  AI_AUTO_RESUME_JOB_OPTIONS,
  createAiReplyProcessor,
  registerAiReplySchedulers,
  type AiReplyHandlers,
} from './ai-reply.processor';
import { aiReplyProcessor } from './index';

const emptyResume: AiOutageResumeResult = {
  candidates: 0,
  probedOk: [],
  probeFailed: [],
  resumed: 0,
  skipped: 0,
  kicked: 0,
};

const handlers = (overrides: Partial<AiReplyHandlers> = {}): AiReplyHandlers => ({
  enabled: true,
  reply: vi.fn<AiReplyHandlers['reply']>(async () => ({
    status: 'done',
    decision: 'reply',
    aiRunId: 'run-1',
  })),
  handoffReminder: vi.fn<AiReplyHandlers['handoffReminder']>(async () => true),
  kick: vi.fn<AiReplyHandlers['kick']>(async () => true),
  autoResume: vi.fn<AiReplyHandlers['autoResume']>(async () => emptyResume),
  ...overrides,
});

const job = (name: string, data: object) => ({ id: 'j1', name, data: data as never, attemptsMade: 0 });

describe('ai-reply processor', () => {
  it('job "reply" gọi processAiReplyJob với conversationId', async () => {
    const h = handlers();
    const run = createAiReplyProcessor(h, createSilentLogger());
    const result = await run(job(AI_REPLY_JOB_NAME, { conversationId: 'c1', scheduledAt: 'x' }));
    expect(h.reply).toHaveBeenCalledWith('c1');
    expect(h.handoffReminder).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'done', decision: 'reply', aiRunId: 'run-1' });
  });

  it('job "reply" đánh thức (wakeup) truyền { wakeup: true }', async () => {
    const h = handlers();
    const run = createAiReplyProcessor(h, createSilentLogger());
    await run(job(AI_REPLY_JOB_NAME, { conversationId: 'c1', scheduledAt: 'x', wakeup: true }));
    expect(h.reply).toHaveBeenCalledWith('c1', { wakeup: true });
  });

  it('job "reply" tái chăm sóc truyền reengage (tuổi tin chờ + bot) cho core, log có cờ reengage', async () => {
    const logger = createSilentLogger();
    const info = vi.spyOn(logger, 'info');
    const h = handlers();
    const run = createAiReplyProcessor(h, logger);
    const reengage = { pendingMaxAgeHours: 360, chatbotId: 'bot-1' };
    await run(job(AI_REPLY_JOB_NAME, { conversationId: 'c1', scheduledAt: 'x', reengage }));
    expect(h.reply).toHaveBeenCalledWith('c1', { reengage });
    const [fields] = info.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(fields.reengage).toBe(true);
  });

  it('job tái chăm sóc có chỉ dẫn gõ tay ⇒ truyền rules/content đã trim; giá trị lạ / rỗng bị bỏ', async () => {
    const h = handlers();
    const run = createAiReplyProcessor(h, createSilentLogger());
    const base = { pendingMaxAgeHours: 360, chatbotId: 'bot-1' };
    await run(
      job(AI_REPLY_JOB_NAME, {
        conversationId: 'c1',
        scheduledAt: 'x',
        reengage: { ...base, rules: '  Xưng em ', content: 'Mời khảo sát' },
      }),
    );
    expect(h.reply).toHaveBeenLastCalledWith('c1', {
      reengage: { ...base, rules: 'Xưng em', content: 'Mời khảo sát' },
    });
    await run(
      job(AI_REPLY_JOB_NAME, {
        conversationId: 'c2',
        scheduledAt: 'x',
        reengage: { ...base, rules: 42, content: '   ' },
      }),
    );
    expect(h.reply).toHaveBeenLastCalledWith('c2', { reengage: base });
  });

  it('job tái chăm sóc thiếu dữ liệu ⇒ bỏ qua, không chạy như lượt thường', async () => {
    const h = handlers();
    const run = createAiReplyProcessor(h, createSilentLogger());
    for (const reengage of [{ pendingMaxAgeHours: 360 }, { chatbotId: 'b', pendingMaxAgeHours: 'x' }, null]) {
      expect(
        await run(job(AI_REPLY_JOB_NAME, { conversationId: 'c1', scheduledAt: 'x', reengage })),
      ).toBeNull();
    }
    expect(h.reply).not.toHaveBeenCalled();
  });

  it('mode "Khách không bị bỏ sót" (followup) truyền cho core, log có reengageMode; "missed" như thiếu mode', async () => {
    const logger = createSilentLogger();
    const info = vi.spyOn(logger, 'info');
    const h = handlers();
    const run = createAiReplyProcessor(h, logger);
    const base = { pendingMaxAgeHours: 360, chatbotId: 'bot-1' };
    await run(
      job(AI_REPLY_JOB_NAME, {
        conversationId: 'c1',
        scheduledAt: 'x',
        reengage: { ...base, mode: 'followup', content: ' Mời khảo sát ' },
      }),
    );
    expect(h.reply).toHaveBeenLastCalledWith('c1', {
      reengage: { ...base, content: 'Mời khảo sát', mode: 'followup' },
    });
    const [fields] = info.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(fields).toMatchObject({ reengage: true, reengageMode: 'followup' });

    await run(
      job(AI_REPLY_JOB_NAME, {
        conversationId: 'c2',
        scheduledAt: 'x',
        reengage: { ...base, mode: 'missed' },
      }),
    );
    expect(h.reply).toHaveBeenLastCalledWith('c2', { reengage: base });
    const [fields2] = info.mock.calls[1] as unknown as [Record<string, unknown>];
    expect(fields2).toMatchObject({ reengage: true, reengageMode: 'missed' });
  });

  it('mode lạ ⇒ job tái chăm sóc hỏng: bỏ qua, không gọi core', async () => {
    const h = handlers();
    const run = createAiReplyProcessor(h, createSilentLogger());
    for (const mode of ['spam', 1, null, '']) {
      expect(
        await run(
          job(AI_REPLY_JOB_NAME, {
            conversationId: 'c1',
            scheduledAt: 'x',
            reengage: { pendingMaxAgeHours: 360, chatbotId: 'bot-1', mode },
          }),
        ),
      ).toBeNull();
    }
    expect(h.reply).not.toHaveBeenCalled();
  });

  it('job "handoff-reminder" gọi processHandoffReminderJob với data', async () => {
    const h = handlers();
    const run = createAiReplyProcessor(h, createSilentLogger());
    const data = { conversationId: 'c1', handoffId: 'h1' };
    const result = await run(job(HANDOFF_REMINDER_JOB_NAME, data));
    expect(h.handoffReminder).toHaveBeenCalledWith(data);
    expect(h.reply).not.toHaveBeenCalled();
    expect(result).toEqual({ reminded: true });
  });

  it('job "kick" lên lịch trả lời cho hội thoại (không gọi thẳng processAiReplyJob)', async () => {
    const h = handlers();
    const run = createAiReplyProcessor(h, createSilentLogger());
    const result = await run(job(AI_KICK_JOB_NAME, { conversationId: 'c1' }));
    expect(h.kick).toHaveBeenCalledWith('c1');
    expect(h.reply).not.toHaveBeenCalled();
    expect(result).toEqual({ scheduled: true });
  });

  it('AI tắt (thiếu key): bỏ qua job "kick"', async () => {
    const h = handlers({ enabled: false });
    const run = createAiReplyProcessor(h, createSilentLogger());
    expect(await run(job(AI_KICK_JOB_NAME, { conversationId: 'c1' }))).toBeNull();
    expect(h.kick).not.toHaveBeenCalled();
  });

  it('AI tắt (thiếu key): bỏ qua job "reply" nhưng vẫn chạy nhắc handoff', async () => {
    const h = handlers({ enabled: false });
    const run = createAiReplyProcessor(h, createSilentLogger());
    expect(await run(job(AI_REPLY_JOB_NAME, { conversationId: 'c1', scheduledAt: 'x' }))).toBeNull();
    expect(h.reply).not.toHaveBeenCalled();
    await run(job(HANDOFF_REMINDER_JOB_NAME, { conversationId: 'c1', handoffId: 'h1' }));
    expect(h.handoffReminder).toHaveBeenCalledOnce();
  });

  it('lỗi hạ tầng từ core được ném ra để BullMQ thử lại', async () => {
    const h = handlers({
      reply: vi.fn(async (): Promise<AiReplyOutcome> => Promise.reject(new Error('DB down'))),
    });
    const run = createAiReplyProcessor(h, createSilentLogger());
    await expect(run(job(AI_REPLY_JOB_NAME, { conversationId: 'c1', scheduledAt: 'x' }))).rejects.toThrow(
      'DB down',
    );
  });

  it('job không rõ loại: bỏ qua, không gọi core', async () => {
    const h = handlers();
    const run = createAiReplyProcessor(h, createSilentLogger());
    expect(await run(job('khac', {}))).toBeNull();
    expect(h.reply).not.toHaveBeenCalled();
    expect(h.handoffReminder).not.toHaveBeenCalled();
  });

  it('không log nội dung: chỉ id, trạng thái, lý do', async () => {
    const logger = createSilentLogger();
    const info = vi.spyOn(logger, 'info');
    const h = handlers({
      reply: vi.fn(async () => ({ status: 'skipped' as const, reason: 'paused', aiRunId: null })),
    });
    await createAiReplyProcessor(
      h,
      logger,
    )(job(AI_REPLY_JOB_NAME, { conversationId: 'c1', scheduledAt: 'x' }));
    expect(info).toHaveBeenCalledOnce();
    const [fields] = info.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(Object.keys(fields).sort()).toEqual(
      ['aiRunId', 'attemptsMade', 'conversationId', 'jobId', 'reason', 'status'].sort(),
    );
  });

  describe('job định kỳ "ai-auto-resume" (tự trả lại cho bot khi AI hoạt động lại)', () => {
    it('gọi handlers.autoResume, trả kết quả; không có ứng viên ⇒ không log info', async () => {
      const logger = createSilentLogger();
      const info = vi.spyOn(logger, 'info');
      const h = handlers();
      const result = await createAiReplyProcessor(h, logger)(job(AI_AUTO_RESUME_JOB_NAME, {}));
      expect(h.autoResume).toHaveBeenCalledOnce();
      expect(result).toEqual(emptyResume);
      expect(info).not.toHaveBeenCalled();
      expect(h.reply).not.toHaveBeenCalled();
    });

    it('có ứng viên ⇒ log số lượng (không nội dung)', async () => {
      const logger = createSilentLogger();
      const info = vi.spyOn(logger, 'info');
      const h = handlers({
        autoResume: vi.fn(async () => ({ ...emptyResume, candidates: 2, probedOk: ['m'], resumed: 2 })),
      });
      await createAiReplyProcessor(h, logger)(job(AI_AUTO_RESUME_JOB_NAME, {}));
      expect(info).toHaveBeenCalledOnce();
      const [fields] = info.mock.calls[0] as unknown as [Record<string, unknown>];
      expect(fields).toMatchObject({ candidates: 2, resumed: 2 });
    });

    it('AI tắt (thiếu GEMINI_API_KEY) ⇒ bỏ qua', async () => {
      const h = handlers({ enabled: false });
      expect(
        await createAiReplyProcessor(h, createSilentLogger())(job(AI_AUTO_RESUME_JOB_NAME, {})),
      ).toBeNull();
      expect(h.autoResume).not.toHaveBeenCalled();
    });

    it('registerAiReplySchedulers: bật ⇒ upsert lịch mỗi 3 phút (idempotent theo id); tắt ⇒ gỡ lịch', async () => {
      const queue = {
        upsertJobScheduler: vi.fn(async () => ({}) as never),
        removeJobScheduler: vi.fn(async () => true),
      };
      await registerAiReplySchedulers(queue, true);
      expect(AI_AUTO_RESUME_EVERY_MS).toBe(3 * 60_000);
      expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
        AI_AUTO_RESUME_SCHEDULER_ID,
        { every: AI_AUTO_RESUME_EVERY_MS },
        { name: AI_AUTO_RESUME_JOB_NAME, data: {}, opts: AI_AUTO_RESUME_JOB_OPTIONS },
      );
      expect(AI_AUTO_RESUME_JOB_OPTIONS.attempts).toBe(1);
      await registerAiReplySchedulers(queue, false);
      expect(queue.removeJobScheduler).toHaveBeenCalledWith(AI_AUTO_RESUME_SCHEDULER_ID);
      expect(queue.upsertJobScheduler).toHaveBeenCalledOnce();
    });

    it('processor ai-reply đăng ký lịch theo handlers.enabled', async () => {
      const queue = {
        upsertJobScheduler: vi.fn(async () => ({}) as never),
        removeJobScheduler: vi.fn(async () => true),
      };
      await aiReplyProcessor(handlers()).registerSchedulers?.(queue as never);
      expect(queue.upsertJobScheduler).toHaveBeenCalledOnce();
      await aiReplyProcessor(handlers({ enabled: false })).registerSchedulers?.(queue as never);
      expect(queue.removeJobScheduler).toHaveBeenCalledOnce();
    });
  });
});
