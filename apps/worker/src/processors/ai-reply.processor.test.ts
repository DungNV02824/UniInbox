import {
  AI_KICK_JOB_NAME,
  AI_REPLY_JOB_NAME,
  HANDOFF_REMINDER_JOB_NAME,
  type AiReplyOutcome,
} from '@dezon/core';
import { describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '../logger';
import { createAiReplyProcessor, type AiReplyHandlers } from './ai-reply.processor';

const handlers = (overrides: Partial<AiReplyHandlers> = {}): AiReplyHandlers => ({
  enabled: true,
  reply: vi.fn<AiReplyHandlers['reply']>(async () => ({
    status: 'done',
    decision: 'reply',
    aiRunId: 'run-1',
  })),
  handoffReminder: vi.fn<AiReplyHandlers['handoffReminder']>(async () => true),
  kick: vi.fn<AiReplyHandlers['kick']>(async () => true),
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
});
