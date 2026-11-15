// Test tích hợp "tự trả lại cho bot khi AI hoạt động lại": lượt AI lỗi phía AI (402 hết tiền…) ⇒ handoff auto_resume;
// job định kỳ resumeAiOutageHandoffs gọi thử AI rồi trả lại hội thoại cho bot. Postgres thật, LLM/Redis/scheduler giả.
import {
  aiRuns,
  auditLogs,
  chatbots,
  conversations,
  handoffs,
  messages,
  type ChannelAccount,
  type Chatbot,
  type NewConversation,
} from '@dezon/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AI_AUTO_RESUME_LOCK_KEY,
  AI_AUTO_RESUME_SYSTEM_TEXT,
  listAiOutageResumeCandidates,
  resumeAiOutageHandoffs,
} from '../src/ai/auto-resume';
import { LlmError } from '../src/ai/llm';
import { LARK_AI_OUTAGE_NOTE } from '../src/ai/lark';
import { rejectHandoffWithAiReply } from '../src/ai/handoff-reject';
import { escalateConversation, processAiReplyJob, processHandoffReminderJob } from '../src/ai/runtime';
import { ackHandoff, resolveHandoff } from '../src/ai/service';
import { putAiSettings } from '../src/ai/settings';
import { loadPendingMessages, loadTurnHistory } from '../src/ai/turn-input';
import { getConversationSummary } from '../src/inbox/queries';
import { createAiKit, llmReply, type AiTestKit } from './helpers/ai-fakes';
import {
  addMessage,
  createChannel,
  createConversation,
  HOUR,
  makeCtx,
  startTestDb,
  type TestDb,
} from './inbox-fixtures';

let t: TestDb;
let channel: ChannelAccount;
let kit: AiTestKit;
const ctx = makeCtx();
const DAY = 24 * HOUR;
const BILLING =
  'Gemini HTTP 402: Your prepayment credits are depleted. Please go to AI Studio to manage your billing.';
const noReply = () => ({
  functionCall: { name: 'no_reply', args: { reason: 'ok' } },
  text: null,
  usage: { inputTokens: 5, outputTokens: 1 },
  model: 'gemini-test',
});

async function createBot(values: Partial<typeof chatbots.$inferInsert> = {}): Promise<Chatbot> {
  const [bot] = await t.db
    .insert(chatbots)
    .values({ name: `Bot ${Math.random().toString(36).slice(2, 8)}`, ...values })
    .returning();
  return bot!;
}

async function botConversation(bot: Chatbot, extra: Partial<NewConversation> = {}) {
  return createConversation(t.db, {
    channel,
    contactName: 'Anh Tú',
    chatbotId: bot.id,
    aiMode: 'auto',
    lastCustomerMessageAt: new Date(),
    ...extra,
  });
}

const messagesOf = (conversationId: string) =>
  t.db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.sentAt), asc(messages.id));

const handoffsOf = (conversationId: string) =>
  t.db
    .select()
    .from(handoffs)
    .where(eq(handoffs.conversationId, conversationId))
    .orderBy(asc(handoffs.createdAt));

const convOf = async (id: string) =>
  (await t.db.select().from(conversations).where(eq(conversations.id, id)))[0]!;

/** Hội thoại có bot + một tin khách, rồi AI tự chuyển người vì lỗi phía AI (auto_resume). */
async function outageConversation(
  bot: Chatbot,
  opts: { extra?: Partial<NewConversation>; customerAt?: Date; autoResume?: boolean } = {},
) {
  const conv = await botConversation(bot, opts.extra);
  const msgId = await addMessage(t.db, conv, {
    text: 'Báo giá tủ bếp giúp em',
    sentAt: opts.customerAt ?? new Date(Date.now() - 60_000),
  });
  const escalated = await escalateConversation(t.db, kit.deps, conv.id, {
    reasonCode: 'other',
    summary: `Lỗi gọi AI: ${BILLING}`,
    createdBy: 'ai',
    autoResume: opts.autoResume ?? true,
  });
  return { conv, msgId, handoffId: escalated.handoffId };
}

