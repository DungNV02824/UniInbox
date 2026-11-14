// Nút "Không đạt" trên banner "Cần người": AI (bot đang gắn) soạn tin báo khách lần gửi chưa đạt rồi gửi thẳng; yêu
// cầu chuyển người giữ nguyên. Postgres thật (Testcontainers); LLM/scheduler/publisher giả.
import {
  aiRuns,
  auditLogs,
  chatbots,
  conversations,
  handoffs,
  messages,
  type ChannelAccount,
  type Chatbot,
} from '@dezon/db';
import { HANDOFF_REJECT_LIMITS } from '@dezon/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ChatbotComposeError } from '../src/ai/errors';
import {
  HANDOFF_REJECT_NO_BOT,
  HANDOFF_REJECT_NO_OPEN,
  STAFF_REJECT_TOOL_LOG,
  handoffRejectSystemText,
  rejectHandoffWithAiReply,
  type RejectHandoffDeps,
} from '../src/ai/handoff-reject';
import { loadHandoffActionNotice } from '../src/ai/handoff-action';
import { LlmError } from '../src/ai/llm';
import { loadPendingMessages } from '../src/ai/turn-input';
import { InboxForbiddenError, InboxValidationError, SendNotAllowedError } from '../src/inbox/errors';
import { createAiKit, llmReply, type AiTestKit } from './helpers/ai-fakes';
import {
  addMessage,
  ago,
  createChannel,
  createConversation,
  HOUR,
  makeCtx,
  startTestDb,
  type TestDb,
} from './inbox-fixtures';

const MIN = 60_000;
const REASON = 'công trình mới làm móng, chưa lên tầng; công trình dự án lớn không nghiệm thu';

let t: TestDb;
let channel: ChannelAccount;
let kit: AiTestKit;
const ctx = makeCtx();

beforeAll(async () => {
  t = await startTestDb();
  channel = await createChannel(t.db);
});

afterAll(async () => {
  await t?.stop();
});

beforeEach(() => {
  kit = createAiKit(ctx);
});

function deps(): RejectHandoffDeps {
  return {
    ctx,
    publisher: kit.publisher,
    logger: kit.deps.logger,
    scheduler: kit.scheduler,
    random: () => 0.5,
    llm: kit.llm,
    defaultModel: 'gemini-default',
    sleep: async () => undefined,
  };
}

async function createBot(values: Partial<typeof chatbots.$inferInsert> = {}): Promise<Chatbot> {
  const [bot] = await t.db
    .insert(chatbots)
    .values({
      name: `Vua Thầu ${Math.random().toString(36).slice(2, 8)}`,
      instructions: 'Bạn là trợ lý chương trình CTV Vua Thầu. Xưng "em", gọi "anh/chị".',
      knowledge: 'Chỉ nghiệm thu công trình nhà ở dân dụng đã lên tầng.',
      model: 'gemini-vua-thau',
      temperature: 0.3,
      escalateWhenUnsure: true,
      ...values,
    })
    .returning();
  return bot!;
}

/** Hội thoại đang chờ người (như sau escalate) + một handoff mở; khách gửi ảnh lúc `customerAt`. */
async function pendingHuman(
  bot: Chatbot | null,
  opts: { customerAt?: Date; assignedUserId?: string | null; channel?: ChannelAccount } = {},
) {
  const customerAt = opts.customerAt ?? ago(5 * MIN);
  const conv = await createConversation(t.db, {
    channel: opts.channel ?? channel,
    contactName: 'Anh Tùng',
    chatbotId: bot?.id ?? null,
    aiMode: 'off',
    status: 'pending_human',
    handoffReason: 'other',
    handoffAt: ago(4 * MIN),
    assignedUserId: opts.assignedUserId ?? null,
    lastCustomerMessageAt: customerAt,
    lastMessageAt: customerAt,
  });
  await addMessage(t.db, conv, { sentAt: customerAt, text: 'Em gửi ảnh công trình nhà anh Ba ạ' });
  await addMessage(t.db, conv, {
    sentAt: new Date(customerAt.getTime() + 1000),
    senderType: 'bot',
    text: 'Dạ em đã chuyển hồ sơ cho bộ phận kiểm tra ạ',
    status: 'sent',
  });
  const [handoff] = await t.db
    .insert(handoffs)
    .values({
      conversationId: conv.id,
      reasonCode: 'other',
      summary: 'CTV gửi 6 ảnh nhà anh Ba',
      createdBy: 'ai',
    })
    .returning();
  return { conv, handoff: handoff! };
}

