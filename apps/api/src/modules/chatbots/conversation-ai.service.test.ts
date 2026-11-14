// ConversationAiService.ackHandoff / resolveHandoff: tin bot của nút banner "Cần người" (thứ tự với kick + Lark,
// lỗi không làm hỏng request); rejectHandoff ("Không đạt": thiếu GEMINI_API_KEY ⇒ 503, Lark kèm lý do). Lõi (@dezon/core) giả một phần; DB/hàng đợi giả.
import * as core from '@dezon/core';
import type { Db } from '@dezon/db';
import type { Queue } from 'bullmq';
import { ServiceUnavailableException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config';
import type { RealtimeService } from '../realtime/realtime.service';
import { ConversationAiService, LLM_REJECT_NOT_CONFIGURED_MESSAGE } from './conversation-ai.service';

vi.mock('@dezon/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dezon/core')>();
  return {
    ...actual,
    ackHandoff: vi.fn(),
    resolveHandoff: vi.fn(),
    needsChatbotKick: vi.fn(),
    sendHandoffActionMessage: vi.fn(),
    loadHandoffActionNotice: vi.fn(),
    rejectHandoffWithAiReply: vi.fn(),
  };
});

const mocked = vi.mocked(core);
const CONV = 'c0000000-0000-4000-8000-000000000001';
const viewer: core.Viewer = { id: 'u1', role: 'agent' };
const summary = { id: CONV, assignedUser: null } as unknown as core.UpdateConversationResult['conversation'];

let order: string[];
let outboundAdds: { name: string; data: unknown; opts: unknown }[];

const fakeLlm: core.LlmClient = { generate: vi.fn() };

function makeService(opts: { outboundFails?: boolean; llm?: core.LlmClient | null } = {}) {
  outboundAdds = [];
  const aiReply = {
    add: vi.fn(async () => {
      order.push('kick');
      return {};
    }),
  } as unknown as Queue<core.AiKickJobData>;
  const outbound = {
    add: vi.fn(async (name: string, data: unknown, o: unknown) => {
      if (opts.outboundFails) throw new Error('redis down');
      outboundAdds.push({ name, data, opts: o });
      order.push(`outbound:${(data as { messageId: string }).messageId}`);
      return {};
    }),
  } as unknown as Queue<core.OutboundJobData>;
  const realtime = { emit: vi.fn() } as unknown as RealtimeService;
  const ctx: core.InboxContext = {
    now: () => new Date(),
    signUrl: async (k: string) => k,
    policy: { metaHumanAgentEnabled: false, zaloOaAllowPaidBot: false },
  };
  return new ConversationAiService(
    {} as Db,
    ctx,
    realtime,
    aiReply,
    outbound,
    { APP_URL: 'https://inbox.test', GEMINI_MODEL: 'gemini-default' } as AppConfig,
    {} as core.CredentialsCipher,
    vi.fn() as unknown as typeof fetch,
    opts.llm === undefined ? fakeLlm : opts.llm,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  order = [];
  mocked.loadHandoffActionNotice.mockImplementation(async () => {
    order.push('lark');
    return null;
  });
});

describe('resolveHandoff', () => {
  it('kick tính TRƯỚC khi gửi tin của nút; đẩy job: tin của nút ⇒ kick ⇒ Lark', async () => {
    mocked.resolveHandoff.mockResolvedValue({
      conversation: summary,
      previousAssigneeId: null,
      resolvedHandoffIds: ['h1'],
    } as Awaited<ReturnType<typeof core.resolveHandoff>>);
    // Sau khi tin bot được tạo, khách không còn "đang chờ" ⇒ needsChatbotKick chỉ đúng nếu gọi trước.
    let botMessageInserted = false;
    mocked.needsChatbotKick.mockImplementation(async () => {
      order.push('needsKick');
      return !botMessageInserted;
    });
    mocked.sendHandoffActionMessage.mockImplementation(async (_db, deps, input) => {
      botMessageInserted = true;
      order.push(`send:${input.action}:${input.handoffIds.join(',')}`);
      await deps.scheduler.enqueueOutbound('m1', 0);
      return { status: 'sent', messageIds: ['m1'], queued: 1 };
    });

    const service = makeService();
    await expect(service.resolveHandoff(viewer, CONV)).resolves.toBe(summary);
    expect(order).toEqual(['needsKick', 'send:resolve:h1', 'outbound:m1', 'kick', 'lark']);
    expect(outboundAdds).toEqual([
      {
        name: core.OUTBOUND_JOB_NAME,
        data: { messageId: 'm1' },
        opts: { jobId: core.outboundJobId('m1'), delay: 0 },
      },
    ]);
  });

  it('bấm lại (không đóng handoff nào) ⇒ không gửi tin; vẫn kick nếu khách chờ', async () => {
    mocked.resolveHandoff.mockResolvedValue({
      conversation: summary,
      previousAssigneeId: null,
      resolvedHandoffIds: [],
    } as Awaited<ReturnType<typeof core.resolveHandoff>>);
    mocked.needsChatbotKick.mockResolvedValue(true);
    await makeService().resolveHandoff(viewer, CONV);
    expect(mocked.sendHandoffActionMessage).not.toHaveBeenCalled();
    expect(order).toEqual(['kick']);
  });

  it('gửi tin lỗi ⇒ request vẫn thành công, kick vẫn đẩy', async () => {
    mocked.resolveHandoff.mockResolvedValue({
      conversation: summary,
      previousAssigneeId: null,
      resolvedHandoffIds: ['h1'],
    } as Awaited<ReturnType<typeof core.resolveHandoff>>);
    mocked.needsChatbotKick.mockResolvedValue(true);
    mocked.sendHandoffActionMessage.mockRejectedValue(new Error('db down'));
    await expect(makeService().resolveHandoff(viewer, CONV)).resolves.toBe(summary);
    expect(order).toEqual(['kick', 'lark']);
  });
});