beforeAll(async () => {
  t = await startTestDb();
  channel = await createChannel(t.db, { displayName: 'Fanpage Nội Thất' });
});

afterAll(async () => {
  await t?.stop();
});

beforeEach(async () => {
  kit = createAiKit(ctx);
  // Mỗi test tự tạo ứng viên: đóng handoff còn mở của test trước (job quét toàn bảng).
  await t.db.update(handoffs).set({ resolvedAt: new Date() }).where(isNull(handoffs.resolvedAt));
  await putAiSettings(t.db, t.admin.id, { enabled: true });
});

describe('lượt AI lỗi ⇒ handoff auto_resume', () => {
  it('Gemini 402 (hết tiền) ⇒ handoff auto_resume = true, tóm tắt giữ "Lỗi gọi AI: …", Lark có ghi chú lỗi AI', async () => {
    const bot = await createBot({ handoffReminderMin: 10 });
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'Shop ơi', sentAt: new Date(Date.now() - 5_000) });
    kit.llm.impl = async () => {
      throw new LlmError(BILLING, false, 402);
    };
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'done', decision: 'error' });
    const [h] = await handoffsOf(conv.id);
    expect(h).toMatchObject({ autoResume: true, createdBy: 'ai', resolvedAt: null });
    expect(h!.summary.startsWith('Lỗi gọi AI: Gemini HTTP 402')).toBe(true);
    expect(await convOf(conv.id)).toMatchObject({ status: 'pending_human', aiMode: 'off' });
    expect(JSON.stringify(kit.lark.calls.at(-1)?.body)).toContain(LARK_AI_OUTAGE_NOTE);
    // Read model: banner biết là lỗi AI.
    expect((await getConversationSummary(t.db, conv.id, ctx)).handoff).toMatchObject({ autoResume: true });
    // Nhắc lại (chưa ai nhận) vẫn gửi, kèm ghi chú lỗi AI.
    kit.lark.calls.length = 0;
    expect(
      await processHandoffReminderJob(t.db, kit.deps, { conversationId: conv.id, handoffId: h!.id }),
    ).toBe(true);
    expect(JSON.stringify(kit.lark.calls[0]?.body)).toContain(LARK_AI_OUTAGE_NOTE);
  });

  it('AI trả kết quả không dùng được (tham số sai) ⇒ handoff auto_resume = false; read model không có autoResume', async () => {
    const bot = await createBot();
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'Shop ơi', sentAt: new Date(Date.now() - 5_000) });
    kit.llm.impl = async () => ({
      ...llmReply([]),
      functionCall: { name: 'reply', args: { messages: 'sai' } },
    });
    expect(await processAiReplyJob(t.db, kit.deps, conv.id)).toMatchObject({ decision: 'error' });
    const [h] = await handoffsOf(conv.id);
    expect(h).toMatchObject({ autoResume: false, resolvedAt: null });
    expect(JSON.stringify(kit.lark.calls.at(-1)?.body)).not.toContain(LARK_AI_OUTAGE_NOTE);
    expect((await getConversationSummary(t.db, conv.id, ctx)).handoff).not.toHaveProperty('autoResume');
  });

  it('bot "continue": handoff lỗi AI đang mở mà AI báo thêm yêu cầu THẬT ⇒ tắt auto_resume', async () => {
    const bot = await createBot({ aiHandoffMode: 'continue' });
    const { conv, handoffId } = await outageConversation(bot);
    expect(await convOf(conv.id)).toMatchObject({ status: 'pending_human', aiMode: 'auto' });
    await escalateConversation(t.db, kit.deps, conv.id, {
      reasonCode: 'discount',
      summary: 'Khách xin giảm giá',
      createdBy: 'ai',
    });
    const [h] = await handoffsOf(conv.id);
    expect(h).toMatchObject({ id: handoffId, autoResume: false });
  });
});