const rows = (conversationId: string) =>
  t.db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.sentAt), asc(messages.id));

const lastPartText = (req: { contents: { parts: unknown[] }[] }) => {
  const last = req.contents[req.contents.length - 1]!;
  const part = last.parts[last.parts.length - 1] as { text?: string };
  return part.text ?? '';
};

describe('rejectHandoffWithAiReply — thành công', () => {
  it('AI (bot đang gắn) soạn tin ⇒ gửi thẳng tin bot + tin system; handoff/hội thoại giữ nguyên; audit không ghi lý do', async () => {
    const bot = await createBot();
    const { conv, handoff } = await pendingHuman(bot);
    // Độ tự tin thấp (bot escalateWhenUnsure) vẫn KHÔNG thành escalate.
    kit.llm.impl = async () =>
      llmReply(
        [
          'Dạ em cảm ơn anh đã gửi ảnh công trình ạ.',
          'Tiếc là lần này công trình chưa đạt vì mới làm móng, chưa lên tầng ạ.',
          'Khi công trình lên tầng anh gửi lại giúp em nhé.',
        ],
        0.2,
      );

    const result = await rejectHandoffWithAiReply(t.db, t.agent, conv.id, `  ${REASON}  `, deps());

    // Gọi LLM đúng persona/model/nhiệt độ của bot, chỉ tool reply, lý do ở khối chỉ dẫn cuối prompt.
    expect(kit.llm.calls).toHaveLength(1);
    const req = kit.llm.calls[0]!;
    expect(req.model).toBe('gemini-vua-thau');
    expect(req.temperature).toBe(0.3);
    expect(req.tools.map((tool) => tool.name)).toEqual(['reply']);
    expect(req.systemInstruction).toContain('chương trình CTV Vua Thầu');
    expect(req.systemInstruction).toContain('Chỉ nghiệm thu công trình nhà ở dân dụng');
    expect(req.systemInstruction).not.toContain(REASON);
    const note = lastPartText(req);
    expect(note).toContain('KHÔNG ĐẠT');
    expect(note).toContain(REASON);
    // Lịch sử hội thoại có trong prompt.
    expect(JSON.stringify(req.contents)).toContain('Em gửi ảnh công trình nhà anh Ba');

    const all = await rows(conv.id);
    const system = all.filter((m) => m.senderType === 'system');
    const bots = all.filter((m) => m.senderType === 'bot' && m.status === 'queued');
    expect(system.map((m) => m.text)).toEqual([handoffRejectSystemText('Hương', REASON)]);
    expect(system[0]!.text).toBe(`Nhân viên Hương đánh dấu Không đạt: ${REASON}`);
    expect(bots.map((m) => m.text)).toEqual([
      'Dạ em cảm ơn anh đã gửi ảnh công trình ạ.',
      'Tiếc là lần này công trình chưa đạt vì mới làm móng, chưa lên tầng ạ.',
      'Khi công trình lên tầng anh gửi lại giúp em nhé.',
    ]);
    expect(bots.every((m) => m.aiRunId === result.aiRunId)).toBe(true);
    // Tin system đứng trước các tin bot.
    expect(system[0]!.sentAt.getTime()).toBeLessThan(bots[0]!.sentAt.getTime());
    expect(result.systemMessageId).toBe(system[0]!.id);
    expect(result.messageIds).toEqual(bots.map((m) => m.id));
    expect(result.queued).toBe(3);
    expect(result.handoffId).toBe(handoff.id);
    expect(kit.scheduler.outbound.map((o) => o.messageId)).toEqual(bots.map((m) => m.id));
    expect(kit.scheduler.outbound[0]!.delayMs).toBe(0);
    expect(kit.scheduler.outbound[1]!.delayMs).toBeGreaterThan(0);
    const created = kit.publisher.events
      .filter((e) => e.event === 'message.created')
      .map((e) => (e.payload as { message: { id: string } }).message.id);
    expect(created).toEqual([system[0]!.id, ...bots.map((m) => m.id)]);

    // Yêu cầu chuyển người + hội thoại giữ nguyên; không tạo handoff mới; không tạm dừng bot.
    const allHandoffs = await t.db.select().from(handoffs).where(eq(handoffs.conversationId, conv.id));
    expect(allHandoffs).toHaveLength(1);
    expect(allHandoffs[0]).toMatchObject({ resolvedAt: null, acknowledgedBy: null, acknowledgedAt: null });
    const [after] = await t.db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(after).toMatchObject({
      status: 'pending_human',
      aiMode: 'off',
      aiPausedUntil: null,
      assignedUserId: null,
      chatbotId: bot.id,
      handoffReason: 'other',
    });
    expect(after!.lastMessageAt!.getTime()).toBeGreaterThanOrEqual(bots[2]!.sentAt.getTime());
    expect(result.conversation.status).toBe('pending_human');

    // Audit: chỉ độ dài lý do.
    const audits = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, conv.id), eq(auditLogs.action, 'handoff.reject')));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.userId).toBe(t.agent.id);
    expect(audits[0]!.data).toMatchObject({ handoffId: handoff.id, reasonChars: Array.from(REASON).length });
    expect(JSON.stringify(audits[0]!.data)).not.toContain('móng');

    // ai_runs: lượt 'reply', trigger = tin khách chưa xử lý AI đã thấy, "Nhật ký AI" thấy được.
    const [run] = await t.db.select().from(aiRuns).where(eq(aiRuns.id, result.aiRunId));
    const customerIds = all.filter((m) => m.senderType === 'customer').map((m) => m.id);
    expect(run).toMatchObject({
      decision: 'reply',
      chatbotId: bot.id,
      triggerMessageIds: customerIds,
      error: null,
    });
    expect((run!.toolCalls as { name: string; args: unknown }[])[0]).toEqual({
      name: STAFF_REJECT_TOOL_LOG,
      args: { handoffId: handoff.id, reasonChars: Array.from(REASON).length },
    });
  });
});

