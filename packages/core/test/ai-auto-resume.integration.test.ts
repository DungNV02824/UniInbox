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
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AI_AUTO_RESUME_BATCH,
  AI_AUTO_RESUME_LOCK_KEY,
  AI_AUTO_RESUME_SYSTEM_TEXT,
  AI_MANUAL_RESUME_AUDIT_ACTION,
  countAiMissedReplies,
  countAiOutageWaiting,
  listAiMissedReplies,
  listAiOutageResumeCandidates,
  listAiOutageWaitingModels,
  resumeAiOutageHandoffs,
} from '../src/ai/auto-resume';
import { LlmError } from '../src/ai/llm';
import { LARK_AI_OUTAGE_NOTE } from '../src/ai/lark';
import { rejectHandoffWithAiReply } from '../src/ai/handoff-reject';
import {
  AI_SKIP_DISABLED,
  escalateConversation,
  processAiReplyJob,
  processHandoffReminderJob,
} from '../src/ai/runtime';
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

describe('nút "Bật lại AI" — resumeAiOutageHandoffs({ manual })', () => {
  /** Hội thoại đã tự trả lại một lần (trong cooldown) rồi AI lại lỗi ⇒ handoff lỗi AI mới. */
  async function reEscalatedAfterResume(bot: Chatbot) {
    const first = await outageConversation(bot);
    expect(await resumeAiOutageHandoffs(t.db, kit.deps)).toMatchObject({ resumed: 1 });
    const again = await escalateConversation(t.db, kit.deps, first.conv.id, {
      reasonCode: 'other',
      summary: `Lỗi gọi AI: ${BILLING}`,
      createdBy: 'ai',
      autoResume: true,
    });
    return { conv: first.conv, firstHandoffId: first.handoffId, handoffId: again.handoffId };
  }

  it('bỏ qua cooldown 60 phút: lượt định kỳ chờ, bấm tay trả lại ngay; audit ai.manual_resume ghi người bấm', async () => {
    const bot = await createBot();
    kit.llm.impl = async () => noReply();
    const { conv, handoffId } = await reEscalatedAfterResume(bot);
    expect(await listAiOutageResumeCandidates(t.db, new Date())).toEqual([]);
    expect(await resumeAiOutageHandoffs(t.db, kit.deps)).toMatchObject({ candidates: 0, resumed: 0 });

    const r = await resumeAiOutageHandoffs(t.db, kit.deps, { manual: true, actorUserId: t.agent.id });
    expect(r).toMatchObject({ candidates: 1, resumed: 1 });
    expect((await handoffsOf(conv.id)).find((h) => h.id === handoffId)!.resolvedAt).not.toBeNull();
    expect(await convOf(conv.id)).toMatchObject({ status: 'open', aiMode: 'auto' });
    const [perConv] = await t.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, 'handoff.auto_resume'),
          eq(auditLogs.entityId, conv.id),
          sql`${auditLogs.data} ->> 'handoffId' = ${handoffId}`,
        ),
      );
    expect(perConv!.data).toMatchObject({ manual: true });
    const audits = await t.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, AI_MANUAL_RESUME_AUDIT_ACTION))
      .orderBy(desc(auditLogs.createdAt));
    expect(audits[0]).toMatchObject({ userId: t.agent.id, entity: 'ai' });
    expect(audits[0]!.data).toMatchObject({ resumed: 1, kicked: r.kicked, probeFailed: [] });
    expect(kit.redis.store.has(AI_AUTO_RESUME_LOCK_KEY)).toBe(false);
  });

  it('bỏ qua giới hạn 3 lần / 24 giờ', async () => {
    const bot = await createBot();
    kit.llm.impl = async () => noReply();
    const { conv, firstHandoffId, handoffId } = await reEscalatedAfterResume(bot);
    await t.db
      .update(handoffs)
      .set({ resolvedAt: new Date(Date.now() - 2 * HOUR) })
      .where(eq(handoffs.id, firstHandoffId));
    for (const hoursAgo of [3, 4]) {
      await t.db.insert(handoffs).values({
        conversationId: conv.id,
        reasonCode: 'other',
        summary: 'Lỗi gọi AI: cũ',
        createdBy: 'ai',
        autoResume: true,
        resolvedAt: new Date(Date.now() - hoursAgo * HOUR),
      });
    }
    expect(await listAiOutageResumeCandidates(t.db, new Date(Date.now() + 2 * HOUR))).toEqual([]);
    expect(
      (await listAiOutageResumeCandidates(t.db, new Date(), 50, { manual: true })).map((c) => c.handoffId),
    ).toEqual([handoffId]);
    expect(await resumeAiOutageHandoffs(t.db, kit.deps, { manual: true })).toMatchObject({ resumed: 1 });
    expect((await convOf(conv.id)).status).toBe('open');
  });

  it('vẫn bỏ handoff đã nhận / có tin nhân viên / tạm dừng AI; AI vẫn lỗi ⇒ không trả lại, audit ghi probeFailed', async () => {
    const bot = await createBot();
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
    const ok = await outageConversation(bot);
    expect(
      (await listAiOutageResumeCandidates(t.db, new Date(), 50, { manual: true })).map((c) => c.handoffId),
    ).toEqual([ok.handoffId]);

    kit.llm.impl = async () => {
      throw new LlmError(BILLING, false, 402);
    };
    const failed = await resumeAiOutageHandoffs(t.db, kit.deps, { manual: true, actorUserId: t.admin.id });
    expect(failed).toMatchObject({ candidates: 1, resumed: 0, probeFailed: ['gemini-default'] });
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, AI_MANUAL_RESUME_AUDIT_ACTION))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    expect(audit).toMatchObject({ userId: t.admin.id });
    expect(audit!.data).toMatchObject({ resumed: 0, probeFailed: ['gemini-default'] });

    kit.llm.impl = async () => noReply();
    expect(await resumeAiOutageHandoffs(t.db, kit.deps, { manual: true })).toMatchObject({ resumed: 1 });
    for (const x of [acked, agentWrote]) expect((await convOf(x.conv.id)).status).toBe('pending_human');
    expect((await convOf(ok.conv.id)).status).toBe('open');
  });

  it('xử lý MỌI ứng viên (job định kỳ chỉ AI_AUTO_RESUME_BATCH mỗi lượt)', async () => {
    const bot = await createBot();
    const total = AI_AUTO_RESUME_BATCH + 2;
    for (let i = 0; i < total; i++) {
      const conv = await botConversation(bot, { status: 'pending_human', aiMode: 'off' });
      await t.db.insert(handoffs).values({
        conversationId: conv.id,
        reasonCode: 'other',
        summary: `Lỗi gọi AI: ${BILLING}`,
        createdBy: 'ai',
        autoResume: true,
      });
    }
    expect(await listAiOutageResumeCandidates(t.db, new Date())).toHaveLength(AI_AUTO_RESUME_BATCH);
    kit.llm.impl = async () => noReply();
    expect(await resumeAiOutageHandoffs(t.db, kit.deps, { manual: true })).toMatchObject({
      candidates: total,
      resumed: total,
    });
  });

  it('khóa đang bị giữ ⇒ chờ rồi chạy luôn (không bỏ lần bấm), không gỡ khóa của lượt khác', async () => {
    const bot = await createBot();
    await outageConversation(bot);
    await kit.redis.set(AI_AUTO_RESUME_LOCK_KEY, 'khac', 'PX', 60_000, 'NX');
    kit.llm.impl = async () => noReply();
    const r = await resumeAiOutageHandoffs(t.db, kit.deps, { manual: true, lockWaitMs: 30, lockPollMs: 10 });
    expect(r.locked).toBeUndefined();
    expect(r).toMatchObject({ resumed: 1 });
    expect(kit.redis.store.get(AI_AUTO_RESUME_LOCK_KEY)).toBe('khac');
    kit.redis.store.delete(AI_AUTO_RESUME_LOCK_KEY);
  });

  it('countAiOutageWaiting / listAiOutageWaitingModels: mỗi hội thoại đếm một lần, bỏ hội thoại không còn trả lại được', async () => {
    const before = await countAiOutageWaiting(t.db, new Date());
    expect(before).toBe(0);
    const bot = await createBot();
    const other = await createBot({ model: 'gemini-khac' });
    const a = await outageConversation(bot);
    // Hai handoff lỗi AI mở trên cùng hội thoại ⇒ vẫn đếm 1.
    await t.db.insert(handoffs).values({
      conversationId: a.conv.id,
      reasonCode: 'other',
      summary: 'Lỗi gọi AI: thêm',
      createdBy: 'ai',
      autoResume: true,
    });
    await outageConversation(other);
    const acked = await outageConversation(other);
    await ackHandoff(t.db, t.agent, acked.conv.id, ctx);
    // Tạm dừng AI vẫn đếm (cùng nghĩa banner vàng).
    const paused = await outageConversation(bot);
    await t.db
      .update(conversations)
      .set({ aiPausedUntil: new Date(Date.now() + HOUR) })
      .where(eq(conversations.id, paused.conv.id));
    await outageConversation(bot, { autoResume: false });

    expect(await countAiOutageWaiting(t.db, new Date())).toBe(3);
    expect([...(await listAiOutageWaitingModels(t.db, new Date()))].sort()).toEqual(
      ['gemini-khac', null].sort(),
    );
  });
});

