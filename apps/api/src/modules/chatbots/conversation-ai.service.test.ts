// ConversationAiService.ackHandoff / resolveHandoff: tin bot của nút banner "Cần người" (thứ tự với kick + Lark,
// lỗi không làm hỏng request). Lõi (@dezon/core) giả một phần; DB/hàng đợi giả.
import * as core from '@dezon/core';
import type { Db } from '@dezon/db';
import type { Queue } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config';
import type { RealtimeService } from '../realtime/realtime.service';
import { ConversationAiService } from './conversation-ai.service';

vi.mock('@dezon/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dezon/core')>();
  return {
    ...actual,
    ackHandoff: vi.fn(),
    resolveHandoff: vi.fn(),
    needsChatbotKick: vi.fn(),
    sendHandoffActionMessage: vi.fn(),
    loadHandoffActionNotice: vi.fn(),
  };
});

const mocked = vi.mocked(core);
const CONV = 'c0000000-0000-4000-8000-000000000001';
const viewer: core.Viewer = { id: 'u1', role: 'agent' };
const summary = { id: CONV, assignedUser: null } as unknown as core.UpdateConversationResult['conversation'];

let order: string[];
let outboundAdds: { name: string; data: unknown; opts: unknown }[];

function makeService(opts: { outboundFails?: boolean } = {}) {
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
    { APP_URL: 'https://inbox.test' } as AppConfig,
    {} as core.CredentialsCipher,
    vi.fn() as unknown as typeof fetch,
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