describe('rejectHandoffWithAiReply — chống đua với lượt ai-reply (bot "continue")', () => {
  it('tin khách AI đã thấy ⇒ đánh dấu đã xử lý (lượt ai-reply song song bị hủy); tin đến lúc AI đang soạn vẫn chờ', async () => {
    const bot = await createBot({ aiHandoffMode: 'continue' });
    const { conv } = await pendingHuman(bot);
    await t.db.update(conversations).set({ aiMode: 'auto' }).where(eq(conversations.id, conv.id));
    const seenIds = (await loadPendingMessages(t.db, conv.id)).map((m) => m.id);
    expect(seenIds).toHaveLength(1);
    let lateId = '';
    kit.llm.impl = async () => {
      // CTV gửi thêm ảnh trong lúc AI đang soạn tin "Không đạt".
      lateId = await addMessage(t.db, conv, { sentAt: new Date(), text: 'Em gửi thêm ảnh tầng 2 ạ' });
      return llmReply(['Dạ công trình lần này chưa đạt vì mới làm móng, chưa lên tầng ạ.']);
    };

    const result = await rejectHandoffWithAiReply(t.db, t.agent, conv.id, REASON, deps());

    const [run] = await t.db.select().from(aiRuns).where(eq(aiRuns.id, result.aiRunId));
    expect(run!.triggerMessageIds).toEqual(seenIds);
    // raceReason của runtime đọc loadPendingMessages: tin cũ đã xử lý ⇒ lượt đang chạy hủy; tin mới vẫn được trả lời.
    expect((await loadPendingMessages(t.db, conv.id)).map((m) => m.id)).toEqual([lateId]);
    const [after] = await t.db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(after).toMatchObject({ status: 'pending_human', aiMode: 'auto', aiPausedUntil: null });
  });
});