describe('ackHandoff', () => {
  it('lần bấm đổi trạng thái ⇒ gửi tin trước Lark; bấm lại ⇒ không gửi', async () => {
    mocked.ackHandoff.mockResolvedValueOnce({
      conversation: summary,
      previousAssigneeId: null,
      ackedHandoffId: 'h1',
    } as Awaited<ReturnType<typeof core.ackHandoff>>);
    mocked.sendHandoffActionMessage.mockImplementation(async (_db, _deps, input) => {
      order.push(`send:${input.action}:${input.handoffIds.join(',')}`);
      return { status: 'skipped' };
    });
    const service = makeService();
    await service.ackHandoff(viewer, CONV);
    expect(order).toEqual(['send:ack:h1', 'lark']);

    order = [];
    mocked.ackHandoff.mockResolvedValueOnce({
      conversation: summary,
      previousAssigneeId: null,
      ackedHandoffId: null,
    } as Awaited<ReturnType<typeof core.ackHandoff>>);
    await service.ackHandoff(viewer, CONV);
    expect(order).toEqual([]);
    expect(mocked.needsChatbotKick).not.toHaveBeenCalled();
  });

  it('đẩy outbound lỗi ⇒ chỉ log, request vẫn thành công', async () => {
    mocked.ackHandoff.mockResolvedValue({
      conversation: summary,
      previousAssigneeId: null,
      ackedHandoffId: 'h1',
    } as Awaited<ReturnType<typeof core.ackHandoff>>);
    mocked.sendHandoffActionMessage.mockImplementation(async (_db, deps) => {
      await deps.scheduler.enqueueOutbound('m1', 0);
      return { status: 'sent', messageIds: ['m1'], queued: 1 };
    });
    await expect(makeService({ outboundFails: true }).ackHandoff(viewer, CONV)).resolves.toBe(summary);
  });
});

describe('rejectHandoff ("Không đạt")', () => {
  it('chưa có GEMINI_API_KEY ⇒ 503, không gọi core', async () => {
    const err = await makeService({ llm: null })
      .rejectHandoff(viewer, CONV, 'Chưa lên tầng')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as Error).message).toBe(LLM_REJECT_NOT_CONFIGURED_MESSAGE);
    expect(mocked.rejectHandoffWithAiReply).not.toHaveBeenCalled();
  });

  it('thành công ⇒ core nhận llm + GEMINI_MODEL + hàng đợi outbound; phát conversation.updated; Lark kèm lý do', async () => {
    mocked.rejectHandoffWithAiReply.mockImplementation(async (_db, _viewer, _id, _reason, deps) => {
      order.push('reject');
      expect(deps.llm).toBe(fakeLlm);
      expect(deps.defaultModel).toBe('gemini-default');
      await deps.scheduler.enqueueOutbound('m1', 0);
      return {
        conversation: summary,
        previousAssigneeId: null,
        handoffId: 'h1',
        aiRunId: 'r1',
        systemMessageId: 's1',
        messageIds: ['m1'],
        queued: 1,
      };
    });
    await expect(makeService().rejectHandoff(viewer, CONV, 'Chưa lên tầng')).resolves.toBe(summary);
    expect(mocked.rejectHandoffWithAiReply).toHaveBeenCalledWith(
      expect.anything(),
      viewer,
      CONV,
      'Chưa lên tầng',
      expect.anything(),
    );
    expect(order).toEqual(['reject', 'outbound:m1', 'lark']);
    expect(mocked.loadHandoffActionNotice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'reject', handoffIds: ['h1'], rejectReason: 'Chưa lên tầng' }),
    );
  });

  it('core ném lỗi (AI không soạn được / kênh chặn) ⇒ lỗi trả về, không báo Lark', async () => {
    mocked.rejectHandoffWithAiReply.mockRejectedValue(new core.ChatbotComposeError());
    await expect(makeService().rejectHandoff(viewer, CONV, 'x')).rejects.toThrow(
      'AI không soạn được tin, vui lòng thử lại',
    );
    expect(mocked.loadHandoffActionNotice).not.toHaveBeenCalled();
  });
});