describe('nút "Bật lại AI" — hội thoại bị bỏ sót (khách nhắn, bot chưa trả lời)', () => {
  const MIN = 60_000;
  /** Hội thoại bot đang trực, tin khách cuối cách đây `agoMs`. */
  async function missedConversation(bot: Chatbot, agoMs = 30 * MIN, extra: Partial<NewConversation> = {}) {
    const at = new Date(Date.now() - agoMs);
    const conv = await botConversation(bot, { lastCustomerMessageAt: at, ...extra });
    const msgId = await addMessage(t.db, conv, { text: 'Còn hàng không shop?', sentAt: at });
    return { conv, msgId };
  }

  it('công tắc AI chung tắt ⇒ lượt bot bị bỏ qua mà KHÔNG coi tin khách là đã xử lý', async () => {
    const bot = await createBot();
    const { conv, msgId } = await missedConversation(bot);
    await putAiSettings(t.db, t.admin.id, { enabled: false });
    expect(await processAiReplyJob(t.db, kit.deps, conv.id)).toMatchObject({
      status: 'skipped',
      reason: AI_SKIP_DISABLED,
    });
    expect((await loadPendingMessages(t.db, conv.id)).map((m) => m.id)).toEqual([msgId]);
    expect(await t.db.select().from(aiRuns).where(eq(aiRuns.conversationId, conv.id))).toEqual([]);
  });

  it('chọn hội thoại bị bỏ sót: chỉ khách chờ 5 phút – 24 giờ, bot bật, ai_mode auto, không Cần người / tạm dừng / đã xử lý', async () => {
    const bot = await createBot({ replyDelaySec: 4, model: 'gemini-bo-sot' });
    const off = await createBot();
    const included = await missedConversation(bot);
    // Echo tự động của Page sau tin khách không tính là "bên mình đã trả lời".
    const withEcho = await missedConversation(bot, 40 * MIN);
    await addMessage(t.db, withEcho.conv, {
      senderType: 'agent',
      text: 'Cảm ơn bạn đã nhắn tin',
      status: 'sent',
      raw: { automatedEcho: true },
      sentAt: new Date(Date.now() - 39 * MIN),
    });
    const tooFresh = await missedConversation(bot, 2 * MIN);
    const tooOld = await missedConversation(bot, 30 * HOUR);
    const botLast = await missedConversation(bot);
    await addMessage(t.db, botLast.conv, {
      senderType: 'bot',
      text: 'Dạ còn ạ',
      status: 'sent',
      sentAt: new Date(Date.now() - 20 * MIN),
    });
    const pending = await missedConversation(bot, 30 * MIN, { status: 'pending_human' });
    const paused = await missedConversation(bot, 30 * MIN, { aiPausedUntil: new Date(Date.now() + HOUR) });
    const modeOff = await missedConversation(bot, 30 * MIN, { aiMode: 'off' });
    const inactive = await missedConversation(off);
    await t.db.update(chatbots).set({ isActive: false }).where(eq(chatbots.id, off.id));
    const noBot = await missedConversation(bot);
    await t.db.update(conversations).set({ chatbotId: null }).where(eq(conversations.id, noBot.conv.id));
    // Bot đã xử lý tin (lượt no_reply) ⇒ không còn chờ.
    const handled = await missedConversation(bot);
    kit.llm.impl = async () => noReply();
    expect(await processAiReplyJob(t.db, kit.deps, handled.conv.id)).toMatchObject({ decision: 'no_reply' });

    const { items } = await listAiMissedReplies(t.db, ctx, new Date());
    const ids = items.map((i) => i.conversationId);
    expect(ids).toEqual(expect.arrayContaining([included.conv.id, withEcho.conv.id]));
    for (const x of [tooFresh, tooOld, botLast, pending, paused, modeOff, inactive, noBot, handled]) {
      expect(ids).not.toContain(x.conv.id);
    }
    expect(items.find((i) => i.conversationId === included.conv.id)).toMatchObject({
      model: 'gemini-bo-sot',
      replyDelaySec: 4,
    });
    expect(await countAiMissedReplies(t.db, ctx, new Date())).toBe(items.length);

    // Lượt định kỳ không đụng hội thoại bị bỏ sót; lượt bấm tay lên lịch bot trả lời (sau phần handoff, giãn cách).
    kit.llm.calls.length = 0;
    await resumeAiOutageHandoffs(t.db, kit.deps);
    expect(kit.scheduler.replies).toEqual([]);
    const r = await resumeAiOutageHandoffs(t.db, kit.deps, { manual: true, spacingMs: 1_000 });
    expect(r).toMatchObject({ missed: items.length, missedKicked: items.length, missedDropped: 0 });
    expect(r.probedOk).toContain('gemini-bo-sot');
    const scheduled = kit.scheduler.replies.map((x) => x.conversationId);
    expect(scheduled).toEqual(expect.arrayContaining([included.conv.id, withEcho.conv.id]));
    for (const x of [tooFresh, tooOld, botLast, pending, paused, modeOff, inactive, noBot, handled]) {
      expect(scheduled).not.toContain(x.conv.id);
    }
    // Giãn cách: lượt thứ i trễ thêm i × spacingMs (+ replyDelaySec của bot).
    kit.scheduler.replies.forEach((x, i) => {
      const item = items.find((m) => m.conversationId === x.conversationId)!;
      expect(x.delayMs).toBe(item.replyDelaySec * 1000 + i * 1_000);
    });
  });

  it('model của bot gọi thử hỏng ⇒ không đánh thức hội thoại bị bỏ sót của bot đó; vượt giới hạn ⇒ ghi số bị bỏ', async () => {
    const broken = await createBot({ model: 'gemini-hong' });
    const a = await missedConversation(broken);
    kit.llm.impl = async (req) => {
      if (req.model === 'gemini-hong') throw new LlmError(BILLING, false, 402);
      return noReply();
    };
    const r = await resumeAiOutageHandoffs(t.db, kit.deps, { manual: true });
    expect(r.probeFailed).toContain('gemini-hong');
    expect(kit.scheduler.replies.map((x) => x.conversationId)).not.toContain(a.conv.id);

    const capped = await resumeAiOutageHandoffs(t.db, kit.deps, { manual: true, missedLimit: 1 });
    expect(capped.missed).toBeLessThanOrEqual(1);
    expect(capped.missedDropped).toBeGreaterThan(0);
  });
});