describe('rejectHandoffWithAiReply — không gửi gì', () => {
  it('lỗi gọi AI ⇒ ChatbotComposeError, không tin nào; ai_runs ghi lỗi; handoff vẫn mở', async () => {
    const bot = await createBot();
    const { conv } = await pendingHuman(bot);
    kit.llm.impl = async () => {
      throw new LlmError('Gemini 400', false, 400);
    };
    const before = (await rows(conv.id)).length;

    await expect(rejectHandoffWithAiReply(t.db, t.agent, conv.id, REASON, deps())).rejects.toThrow(
      ChatbotComposeError,
    );
    await expect(rejectHandoffWithAiReply(t.db, t.agent, conv.id, REASON, deps())).rejects.toThrow(
      'AI không soạn được tin, vui lòng thử lại',
    );

    expect(await rows(conv.id)).toHaveLength(before);
    expect(kit.scheduler.outbound).toHaveLength(0);
    expect(kit.publisher.events).toHaveLength(0);
    const runs = await t.db.select().from(aiRuns).where(eq(aiRuns.conversationId, conv.id));
    expect(runs.length).toBe(2);
    expect(runs.every((r) => r.decision === 'error' && r.triggerMessageIds.length === 0)).toBe(true);
    const audits = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, conv.id), eq(auditLogs.action, 'handoff.reject')));
    expect(audits).toHaveLength(0);
    const [h] = await t.db.select().from(handoffs).where(eq(handoffs.conversationId, conv.id));
    expect(h!.resolvedAt).toBeNull();
  });

  it('model vẫn gọi escalate ⇒ ChatbotComposeError, không tạo handoff mới, không gửi', async () => {
    const bot = await createBot();
    const { conv } = await pendingHuman(bot);
    kit.llm.impl = async () => ({
      functionCall: {
        name: 'escalate',
        args: { reason_code: 'other', summary_for_agent: 'x', messages_to_customer: ['Em chuyển ạ'] },
      },
      text: null,
      usage: { inputTokens: 10, outputTokens: 5 },
      model: 'gemini-test',
    });
    await expect(rejectHandoffWithAiReply(t.db, t.agent, conv.id, REASON, deps())).rejects.toThrow(
      ChatbotComposeError,
    );
    expect(await t.db.select().from(handoffs).where(eq(handoffs.conversationId, conv.id))).toHaveLength(1);
    expect((await rows(conv.id)).filter((m) => m.senderType === 'system')).toHaveLength(0);
    expect(kit.scheduler.outbound).toHaveLength(0);
  });

  it('kênh ngoài cửa sổ 24 giờ ⇒ KHÔNG gọi AI; tin system cho nhân viên; SendNotAllowedError', async () => {
    const bot = await createBot();
    const { conv } = await pendingHuman(bot, { customerAt: ago(25 * HOUR) });
    const err = await rejectHandoffWithAiReply(t.db, t.agent, conv.id, REASON, deps()).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SendNotAllowedError);
    expect((err as Error).message).toMatch(/^Không gửi được tin «Không đạt» cho khách: .*24 giờ/);
    expect(kit.llm.calls).toHaveLength(0);
    const all = await rows(conv.id);
    const system = all.filter((m) => m.senderType === 'system');
    expect(system.map((m) => m.text)).toEqual([(err as Error).message]);
    expect(all.filter((m) => m.senderType === 'bot' && m.status === 'queued')).toHaveLength(0);
    expect(kit.scheduler.outbound).toHaveLength(0);
    expect(kit.publisher.events.filter((e) => e.event === 'message.created')).toHaveLength(1);
  });

  it('kênh mất kết nối ⇒ KHÔNG gọi AI, SendNotAllowedError', async () => {
    const offline = await createChannel(t.db, { status: 'disconnected' });
    const { conv } = await pendingHuman(await createBot(), { channel: offline });
    await expect(rejectHandoffWithAiReply(t.db, t.agent, conv.id, REASON, deps())).rejects.toThrow(
      'Không gửi được tin «Không đạt» cho khách: Kênh đang mất kết nối',
    );
    expect(kit.llm.calls).toHaveLength(0);
  });

  it('không có handoff mở / không pending_human ⇒ InboxValidationError, không gọi AI', async () => {
    const bot = await createBot();
    // pending_human nhưng handoff đã đóng.
    const { conv, handoff } = await pendingHuman(bot);
    await t.db.update(handoffs).set({ resolvedAt: new Date() }).where(eq(handoffs.id, handoff.id));
    await expect(rejectHandoffWithAiReply(t.db, t.agent, conv.id, REASON, deps())).rejects.toThrow(
      new InboxValidationError(HANDOFF_REJECT_NO_OPEN),
    );
    // Hội thoại 'open' (handoff còn mở nhưng đã trả lại cho AI) cũng không.
    const other = await pendingHuman(bot);
    await t.db.update(conversations).set({ status: 'open' }).where(eq(conversations.id, other.conv.id));
    await expect(rejectHandoffWithAiReply(t.db, t.agent, other.conv.id, REASON, deps())).rejects.toThrow(
      HANDOFF_REJECT_NO_OPEN,
    );
    expect(kit.llm.calls).toHaveLength(0);
    expect((await rows(conv.id)).filter((m) => m.senderType === 'system')).toHaveLength(0);
  });

  it('không gắn bot / không có quyền / lý do sai ⇒ lỗi, không gọi AI', async () => {
    const noBot = await pendingHuman(null);
    await expect(rejectHandoffWithAiReply(t.db, t.agent, noBot.conv.id, REASON, deps())).rejects.toThrow(
      HANDOFF_REJECT_NO_BOT,
    );
    const bot = await createBot();
    const others = await pendingHuman(bot, { assignedUserId: t.agent2.id });
    await expect(rejectHandoffWithAiReply(t.db, t.agent, others.conv.id, REASON, deps())).rejects.toThrow(
      InboxForbiddenError,
    );
    const mine = await pendingHuman(bot);
    await expect(rejectHandoffWithAiReply(t.db, t.agent, mine.conv.id, '   ', deps())).rejects.toThrow(
      InboxValidationError,
    );
    await expect(
      rejectHandoffWithAiReply(
        t.db,
        t.agent,
        mine.conv.id,
        'a'.repeat(HANDOFF_REJECT_LIMITS.reasonMaxChars + 1),
        deps(),
      ),
    ).rejects.toThrow(InboxValidationError);
    expect(kit.llm.calls).toHaveLength(0);
  });
});

