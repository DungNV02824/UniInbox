// Test scheduler BullMQ (Queue giả): cờ ai-dirty khi cả hai khe job của hội thoại đang chạy.
import { aiReplyJobId } from '@dezon/core';
import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { aiReplyFollowUpJobId, createBullAiJobScheduler } from './scheduler';

type State = 'active' | 'delayed';

/** Queue giả: getJob theo jobId với trạng thái cố định; add ghi lại. */
function fakeQueue(states: Record<string, State>) {
  const added: { name: string; jobId: string | undefined }[] = [];
  const queue = {
    name: 'ai-reply',
    getJob: vi.fn(async (id: string) =>
      states[id]
        ? {
            getState: async () => states[id],
            remove: async () => {
              delete states[id];
            },
          }
        : undefined,
    ),
    add: vi.fn(async (name: string, _data: unknown, opts: { jobId?: string }) => {
      added.push({ name, jobId: opts.jobId });
      return {};
    }),
  };
  return { queue: queue as unknown as Queue, added };
}

const logger = { debug: () => undefined, warn: () => undefined };

describe('createBullAiJobScheduler — ai-dirty', () => {
  it('cả hai khe active ⇒ đặt cờ dirty, không thêm job', async () => {
    const conv = 'c1';
    const { queue, added } = fakeQueue({
      [aiReplyJobId(conv)]: 'active',
      [aiReplyFollowUpJobId(conv)]: 'active',
    });
    const markDirty = vi.fn(async () => undefined);
    const s = createBullAiJobScheduler({ aiReplyQueue: queue, outboundQueue: queue, logger, markDirty });
    await s.scheduleReply(conv, 1000);
    expect(markDirty).toHaveBeenCalledWith(conv);
    expect(added).toHaveLength(0);
  });

  it('một khe active ⇒ thêm job khe còn lại, không đặt cờ', async () => {
    const conv = 'c2';
    const { queue, added } = fakeQueue({ [aiReplyJobId(conv)]: 'active' });
    const markDirty = vi.fn(async () => undefined);
    const s = createBullAiJobScheduler({ aiReplyQueue: queue, outboundQueue: queue, logger, markDirty });
    await s.scheduleReply(conv, 1000);
    expect(markDirty).not.toHaveBeenCalled();
    expect(added.map((a) => a.jobId)).toEqual([aiReplyFollowUpJobId(conv)]);
  });
});