describe('resumeAiOutageHandoffs — job tự trả lại cho bot', () => {
  it('không có ứng viên ⇒ không gọi AI', async () => {
    const bot = await createBot();
    await outageConversation(bot, { autoResume: false });
    const r = await resumeAiOutageHandoffs(t.db, kit.deps);
    expect(r).toMatchObject({ candidates: 0, resumed: 0 });
    expect(kit.llm.calls).toHaveLength(0);
    expect(kit.redis.store.has(AI_AUTO_RESUME_LOCK_KEY)).toBe(false);
  });

  it('AI vẫn lỗi (gọi thử hỏng) ⇒ không đổi gì; gọi thử một lần mỗi model', async () => {
    const bot = await createBot();
    const other = await createBot({ model: 'gemini-khac' });
    const a = await outageConversation(bot);
    const b = await outageConversation(bot);
    const c = await outageConversation(other);
    kit.llm.impl = async () => {
      throw new LlmError(BILLING, false, 402);
    };
    const r = await resumeAiOutageHandoffs(t.db, kit.deps);
    expect(r).toMatchObject({ candidates: 3, resumed: 0, probedOk: [] });
    expect([...r.probeFailed].sort()).toEqual(['gemini-default', 'gemini-khac']);
    expect(kit.llm.calls.map((x) => x.model).sort()).toEqual(['gemini-default', 'gemini-khac']);
    // Lời gọi thử rẻ: chỉ tool no_reply, timeout ngắn.
    expect(kit.llm.calls[0]!.tools.map((x) => x.name)).toEqual(['no_reply']);
    expect(kit.llm.calls[0]!.timeoutMs).toBeLessThanOrEqual(15_000);
    for (const x of [a, b, c]) {
      expect(await convOf(x.conv.id)).toMatchObject({ status: 'pending_human', aiMode: 'off' });
      expect((await handoffsOf(x.conv.id))[0]).toMatchObject({ resolvedAt: null });
    }
    expect(kit.scheduler.replies).toEqual([]);
  });

  it('AI hoạt động lại ⇒ trả lại cho bot như nút "trả lại cho AI" (không gửi tin nút), tin system, audit, bot trả lời tin chờ; chạy lại idempotent', async () => {
    const bot = await createBot({ handoffResolveMessage: 'Dạ em quay lại hỗ trợ anh ạ', replyDelaySec: 3 });
    // Lượt thật: AI lỗi 402 ⇒ tin khách bị lượt lỗi "nuốt" (trigger) — sau khi trả lại, bot phải trả lời tin đó.
    const conv = await botConversation(bot);
    const msgId = await addMessage(t.db, conv, {
      text: 'Báo giá giúp em',
      sentAt: new Date(Date.now() - 60_000),
    });
    kit.llm.impl = async () => {
      throw new LlmError(BILLING, false, 402);
    };
    await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(await loadPendingMessages(t.db, conv.id)).toEqual([]);
    const [h] = await handoffsOf(conv.id);
    expect(h!.autoResume).toBe(true);

    kit.llm.calls.length = 0;
    kit.publisher.events.length = 0;
    kit.lark.calls.length = 0;
    kit.llm.impl = async () => noReply();
    const r = await resumeAiOutageHandoffs(t.db, kit.deps);
    expect(r).toMatchObject({ candidates: 1, resumed: 1, kicked: 1, probedOk: ['gemini-default'] });
    expect(kit.llm.calls).toHaveLength(1);

    expect(await convOf(conv.id)).toMatchObject({
      status: 'open',
      aiMode: 'auto',
      aiPausedUntil: null,
      handoffReason: null,
      handoffAt: null,
    });
    const [after] = await handoffsOf(conv.id);
    expect(after!.resolvedAt).not.toBeNull();
    expect(after!.acknowledgedBy).toBeNull();
    const msgs = await messagesOf(conv.id);
    // Không gửi tin "trả lại" của bot cho khách; có tin system cho nhân viên.
    expect(msgs.filter((m) => m.senderType === 'bot')).toEqual([]);
    expect(msgs.filter((m) => m.senderType === 'system').map((m) => m.text)).toContain(
      AI_AUTO_RESUME_SYSTEM_TEXT,
    );
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'handoff.auto_resume'), eq(auditLogs.entityId, conv.id)));
    expect(audit).toMatchObject({ userId: null, entity: 'conversation' });
    expect(audit!.data).toMatchObject({ handoffId: h!.id, aiMode: 'auto' });
    // Không báo Lark (không phải nhân viên bấm nút).
    expect(kit.lark.calls).toEqual([]);
    const events = kit.publisher.events.map((e) => e.event);
    expect(events).toContain('conversation.updated');
    expect(events).toContain('message.created');
    // Khách đang chờ, cửa sổ còn mở ⇒ lên lịch bot trả lời; tin khách lượt lỗi lại là tin chưa xử lý.
    expect(kit.scheduler.replies).toEqual([{ conversationId: conv.id, delayMs: 3_000 }]);
    expect((await loadPendingMessages(t.db, conv.id)).map((m) => m.id)).toEqual([msgId]);
    // Lịch sử của bot không có dòng "nhân viên đã xử lý xong" của handoff lỗi AI.
    const { history } = await loadTurnHistory(t.db, conv.id, new Set([msgId]));
    expect(history.filter((x) => x.role === 'system')).toEqual([]);
    const [run] = await t.db.select().from(aiRuns).where(eq(aiRuns.conversationId, conv.id));
    expect(run!.triggerMessageIds).toEqual([]);
    // Bot trả lời được tin đó (lượt đánh thức).
    kit.llm.impl = async () => llmReply(['Dạ em gửi báo giá ạ']);
    expect(await processAiReplyJob(t.db, kit.deps, conv.id)).toMatchObject({ decision: 'reply' });

    // Chạy lại: không còn ứng viên, không gọi AI.
    kit.llm.calls.length = 0;
    const again = await resumeAiOutageHandoffs(t.db, kit.deps);
    expect(again).toMatchObject({ candidates: 0, resumed: 0 });
    expect(kit.llm.calls).toHaveLength(0);
  });

  it('khách quá cửa sổ 24 giờ ⇒ vẫn trả lại cho bot nhưng không đánh thức', async () => {
    const bot = await createBot();
    const { conv } = await outageConversation(bot, {
      extra: { lastCustomerMessageAt: new Date(Date.now() - 30 * HOUR) },
      customerAt: new Date(Date.now() - 30 * HOUR),
    });
    kit.llm.impl = async () => noReply();
    const r = await resumeAiOutageHandoffs(t.db, kit.deps);
    expect(r).toMatchObject({ resumed: 1, kicked: 0 });
    expect(await convOf(conv.id)).toMatchObject({ status: 'open', aiMode: 'auto' });
    expect(kit.scheduler.replies).toEqual([]);
  });

  it('tin cuối là của bên mình (khách không chờ) ⇒ không đánh thức', async () => {
    const bot = await createBot();
    const { conv } = await outageConversation(bot);
    await addMessage(t.db, conv, { senderType: 'bot', text: 'Dạ', status: 'sent', sentAt: new Date() });
    kit.llm.impl = async () => noReply();
    expect(await resumeAiOutageHandoffs(t.db, kit.deps)).toMatchObject({
      resumed: 1,
      kicked: 0,
    });
    expect(kit.scheduler.replies).toEqual([]);
  });

  it('chọn ứng viên: bỏ handoff đã nhận / có tin nhân viên sau / bot gỡ / bot tắt / quá 14 ngày / tạm dừng AI', async () => {
    const bot = await createBot();
    const off = await createBot();
    const ok = await outageConversation(bot);
    const acked = await outageConversation(bot);
    await ackHandoff(t.db, t.agent, acked.conv.id, ctx);
    const agentWrote = await outageConversation(bot);
    await addMessage(t.db, agentWrote.conv, {
      senderType: 'agent',
      senderUserId: t.agent.id,
      text: 'Em xử lý nhé',
      status: 'sent',
      sentAt: new Date(),
    });
    // Echo tự động của Page (lời chào…) không tính là nhân viên.
    const echoOnly = await outageConversation(bot);
    await addMessage(t.db, echoOnly.conv, {
      senderType: 'agent',
      text: 'Cảm ơn bạn đã nhắn tin',
      status: 'sent',
      raw: { automatedEcho: true },
      sentAt: new Date(),
    });
    const detached = await outageConversation(bot);
    await t.db.update(conversations).set({ chatbotId: null }).where(eq(conversations.id, detached.conv.id));
    const inactive = await outageConversation(off);
    await t.db.update(chatbots).set({ isActive: false }).where(eq(chatbots.id, off.id));
    const old = await outageConversation(bot);
    await t.db
      .update(handoffs)
      .set({ createdAt: new Date(Date.now() - 15 * DAY) })
      .where(eq(handoffs.id, old.handoffId));
    const paused = await outageConversation(bot);
    await t.db
      .update(conversations)
      .set({ aiPausedUntil: new Date(Date.now() + HOUR) })
      .where(eq(conversations.id, paused.conv.id));

    const ids = (await listAiOutageResumeCandidates(t.db, new Date())).map((c) => c.handoffId).sort();
    expect(ids).toEqual([ok.handoffId, echoOnly.handoffId].sort());

    kit.llm.impl = async () => noReply();
    const r = await resumeAiOutageHandoffs(t.db, kit.deps);
    expect(r).toMatchObject({ candidates: 2, resumed: 2 });
    for (const x of [acked, agentWrote, detached, inactive, old, paused]) {
      expect((await convOf(x.conv.id)).status).toBe('pending_human');
    }
  });

  it('bot có tin chuyển người (handoffMessage) đã gửi lúc AI lỗi ⇒ vẫn đánh thức bot trả lời tin khách lượt lỗi', async () => {
    const bot = await createBot({ handoffMessage: 'Dạ em chuyển nhân viên hỗ trợ anh ạ', replyDelaySec: 2 });
    const conv = await botConversation(bot);
    const msgId = await addMessage(t.db, conv, {
      text: 'Báo giá giúp em',
      sentAt: new Date(Date.now() - 60_000),
    });
    kit.llm.impl = async () => {
      throw new LlmError(BILLING, false, 402);
    };
    await processAiReplyJob(t.db, kit.deps, conv.id);
    // Tin chuyển người của lượt lỗi là tin cuối (bot).
    const before = await messagesOf(conv.id);
    expect(before.filter((m) => m.senderType !== 'system').at(-1)).toMatchObject({
      senderType: 'bot',
      text: 'Dạ em chuyển nhân viên hỗ trợ anh ạ',
    });
    kit.llm.impl = async () => noReply();
    const r = await resumeAiOutageHandoffs(t.db, kit.deps);
    expect(r).toMatchObject({ resumed: 1, kicked: 1 });
    expect(kit.scheduler.replies).toEqual([{ conversationId: conv.id, delayMs: 2_000 }]);
    expect((await loadPendingMessages(t.db, conv.id)).map((m) => m.id)).toEqual([msgId]);
  });

  it('nhân viên bấm "Không đạt" trên handoff lỗi AI ⇒ tắt auto_resume, job không trả lại cho bot', async () => {
    const bot = await createBot();
    const { conv, handoffId } = await outageConversation(bot);
    kit.llm.impl = async () => llmReply(['Dạ hồ sơ lần này chưa đạt ạ']);
    await rejectHandoffWithAiReply(t.db, t.agent, conv.id, 'chưa đủ ảnh', {
      ctx,
      publisher: kit.publisher,
      logger: kit.deps.logger,
      scheduler: kit.scheduler,
      random: () => 0.5,
      llm: kit.llm,
      defaultModel: 'gemini-default',
      sleep: async () => undefined,
    });
    expect((await handoffsOf(conv.id))[0]).toMatchObject({
      id: handoffId,
      autoResume: false,
      resolvedAt: null,
    });
    expect((await getConversationSummary(t.db, conv.id, ctx)).handoff).not.toHaveProperty('autoResume');
    kit.llm.impl = async () => noReply();
    expect(await resumeAiOutageHandoffs(t.db, kit.deps)).toMatchObject({ candidates: 0, resumed: 0 });
    expect((await convOf(conv.id)).status).toBe('pending_human');
  });

  it('banner / nhắc Lark chỉ hứa "tự trả lại" khi job còn trả lại: nhân viên nhắn khách hoặc gỡ bot ⇒ thôi', async () => {
    const bot = await createBot({ handoffReminderMin: 10 });
    const agentWrote = await outageConversation(bot);
    expect((await getConversationSummary(t.db, agentWrote.conv.id, ctx)).handoff).toMatchObject({
      autoResume: true,
    });
    await addMessage(t.db, agentWrote.conv, {
      senderType: 'agent',
      senderUserId: t.agent.id,
      text: 'Em xử lý nhé',
      status: 'sent',
      sentAt: new Date(),
    });
    expect((await getConversationSummary(t.db, agentWrote.conv.id, ctx)).handoff).not.toHaveProperty(
      'autoResume',
    );
    kit.lark.calls.length = 0;
    expect(
      await processHandoffReminderJob(t.db, kit.deps, {
        conversationId: agentWrote.conv.id,
        handoffId: agentWrote.handoffId,
      }),
    ).toBe(true);
    expect(JSON.stringify(kit.lark.calls[0]?.body)).not.toContain(LARK_AI_OUTAGE_NOTE);

    const detached = await outageConversation(bot);
    await t.db.update(conversations).set({ chatbotId: null }).where(eq(conversations.id, detached.conv.id));
    expect((await getConversationSummary(t.db, detached.conv.id, ctx)).handoff).not.toHaveProperty(
      'autoResume',
    );
  });

  it('chống vòng lặp: vừa tự trả lại trong 60 phút ⇒ chờ; đã 3 lần trong 24 giờ ⇒ thôi', async () => {
    const bot = await createBot();
    kit.llm.impl = async () => noReply();
    // Lần 1: trả lại; AI lại lỗi ngay ⇒ handoff lỗi AI mới.
    const first = await outageConversation(bot);
    expect(await resumeAiOutageHandoffs(t.db, kit.deps)).toMatchObject({
      resumed: 1,
    });
    const conv = first.conv;
    const again = await escalateConversation(t.db, kit.deps, conv.id, {
      reasonCode: 'other',
      summary: `Lỗi gọi AI: ${BILLING}`,
      createdBy: 'ai',
      autoResume: true,
    });
    const ids = async (at: Date) => (await listAiOutageResumeCandidates(t.db, at)).map((c) => c.handoffId);
    expect(await ids(new Date())).toEqual([]);
    // Hết 60 phút chờ ⇒ được trả lại lần nữa.
    expect(await ids(new Date(Date.now() + 61 * 60_000))).toEqual([again.handoffId]);

    // Đã tự trả lại 3 lần trong 24 giờ (2 h, 3 h, 4 h trước) ⇒ thôi, để nhân viên.
    await t.db
      .update(handoffs)
      .set({ resolvedAt: new Date(Date.now() - 2 * HOUR) })
      .where(eq(handoffs.id, first.handoffId));
    const older: string[] = [];
    for (const hoursAgo of [3, 4]) {
      const [h] = await t.db
        .insert(handoffs)
        .values({
          conversationId: conv.id,
          reasonCode: 'other',
          summary: 'Lỗi gọi AI: cũ',
          createdBy: 'ai',
          autoResume: true,
          resolvedAt: new Date(Date.now() - hoursAgo * HOUR),
        })
        .returning({ id: handoffs.id });
      older.push(h!.id);
    }
    expect(await ids(new Date())).toEqual([]);
    // Một lần đã quá 24 giờ ⇒ còn 2 lần ⇒ lại được trả lại.
    await t.db
      .update(handoffs)
      .set({ resolvedAt: new Date(Date.now() - 25 * HOUR) })
      .where(eq(handoffs.id, older[1]!));
    expect(await ids(new Date())).toEqual([again.handoffId]);
  });

  it('AI tổng tắt ⇒ không làm gì, không gọi AI', async () => {
    const bot = await createBot();
    const { conv } = await outageConversation(bot);
    await putAiSettings(t.db, t.admin.id, { enabled: false });
    kit.llm.impl = async () => noReply();
    expect(await resumeAiOutageHandoffs(t.db, kit.deps)).toMatchObject({
      candidates: 0,
      resumed: 0,
    });
    expect(kit.llm.calls).toHaveLength(0);
    expect((await convOf(conv.id)).status).toBe('pending_human');
  });

  it('nhân viên vừa "trả lại cho AI" giữa lúc quét và lúc trả lại ⇒ bỏ qua (kiểm lại dưới khóa)', async () => {
    const bot = await createBot();
    const { conv, handoffId } = await outageConversation(bot);
    kit.llm.impl = async (req) => {
      // Nhân viên bấm nút đúng lúc AI đang được gọi thử.
      if (req.tools.length === 1) await resolveHandoff(t.db, t.agent, conv.id, ctx);
      return noReply();
    };
    const r = await resumeAiOutageHandoffs(t.db, kit.deps);
    expect(r).toMatchObject({ candidates: 1, resumed: 0, skipped: 1 });
    const [h] = await handoffsOf(conv.id);
    expect(h).toMatchObject({ id: handoffId, acknowledgedBy: t.agent.id });
    const audits = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'handoff.auto_resume'), eq(auditLogs.entityId, conv.id)));
    expect(audits).toEqual([]);
  });

  it('lượt khác đang giữ khóa ⇒ không làm gì', async () => {
    const bot = await createBot();
    await outageConversation(bot);
    await kit.redis.set(AI_AUTO_RESUME_LOCK_KEY, 'khac', 'PX', 60_000, 'NX');
    expect(await resumeAiOutageHandoffs(t.db, kit.deps)).toMatchObject({
      locked: true,
      candidates: 0,
    });
    expect(kit.llm.calls).toHaveLength(0);
    expect(kit.redis.store.get(AI_AUTO_RESUME_LOCK_KEY)).toBe('khac');
  });

  it('giãn cách lượt bot được đánh thức (độ trễ job, không ngủ trong job); giới hạn số hội thoại mỗi lượt', async () => {
    const bot = await createBot({ replyDelaySec: 3 });
    const a = await outageConversation(bot);
    const b = await outageConversation(bot);
    await outageConversation(bot);
    kit.llm.impl = async () => noReply();
    const r = await resumeAiOutageHandoffs(t.db, kit.deps, { limit: 2, spacingMs: 1_500 });
    expect(r).toMatchObject({ candidates: 2, resumed: 2, kicked: 2 });
    expect(kit.scheduler.replies).toEqual([
      { conversationId: a.conv.id, delayMs: 3_000 },
      { conversationId: b.conv.id, delayMs: 4_500 },
    ]);
    expect(await resumeAiOutageHandoffs(t.db, kit.deps)).toMatchObject({
      candidates: 1,
      resumed: 1,
    });
  });
});