describe('loadHandoffActionNotice — nút "Không đạt"', () => {
  it('bot bật handoff_action_lark ⇒ thẻ có nhãn "Không đạt" + lý do; bot tắt ⇒ null', async () => {
    const bot = await createBot({ handoffActionLark: true, handoffAckLabel: 'Nghiệm thu' });
    const { conv, handoff } = await pendingHuman(bot);
    const notice = await loadHandoffActionNotice(t.db, {
      conversationId: conv.id,
      action: 'reject',
      handoffIds: [handoff.id],
      actorUserId: t.agent.id,
      now: new Date('2026-11-10T07:36:00Z'),
      appUrl: 'https://inbox.test/',
      rejectReason: REASON,
    });
    expect(notice).toMatchObject({
      action: 'reject',
      buttonLabel: 'Không đạt',
      rejectReason: REASON,
      actorName: 'Hương',
      summaries: ['CTV gửi 6 ảnh nhà anh Ba'],
      conversationUrl: `https://inbox.test/inbox/${conv.id}`,
    });
    const quiet = await pendingHuman(await createBot({ handoffActionLark: false }));
    expect(
      await loadHandoffActionNotice(t.db, {
        conversationId: quiet.conv.id,
        action: 'reject',
        handoffIds: [quiet.handoff.id],
        actorUserId: t.agent.id,
        now: new Date(),
        appUrl: 'https://inbox.test',
        rejectReason: REASON,
      }),
    ).toBeNull();
  });
});
