// Test tích hợp runtime chatbot: Postgres thật (Testcontainers), LLM/Redis/scheduler/Lark giả.
import {
  aiRuns,
  chatbots,
  contactIdentities,
  conversations,
  handoffs,
  messages,
  type ChannelAccount,
  type Chatbot,
  type Conversation,
  type NewConversation,
} from '@dezon/db';
import type { HandoffCreatedPayload, MessageCreatedPayload } from '@dezon/shared';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { putAiSettings } from '../src/ai/settings';
import {
  AI_BLOCKED_PAUSED,
  PAUSE_WAKEUP_GRACE_MS,
  aiDirtyKey,
  debounceKeys,
  escalateConversation,
  HANDOFF_SYSTEM_PREFIX,
  maybeScheduleChatbotReply,
  processAiReplyJob,
  processHandoffReminderJob,
  requeueQueuedBotMessages,
  scheduleChatbotReply,
} from '../src/ai/runtime';
import { loadPendingMessages } from '../src/ai/turn-input';
import { notifyStaffDedupeKey, notifyStaffKeyword, notifyStaffSystemText } from '../src/ai/notify-staff';
import { ackHandoff, needsChatbotKick, resolveHandoff, resumeConversationAi } from '../src/ai/service';
import { sendAgentMessage } from '../src/inbox/commands';
import { getConversationSummary, getMessageDto } from '../src/inbox/queries';
import {
  createAiKit,
  createFakeScheduler,
  createFakeTypingConnector,
  LARK_URL,
  llmReply,
  type AiTestKit,
  type FakeTypingConnector,
} from './helpers/ai-fakes';
import type { ChannelConnector } from '../src/connectors/types';
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
    contactName: 'Chị Mai',
    chatbotId: bot.id,
    aiMode: 'auto',
    lastCustomerMessageAt: new Date(),
    ...extra,
  });
}

const runsOf = (conversationId: string) =>
  t.db.select().from(aiRuns).where(eq(aiRuns.conversationId, conversationId)).orderBy(asc(aiRuns.createdAt));

const messagesOf = (conversationId: string) =>
  t.db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.sentAt), asc(messages.id));

beforeAll(async () => {
  t = await startTestDb();
  channel = await createChannel(t.db, { displayName: 'Fanpage Nội Thất' });
});

afterAll(async () => {
  await t?.stop();
});

beforeEach(() => {
  kit = createAiKit(ctx);
});

describe('debounce (6.2)', () => {
  it('dời lịch khi có tin mới nhưng không quá max_wait', async () => {
    const t0 = new Date('2026-11-09T03:00:00Z');
    const at = (s: number) => new Date(t0.getTime() + s * 1000);
    const bot = { replyDelaySec: 10, maxWaitSec: 45 };
    const conv = 'conv-debounce';
    expect(await scheduleChatbotReply(kit.redis, kit.scheduler, conv, bot, t0)).toEqual({ delayMs: 10_000 });
    expect(await scheduleChatbotReply(kit.redis, kit.scheduler, conv, bot, at(20))).toEqual({
      delayMs: 10_000,
    });
    expect(await scheduleChatbotReply(kit.redis, kit.scheduler, conv, bot, at(40))).toEqual({
      delayMs: 5_000,
    });
    expect(await scheduleChatbotReply(kit.redis, kit.scheduler, conv, bot, at(50))).toEqual({ delayMs: 0 });
    const keys = debounceKeys(conv);
    expect(kit.redis.store.get(keys.first)).toBe(String(t0.getTime()));
    expect(kit.redis.store.get(keys.last)).toBe(String(at(50).getTime()));
    expect(kit.redis.setCalls[0]).toEqual({
      key: keys.first,
      value: String(t0.getTime()),
      args: ['PX', 165_000, 'NX'],
    });
    expect(kit.scheduler.replies.map((r) => r.delayMs)).toEqual([10_000, 10_000, 5_000, 0]);
  });

  it('maybeScheduleChatbotReply chỉ lên lịch khi bot bật + ai_mode auto', async () => {
    const bot = await createBot({ replyDelaySec: 7 });
    const off = await createBot({ isActive: false });
    const a = await botConversation(bot);
    const b = await botConversation(off);
    const c = await botConversation(bot, { aiMode: 'off' });
    expect(await maybeScheduleChatbotReply(t.db, kit.redis, kit.scheduler, a.id)).toBe(true);
    expect(await maybeScheduleChatbotReply(t.db, kit.redis, kit.scheduler, b.id)).toBe(false);
    expect(await maybeScheduleChatbotReply(t.db, kit.redis, kit.scheduler, c.id)).toBe(false);
    expect(kit.scheduler.replies).toEqual([{ conversationId: a.id, delayMs: 7_000 }]);
  });
});

describe('processAiReplyJob — trả lời', () => {
  it('tạo tin bot, xếp hàng gửi có giãn cách, ghi ai_runs, phát realtime', async () => {
    const bot = await createBot({ name: 'Bot Tư Vấn' });
    const conv = await botConversation(bot);
    await kit.storage.put('media/a.jpg', Buffer.from('anh-1'), 'image/jpeg');
    const m1 = await addMessage(t.db, conv, { text: 'Shop ơi', sentAt: new Date(Date.now() - 5000) });
    const m2 = await addMessage(t.db, conv, {
      text: null,
      attachments: [{ type: 'image', storage_key: 'media/a.jpg', mime: 'image/jpeg' }],
      sentAt: new Date(Date.now() - 4000),
    });
    await kit.redis.set(debounceKeys(conv.id).first, '1');

    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'done', decision: 'reply' });
    expect(kit.redis.store.size).toBe(0);

    // LLM nhận ảnh dạng inline.
    expect(kit.llm.calls).toHaveLength(1);
    const parts = kit.llm.calls[0]!.contents.flatMap((c) => c.parts);
    expect(
      parts.some((p) => 'inlineImage' in p && p.inlineImage.data === Buffer.from('anh-1').toString('base64')),
    ).toBe(true);
    expect(kit.llm.calls[0]!.model).toBe('gemini-default');

    const bots = (await messagesOf(conv.id)).filter((m) => m.senderType === 'bot');
    expect(bots.map((m) => m.text)).toEqual(['Dạ chào anh/chị', 'Shop có mẫu này ạ']);
    expect(
      bots.every((m) => m.status === 'queued' && m.aiRunId === (out as { aiRunId: string }).aiRunId),
    ).toBe(true);
    expect(kit.scheduler.outbound).toEqual([
      { messageId: bots[0]!.id, delayMs: 0 },
      { messageId: bots[1]!.id, delayMs: 1150 },
    ]);

    const [run] = await runsOf(conv.id);
    expect(run).toMatchObject({
      chatbotId: bot.id,
      decision: 'reply',
      model: 'gemini-test',
      inputTokens: 120,
      outputTokens: 30,
    });
    expect([...run!.triggerMessageIds].sort()).toEqual([m1, m2].sort());

    const created = kit.publisher.events.filter((e) => e.event === 'message.created');
    expect(created).toHaveLength(2);
    expect((created[0]!.payload as MessageCreatedPayload).message.senderLabel).toBe('Bot Tư Vấn');
    expect((await getMessageDto(t.db, bots[0]!.id, ctx)).senderLabel).toBe('Bot Tư Vấn');

    // Không còn tin mới ⇒ bỏ qua im lặng, không ghi ai_runs, không gọi LLM.
    const again = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(again).toEqual({ status: 'skipped', reason: 'no_new_messages', aiRunId: null });
    expect(await runsOf(conv.id)).toHaveLength(1);
    expect(kit.llm.calls).toHaveLength(1);
  });

  it('bong bóng dài bị cắt còn ≤ 1000 ký tự; > 3 bong bóng chỉ gửi 3', async () => {
    const bot = await createBot();
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'Tư vấn chi tiết giúp em', sentAt: new Date() });
    kit.llm.impl = async () => llmReply([`${'a'.repeat(1500)} ${'b'.repeat(1500)}`, 'hai', 'ba', 'bốn']);
    await processAiReplyJob(t.db, kit.deps, conv.id);
    const bots = (await messagesOf(conv.id)).filter((m) => m.senderType === 'bot');
    expect(bots.map((m) => m.text?.slice(0, 3))).toEqual(['aaa', 'hai', 'ba']);
    expect(bots.every((m) => (m.text ?? '').length <= 1000)).toBe(true);
  });
});

describe('processAiReplyJob — điều kiện 6.3', () => {
  async function expectBlocked(
    setup: (bot: Chatbot) => Promise<Conversation>,
    reasonPart: string,
    botValues: Partial<typeof chatbots.$inferInsert> = {},
  ) {
    const bot = await createBot(botValues);
    const conv = await setup(bot);
    await addMessage(t.db, conv, { text: 'Alo shop', sentAt: new Date() });
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out.status).toBe('skipped');
    expect((out as { reason: string }).reason).toContain(reasonPart);
    const runs = (await runsOf(conv.id)).filter((r) => r.decision === 'no_reply');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ decision: 'no_reply' });
    expect(runs[0]!.error).toContain(reasonPart);
    expect(kit.llm.calls).toHaveLength(0);
    expect((await messagesOf(conv.id)).some((m) => m.senderType === 'bot')).toBe(false);
    return runs[0]!;
  }

  // Đang pause ⇒ KHÔNG coi tin là đã xử lý (trigger rỗng) để "Tiếp tục AI" còn trả lời; lý do khác ⇒ coi như đã xử lý.
  it('đang tạm dừng vì nhân viên vừa nhắn ⇒ không coi tin là đã xử lý', async () => {
    const run = await expectBlocked(
      (bot) => botConversation(bot, { aiPausedUntil: new Date(Date.now() + 10 * 60_000) }),
      'tạm dừng',
    );
    expect(run.triggerMessageIds).toEqual([]);
  });

  it('đang chờ người thật ⇒ coi tin là đã xử lý', async () => {
    const run = await expectBlocked(
      (bot) => botConversation(bot, { status: 'pending_human' }),
      'chờ người thật',
    );
    expect(run.triggerMessageIds).toHaveLength(1);
  });

  it('ngoài cửa sổ 24 giờ', () =>
    expectBlocked(
      (bot) => botConversation(bot, { lastCustomerMessageAt: new Date(Date.now() - 30 * HOUR) }),
      '24 giờ',
    ));

  it('bot đã tắt', () =>
    expectBlocked((bot) => botConversation(bot), 'Chatbot đang tắt', { isActive: false }));

  it('vượt giới hạn trả lời/giờ', () =>
    expectBlocked(
      async (bot) => {
        const conv = await botConversation(bot);
        await t.db
          .insert(aiRuns)
          .values({ conversationId: conv.id, model: 'x', decision: 'reply', chatbotId: bot.id });
        return conv;
      },
      'giới hạn 1 lượt',
      { maxRepliesPerHour: 1 },
    ));

  it('AI tổng tắt ⇒ bỏ qua, không ghi ai_runs', async () => {
    const bot = await createBot();
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'Alo', sentAt: new Date() });
    await putAiSettings(t.db, t.admin.id, { enabled: false });
    try {
      const out = await processAiReplyJob(t.db, kit.deps, conv.id);
      expect(out).toEqual({ status: 'skipped', reason: 'ai_disabled', aiRunId: null });
      expect(await runsOf(conv.id)).toHaveLength(0);
    } finally {
      await putAiSettings(t.db, t.admin.id, { enabled: true });
    }
  });

  it('nhân viên đã trả lời sau tin khách ⇒ không có tin chưa xử lý', async () => {
    const bot = await createBot();
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'Alo', sentAt: new Date(Date.now() - 2000) });
    await addMessage(t.db, conv, {
      senderType: 'agent',
      senderUserId: t.agent.id,
      text: 'Dạ em nghe',
      sentAt: new Date(),
    });
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'skipped', reason: 'no_new_messages' });
    expect(kit.llm.calls).toHaveLength(0);
  });
});

describe('escalate', () => {
  it('từ khóa ⇒ chuyển người thật: handoff, tin system, tin giữ chỗ, realtime, Lark, nhắc lại', async () => {
    const bot = await createBot({
      handoffKeywords: ['gặp nhân viên'],
      handoffMessage: 'Dạ em chuyển nhân viên hỗ trợ mình ngay ạ',
      // Nhắc lại theo bot (mặc định 0 = tắt); env của kit là 15 nhưng bot thắng.
      handoffReminderMin: 25,
    });
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'Cho em GAP NHAN VIEN với', sentAt: new Date() });

    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'done', decision: 'escalate' });
    expect(kit.llm.calls).toHaveLength(0);

    const [after] = await t.db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(after).toMatchObject({
      status: 'pending_human',
      aiMode: 'off',
      chatbotId: bot.id,
      handoffReason: 'human_request',
    });
    const [h] = await t.db.select().from(handoffs).where(eq(handoffs.conversationId, conv.id));
    expect(h).toMatchObject({ reasonCode: 'human_request', createdBy: 'ai', resolvedAt: null });

    const msgs = await messagesOf(conv.id);
    const placeholder = msgs.find((m) => m.senderType === 'bot');
    expect(placeholder?.text).toBe('Dạ em chuyển nhân viên hỗ trợ mình ngay ạ');
    expect(msgs.find((m) => m.senderType === 'system')?.text).toBe(
      `${HANDOFF_SYSTEM_PREFIX}Khách muốn gặp nhân viên`,
    );
    expect(kit.scheduler.outbound).toEqual([{ messageId: placeholder!.id, delayMs: 0 }]);

    const events = kit.publisher.events.map((e) => e.event);
    expect(events).toContain('conversation.updated');
    const hc = kit.publisher.events.find((e) => e.event === 'handoff.created')!
      .payload as HandoffCreatedPayload;
    expect(hc).toMatchObject({
      conversationId: conv.id,
      reasonCode: 'human_request',
      contactName: 'Chị Mai',
      channelName: 'Fanpage Nội Thất',
    });
    expect(kit.lark.calls).toHaveLength(1);
    expect(kit.lark.calls[0]!.url).toBe(LARK_URL);
    expect(JSON.stringify(kit.lark.calls[0]!.body)).toContain(`https://inbox.test/inbox/${conv.id}`);
    expect(kit.scheduler.reminders).toEqual([
      { data: { conversationId: conv.id, handoffId: h!.id }, delayMs: 25 * 60_000 },
    ]);

    // Read model.
    const summary = await getConversationSummary(t.db, conv.id, ctx);
    expect(summary.chatbot).toEqual({ id: bot.id, name: bot.name });
    expect(summary.handoff).toMatchObject({ reasonCode: 'human_request', acknowledgedBy: null });

    // Nhắc lại khi chưa ai nhận.
    expect(
      await processHandoffReminderJob(t.db, kit.deps, { conversationId: conv.id, handoffId: h!.id }),
    ).toBe(true);
    expect(kit.lark.calls).toHaveLength(2);
    const reminder = kit.publisher.events.filter((e) => e.event === 'handoff.created').at(-1)!;
    expect((reminder.payload as HandoffCreatedPayload).reminder).toBe(true);

    // Nhận xử lý ⇒ phân công + không nhắc nữa.
    const acked = await ackHandoff(t.db, t.agent, conv.id, ctx);
    expect(acked.conversation.assignedUser?.id).toBe(t.agent.id);
    expect(acked.conversation.handoff?.acknowledgedBy?.id).toBe(t.agent.id);
    expect(
      await processHandoffReminderJob(t.db, kit.deps, { conversationId: conv.id, handoffId: h!.id }),
    ).toBe(false);

    // Trả lại cho AI.
    const resolved = await resolveHandoff(t.db, t.agent, conv.id, ctx);
    expect(resolved.conversation).toMatchObject({
      status: 'open',
      aiMode: 'auto',
      handoff: null,
      aiPausedUntil: null,
    });
    const [hAfter] = await t.db.select().from(handoffs).where(eq(handoffs.id, h!.id));
    expect(hAfter!.resolvedAt).not.toBeNull();
  });

  it('độ tự tin thấp ⇒ escalate low_confidence; Lark lỗi không làm hỏng escalate; không tạo trùng', async () => {
    const bot = await createBot();
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'Giá bao nhiêu', sentAt: new Date() });
    kit.llm.impl = async () => llmReply(['Chắc khoảng 5 triệu'], 0.3);
    kit.lark.status = 500;

    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'done', decision: 'escalate' });
    const [after] = await t.db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(after).toMatchObject({ status: 'pending_human', handoffReason: 'low_confidence' });
    expect(kit.lark.calls).toHaveLength(1);
    // Bot im lặng khi chuyển (không có handoff_message) ⇒ không có tin bot nào.
    expect((await messagesOf(conv.id)).some((m) => m.senderType === 'bot')).toBe(false);
    const [run] = await runsOf(conv.id);
    expect(run).toMatchObject({ decision: 'escalate' });

    const dup = await escalateConversation(t.db, kit.deps, conv.id, {
      reasonCode: 'other',
      summary: 'lần hai',
      createdBy: 'ai',
    });
    expect(dup.created).toBe(false);
    expect(await t.db.select().from(handoffs).where(eq(handoffs.conversationId, conv.id))).toHaveLength(1);
  });

  it('LLM lỗi ⇒ ai_runs error + escalate other', async () => {
    const bot = await createBot();
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'Alo', sentAt: new Date() });
    kit.llm.impl = async () => {
      throw new Error('hỏng');
    };
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'done', decision: 'error' });
    const [run] = await runsOf(conv.id);
    expect(run!.decision).toBe('error');
    expect(run!.error).toContain('hỏng');
    const [after] = await t.db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(after).toMatchObject({ status: 'pending_human', handoffReason: 'other' });
  });
});

describe('từ khóa "Báo nhân viên, bot VẪN trả lời" (notifyKeywords)', () => {
  const notifyEvents = () =>
    kit.publisher.events
      .filter((e) => e.event === 'handoff.created')
      .map((e) => e.payload as HandoffCreatedPayload)
      .filter((p) => p.botContinues);
  const systemTexts = async (conversationId: string) =>
    (await messagesOf(conversationId)).filter((m) => m.senderType === 'system').map((m) => m.text);
  const larkTitle = (i: number) =>
    (kit.lark.calls[i]!.body.card as { header: { title: { content: string } } }).header.title.content;

  it('khớp ⇒ báo đúng một lần (tin system, handoff.created botContinues, Lark) và bot VẪN trả lời; không chuyển người', async () => {
    const bot = await createBot({ notifyKeywords: ['gọi lại'], handoffKeywords: ['gặp nhân viên'] });
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'Anh ơi GOI LAI cho em nhé', sentAt: new Date() });

    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'done', decision: 'reply' });
    expect(kit.llm.calls).toHaveLength(1);
    // Bot vẫn trả lời: tin bot xếp hàng gửi.
    const bots = (await messagesOf(conv.id)).filter((m) => m.senderType === 'bot');
    expect(bots).toHaveLength(2);
    expect(kit.scheduler.outbound.map((o) => o.messageId)).toEqual(bots.map((m) => m.id));

    // Không chuyển người: vẫn open/auto, không có handoffs, không nhắc lại.
    const [after] = await t.db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(after).toMatchObject({ status: 'open', aiMode: 'auto', handoffReason: null, chatbotId: bot.id });
    expect(await t.db.select().from(handoffs).where(eq(handoffs.conversationId, conv.id))).toHaveLength(0);
    expect(kit.scheduler.reminders).toHaveLength(0);

    // Một tin system, gắn ai_run_id của lượt.
    const systems = (await messagesOf(conv.id)).filter((m) => m.senderType === 'system');
    expect(systems.map((m) => m.text)).toEqual([
      'Đã báo nhân viên: khách nhắn từ khóa "gọi lại" — bot vẫn tiếp tục trả lời',
    ]);
    expect(systems[0]!.aiRunId).toBe((out as { aiRunId: string }).aiRunId);
    expect(
      kit.publisher.events.some(
        (e) =>
          e.event === 'message.created' && (e.payload as MessageCreatedPayload).message.id === systems[0]!.id,
      ),
    ).toBe(true);

    const events = notifyEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      conversationId: conv.id,
      reasonCode: 'human_request',
      contactName: 'Chị Mai',
      channelName: 'Fanpage Nội Thất',
      botContinues: true,
    });
    expect(events[0]!.summary).toContain('"gọi lại"');
    expect(events[0]!.summary).toContain('Anh ơi GOI LAI cho em nhé');
    expect(events[0]!.reminder).toBeUndefined();

    expect(kit.lark.calls).toHaveLength(1);
    expect(larkTitle(0)).toBe('🔔 Khách cần nhân viên — bot vẫn đang trả lời');
    expect(JSON.stringify(kit.lark.calls[0]!.body)).toContain(`https://inbox.test/inbox/${conv.id}`);
  });

  it('chống trùng: cùng từ khóa trong 10 phút không báo lại (bot vẫn trả lời); từ khóa khác thì báo', async () => {
    const bot = await createBot({ notifyKeywords: ['gọi lại', 'báo giá'] });
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'gọi lại em nha', sentAt: new Date(Date.now() - 2000) });
    await processAiReplyJob(t.db, kit.deps, conv.id);
    await addMessage(t.db, conv, { text: 'Gọi lại giúp em với', sentAt: new Date(Date.now() - 1000) });
    await processAiReplyJob(t.db, kit.deps, conv.id);

    expect(kit.llm.calls).toHaveLength(2);
    expect((await messagesOf(conv.id)).filter((m) => m.senderType === 'bot')).toHaveLength(4);
    expect(await systemTexts(conv.id)).toEqual([notifyStaffSystemText('gọi lại')]);
    expect(notifyEvents()).toHaveLength(1);
    expect(kit.lark.calls).toHaveLength(1);
    expect(kit.redis.setCalls.find((c) => c.key === notifyStaffDedupeKey(conv.id, 'Gọi lại'))?.args).toEqual([
      'EX',
      600,
      'NX',
    ]);

    await addMessage(t.db, conv, { text: 'cho em xin báo giá', sentAt: new Date() });
    await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(await systemTexts(conv.id)).toEqual([
      notifyStaffSystemText('gọi lại'),
      notifyStaffSystemText('báo giá'),
    ]);
    expect(kit.lark.calls).toHaveLength(2);
  });

  it('Redis lỗi ⇒ chống trùng dựa vào tin system gần đây trong DB', async () => {
    const bot = await createBot({ notifyKeywords: ['gọi lại'] });
    const conv = await botConversation(bot);
    const set = kit.redis.set.bind(kit.redis);
    kit.redis.set = async (key, value, ...args) => {
      if (key.startsWith('ai-notify:')) throw new Error('redis down');
      return set(key, value, ...args);
    };
    await addMessage(t.db, conv, { text: 'gọi lại em nha', sentAt: new Date(Date.now() - 1000) });
    await processAiReplyJob(t.db, kit.deps, conv.id);
    await addMessage(t.db, conv, { text: 'gọi lại nhé', sentAt: new Date() });
    await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(await systemTexts(conv.id)).toEqual([notifyStaffSystemText('gọi lại')]);
    expect(kit.lark.calls).toHaveLength(1);
  });

  it('lưu tin system lỗi ⇒ nhả khóa chống trùng: lần sau trong 10 phút VẪN báo nhân viên', async () => {
    const bot = await createBot({ notifyKeywords: ['gọi lại'] });
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'gọi lại em nha', sentAt: new Date() });
    // DB hỏng đúng lúc ghi tin system (transaction ném) — lần sau bình thường.
    let failOnce = true;
    const flaky = new Proxy(t.db, {
      get(target, prop) {
        if (prop === 'transaction' && failOnce) {
          failOnce = false;
          return async () => {
            throw new Error('db down');
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const input = { keyword: 'gọi lại', customerTexts: ['gọi lại em nha'] };
    await expect(notifyStaffKeyword(flaky, kit.deps, conv.id, input)).rejects.toThrow('db down');
    expect(kit.redis.store.has(notifyStaffDedupeKey(conv.id, 'gọi lại'))).toBe(false);
    expect(await systemTexts(conv.id)).toEqual([]);
    expect(notifyEvents()).toHaveLength(0);
    expect(kit.lark.calls).toHaveLength(0);

    // Lần chạy lại (vd. lượt sau cùng từ khóa) trong cửa sổ chống trùng vẫn báo được.
    expect(await notifyStaffKeyword(t.db, kit.deps, conv.id, input)).toBe(true);
    expect(await systemTexts(conv.id)).toEqual([notifyStaffSystemText('gọi lại')]);
    expect(notifyEvents()).toHaveLength(1);
    expect(kit.lark.calls).toHaveLength(1);
    expect(kit.redis.store.has(notifyStaffDedupeKey(conv.id, 'gọi lại'))).toBe(true);
    const [system] = (await messagesOf(conv.id)).filter((m) => m.senderType === 'system');
    expect(system!.raw).toEqual({ notifyStaff: { keyword: 'gọi lại' } });
    // Đã báo thật ⇒ lần nữa thì chống trùng.
    expect(await notifyStaffKeyword(t.db, kit.deps, conv.id, input)).toBe(false);
    expect(kit.lark.calls).toHaveLength(1);
  });

  it('lượt SAU khi đã báo: bot nói "em đã báo nhân viên rồi ạ" ⇒ vẫn reply, KHÔNG escalate (lịch sử có dòng [Hệ thống] thật)', async () => {
    const bot = await createBot({ notifyKeywords: ['gọi lại'] });
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'gọi lại cho em nha', sentAt: new Date(Date.now() - 2000) });
    kit.llm.impl = async () => llmReply(['Dạ em đã báo nhân viên rồi ạ', 'Anh/chị cần tư vấn mẫu nào ạ?']);
    expect(await processAiReplyJob(t.db, kit.deps, conv.id)).toMatchObject({
      status: 'done',
      decision: 'reply',
    });
    expect(await systemTexts(conv.id)).toEqual([notifyStaffSystemText('gọi lại')]);

    // Lượt 2: không có từ khóa; model nói lại (đúng sự thật) là đã báo nhân viên.
    await addMessage(t.db, conv, { text: 'Bao giờ có người liên hệ em vậy', sentAt: new Date() });
    kit.llm.impl = async () => llmReply(['Dạ em đã báo nhân viên rồi ạ, anh/chị đợi chút nhé']);
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'done', decision: 'reply' });
    // Không gọi lại model (bộ chặn "tự nói đã chuyển" không kích hoạt), không chuyển người.
    expect(kit.llm.calls).toHaveLength(2);
    const runs = await runsOf(conv.id);
    expect(JSON.stringify(runs.at(-1)!.toolCalls)).not.toContain('handoff_claim_guard');
    expect(contentText(kit, 1)).toContain(`[Hệ thống] ${notifyStaffSystemText('gọi lại')}`);
    expect(contentText(kit, 1)).not.toContain('Hệ thống ĐÃ báo nhân viên vì người nhắn');
    const [after] = await t.db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(after).toMatchObject({ status: 'open', aiMode: 'auto', handoffReason: null });
    expect(await t.db.select().from(handoffs).where(eq(handoffs.conversationId, conv.id))).toHaveLength(0);
    const bots = (await messagesOf(conv.id)).filter((m) => m.senderType === 'bot').map((m) => m.text);
    expect(bots.at(-1)).toBe('Dạ em đã báo nhân viên rồi ạ, anh/chị đợi chút nhé');
    expect(notifyEvents()).toHaveLength(1);
    expect(kit.lark.calls).toHaveLength(1);
  });

  it('bot no_reply hoặc lượt bị hủy (nhân viên nhắn trong lúc gọi LLM) ⇒ VẪN báo nhân viên', async () => {
    const bot = await createBot({ notifyKeywords: ['gọi lại'] });
    const a = await botConversation(bot);
    await addMessage(t.db, a, { text: 'gọi lại nhé', sentAt: new Date() });
    kit.llm.impl = async () => ({
      functionCall: { name: 'no_reply', args: { reason: 'Khách chỉ nhắn ngắn' } },
      text: null,
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'gemini-test',
    });
    expect(await processAiReplyJob(t.db, kit.deps, a.id)).toMatchObject({
      status: 'done',
      decision: 'no_reply',
    });
    expect(await systemTexts(a.id)).toEqual([notifyStaffSystemText('gọi lại')]);

    const b = await botConversation(bot);
    await addMessage(t.db, b, { text: 'gọi lại cho em', sentAt: new Date() });
    kit.llm.impl = async () => {
      await addMessage(t.db, b, {
        senderType: 'agent',
        senderUserId: t.agent.id,
        text: 'Dạ',
        sentAt: new Date(),
      });
      return llmReply(['Dạ']);
    };
    expect(await processAiReplyJob(t.db, kit.deps, b.id)).toMatchObject({
      status: 'cancelled',
      reason: 'Nhân viên vừa nhắn',
    });
    expect(await systemTexts(b.id)).toEqual([notifyStaffSystemText('gọi lại')]);
    expect(notifyEvents().map((e) => e.conversationId)).toEqual([a.id, b.id]);
    expect(kit.lark.calls).toHaveLength(2);
    for (const id of [a.id, b.id]) {
      const [row] = await t.db.select().from(conversations).where(eq(conversations.id, id));
      expect(row).toMatchObject({ status: 'open', aiMode: 'auto' });
    }
  });

  it('LLM tự escalate ở lượt đó ⇒ chỉ chuyển người như thường (không báo thêm botContinues)', async () => {
    const bot = await createBot({ notifyKeywords: ['gọi lại'] });
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'gọi lại cho em, em muốn khiếu nại', sentAt: new Date() });
    kit.llm.impl = async () => ({
      functionCall: {
        name: 'escalate',
        args: { reason_code: 'complaint', summary_for_agent: 'Khách khiếu nại' },
      },
      text: null,
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'gemini-test',
    });
    expect(await processAiReplyJob(t.db, kit.deps, conv.id)).toMatchObject({
      status: 'done',
      decision: 'escalate',
    });
    const [after] = await t.db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(after).toMatchObject({ status: 'pending_human', handoffReason: 'complaint' });
    expect(await systemTexts(conv.id)).toEqual([`${HANDOFF_SYSTEM_PREFIX}Khách phàn nàn / khiếu nại`]);
    expect(notifyEvents()).toHaveLength(0);
    expect(kit.lark.calls).toHaveLength(1);
    expect(larkTitle(0)).toBe('🔔 Cần người xử lý');
  });

  it('khớp cả từ khóa chuyển người ⇒ đường chuyển người cũ (không gọi LLM, không báo botContinues)', async () => {
    const bot = await createBot({ notifyKeywords: ['gọi lại'], handoffKeywords: ['gặp nhân viên'] });
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'gọi lại hoặc cho em gặp nhân viên', sentAt: new Date() });
    expect(await processAiReplyJob(t.db, kit.deps, conv.id)).toMatchObject({
      status: 'done',
      decision: 'escalate',
    });
    expect(kit.llm.calls).toHaveLength(0);
    const [after] = await t.db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(after).toMatchObject({ status: 'pending_human', aiMode: 'off', handoffReason: 'human_request' });
    expect(notifyEvents()).toHaveLength(0);
    expect(kit.lark.calls).toHaveLength(1);
    // Bot mặc định handoffReminderMin = 0 ⇒ không nhắc lại (dù env của kit là 15).
    expect(kit.scheduler.reminders).toHaveLength(0);
  });
});

describe('chống đua (6.4)', () => {
  it('khách nhắn thêm trong lúc gọi LLM ⇒ hủy, lên lịch lại; lần sau trả lời đủ tin', async () => {
    const bot = await createBot();
    const conv = await botConversation(bot);
    const m1 = await addMessage(t.db, conv, { text: 'Shop ơi', sentAt: new Date() });
    let m2 = '';
    kit.llm.impl = async () => {
      m2 = await addMessage(t.db, conv, { text: 'Còn hàng không', sentAt: new Date() });
      return llmReply(['Dạ']);
    };
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'cancelled', reason: 'Khách vừa nhắn thêm' });
    expect(kit.scheduler.replies).toHaveLength(1);
    expect((await messagesOf(conv.id)).some((m) => m.senderType === 'bot')).toBe(false);
    const [cancelled] = await runsOf(conv.id);
    expect(cancelled).toMatchObject({ decision: 'no_reply', triggerMessageIds: [] });
    expect(cancelled!.error).toContain('Đã hủy');

    kit.llm.impl = async () => llmReply(['Dạ còn ạ']);
    const again = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(again).toMatchObject({ status: 'done', decision: 'reply' });
    const runs = await runsOf(conv.id);
    expect([...runs.at(-1)!.triggerMessageIds].sort()).toEqual([m1, m2].sort());
  });

  it('nhân viên nhắn trong lúc gọi LLM ⇒ hủy, không lên lịch lại', async () => {
    const bot = await createBot();
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'Shop ơi', sentAt: new Date() });
    kit.llm.impl = async () => {
      await addMessage(t.db, conv, {
        senderType: 'agent',
        senderUserId: t.agent.id,
        text: 'Dạ',
        sentAt: new Date(),
      });
      return llmReply(['Dạ']);
    };
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'cancelled', reason: 'Nhân viên vừa nhắn' });
    expect(kit.scheduler.replies).toHaveLength(0);
  });

  it('hai job chồng nhau ⇒ job cũ tự hủy khi job kia đã xử lý cùng tin', async () => {
    const bot = await createBot();
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'Shop ơi', sentAt: new Date() });
    let nested: Awaited<ReturnType<typeof processAiReplyJob>> | undefined;
    let call = 0;
    kit.llm.impl = async () => {
      call++;
      if (call === 1) nested = await processAiReplyJob(t.db, kit.deps, conv.id);
      return llmReply([`Trả lời ${call}`]);
    };
    const outer = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(nested).toMatchObject({ status: 'done', decision: 'reply' });
    expect(outer).toMatchObject({ status: 'cancelled', reason: 'Lần chạy khác đã xử lý các tin này' });
    const bots = (await messagesOf(conv.id)).filter((m) => m.senderType === 'bot');
    expect(bots.map((m) => m.text)).toEqual(['Trả lời 2']);
  });
});

describe('bot đã gỡ khỏi hội thoại', () => {
  it('ghi no_reply và không gọi LLM', async () => {
    const bot = await createBot();
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'Alo', sentAt: new Date() });
    await t.db
      .update(conversations)
      .set({ chatbotId: null, aiMode: 'off' })
      .where(eq(conversations.id, conv.id));
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'skipped', reason: 'Hội thoại không bật chatbot' });
    expect(kit.llm.calls).toHaveLength(0);
  });
});

const SEC = 1000;
const secAgo = (n: number) => new Date(Date.now() - n * SEC);
const contentText = (kit: AiTestKit, call = 0) =>
  kit.llm.calls[call]!.contents.map((c) => c.parts.map((p) => ('text' in p ? p.text : '')).join('')).join(
    '\n',
  );

describe('tin chưa xử lý (pending)', () => {
  it('echo tự động của Page không chặn bot trả lời tin khách', async () => {
    const bot = await createBot();
    const conv = await botConversation(bot);
    const m1 = await addMessage(t.db, conv, { text: 'Shop ơi', sentAt: secAgo(5) });
    await addMessage(t.db, conv, {
      senderType: 'agent',
      text: 'Cảm ơn bạn đã liên hệ',
      raw: { automatedEcho: true },
      sentAt: secAgo(4),
    });
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'done', decision: 'reply' });
    const [run] = await runsOf(conv.id);
    expect(run!.triggerMessageIds).toEqual([m1]);
  });

  it('chỉ tin khách trong 24 giờ gần đây mới được coi là chưa xử lý', async () => {
    const bot = await createBot();
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'Tin cũ', sentAt: new Date(Date.now() - 30 * HOUR) });
    const fresh = await addMessage(t.db, conv, { text: 'Tin mới', sentAt: new Date() });
    expect((await loadPendingMessages(t.db, conv.id)).map((m) => m.id)).toEqual([fresh]);
  });

  it('tin commit muộn (created_at trước tin kích hoạt của lần chạy trước) không bị bỏ sót', async () => {
    const bot = await createBot();
    const conv = await botConversation(bot);
    // Tin rất cũ hơn mốc − 120 giây và chưa từng xử lý: không coi là chưa xử lý.
    await addMessage(t.db, conv, { text: 'cũ', sentAt: secAgo(600), createdAt: secAgo(600) });
    const late = await addMessage(t.db, conv, {
      text: 'commit muộn',
      sentAt: secAgo(30),
      createdAt: secAgo(30),
    });
    const handled = await addMessage(t.db, conv, {
      text: 'đã xử lý',
      sentAt: secAgo(10),
      createdAt: secAgo(10),
    });
    await t.db.insert(aiRuns).values({
      conversationId: conv.id,
      chatbotId: bot.id,
      model: 'x',
      decision: 'reply',
      triggerMessageIds: [handled],
    });
    expect((await loadPendingMessages(t.db, conv.id)).map((m) => m.id)).toEqual([late]);
  });
});

describe('công tắc kiểm lại lúc ghi (dưới khóa)', () => {
  it('bot bị tắt trong lúc gọi LLM ⇒ hủy, coi các tin là đã xử lý', async () => {
    const bot = await createBot();
    const conv = await botConversation(bot);
    const m = await addMessage(t.db, conv, { text: 'Alo', sentAt: new Date() });
    kit.llm.impl = async () => {
      await t.db.update(chatbots).set({ isActive: false }).where(eq(chatbots.id, bot.id));
      return llmReply(['Dạ']);
    };
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'cancelled', reason: 'Chatbot đã tắt' });
    expect((await messagesOf(conv.id)).some((x) => x.senderType === 'bot')).toBe(false);
    const [run] = await runsOf(conv.id);
    expect(run).toMatchObject({ decision: 'no_reply', triggerMessageIds: [m] });
    expect(kit.scheduler.outbound).toHaveLength(0);
  });

  it('AI tổng bị tắt trong lúc gọi LLM ⇒ hủy, không đánh dấu đã xử lý', async () => {
    const bot = await createBot();
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'Alo', sentAt: new Date() });
    kit.llm.impl = async () => {
      await putAiSettings(t.db, t.admin.id, { enabled: false });
      return llmReply(['Dạ']);
    };
    try {
      const out = await processAiReplyJob(t.db, kit.deps, conv.id);
      expect(out).toMatchObject({ status: 'cancelled', reason: 'AI tổng đã tắt' });
      const [run] = await runsOf(conv.id);
      expect(run).toMatchObject({ decision: 'no_reply', triggerMessageIds: [] });
    } finally {
      await putAiSettings(t.db, t.admin.id, { enabled: true });
    }
  });

  it('đạt giới hạn trả lời/giờ trong lúc gọi LLM (job song song) ⇒ hủy', async () => {
    const bot = await createBot({ maxRepliesPerHour: 1 });
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'Alo', sentAt: new Date() });
    kit.llm.impl = async () => {
      await t.db
        .insert(aiRuns)
        .values({ conversationId: conv.id, model: 'x', decision: 'reply', chatbotId: bot.id });
      return llmReply(['Dạ']);
    };
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'cancelled' });
    expect((out as { reason: string }).reason).toContain('giới hạn 1 lượt');
    expect((await messagesOf(conv.id)).some((x) => x.senderType === 'bot')).toBe(false);
  });
});

describe('khôi phục tác dụng phụ sau commit', () => {
  it('tin bot còn queued (mất job outbound) ⇒ đầu job xếp hàng lại', async () => {
    const bot = await createBot();
    const conv = await botConversation(bot);
    const queued = await addMessage(t.db, conv, {
      senderType: 'bot',
      text: 'Dạ',
      status: 'queued',
      sentAt: secAgo(600),
      createdAt: secAgo(600),
    });
    const fresh = await addMessage(t.db, conv, {
      senderType: 'bot',
      text: 'Mới',
      status: 'queued',
      sentAt: new Date(),
    });
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'skipped', reason: 'no_new_messages' });
    expect(kit.scheduler.outbound).toEqual([{ messageId: queued, delayMs: 0 }]);
    expect(kit.scheduler.outbound.some((o) => o.messageId === fresh)).toBe(false);
  });

  it('lần chạy escalate chưa kịp chuyển người ⇒ escalate bù đúng lý do, không trùng', async () => {
    const bot = await createBot();
    const conv = await botConversation(bot);
    const m = await addMessage(t.db, conv, { text: 'Hàng lỗi', sentAt: secAgo(60) });
    await t.db.insert(aiRuns).values({
      conversationId: conv.id,
      chatbotId: bot.id,
      model: 'x',
      decision: 'escalate',
      triggerMessageIds: [m],
      toolCalls: [{ name: 'escalate', args: { reason_code: 'complaint', summary_for_agent: 'Khách bực' } }],
      reasoningSummary: 'Khách bực',
    });
    await processAiReplyJob(t.db, kit.deps, conv.id);
    const [after] = await t.db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(after).toMatchObject({ status: 'pending_human', handoffReason: 'complaint' });
    const hs = await t.db.select().from(handoffs).where(eq(handoffs.conversationId, conv.id));
    expect(hs).toHaveLength(1);
    expect(hs[0]).toMatchObject({ summary: 'Khách bực', createdBy: 'ai' });

    // Trả lại cho AI rồi chạy job: tin system của lần chạy đã có ⇒ không escalate lại.
    await resolveHandoff(t.db, t.agent, conv.id, ctx);
    await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(await t.db.select().from(handoffs).where(eq(handoffs.conversationId, conv.id))).toHaveLength(1);
  });

  it('sweeper: chỉ xếp hàng lại tin bot queued quá tuổi tối thiểu, trong cửa sổ, chưa gửi', async () => {
    const bot = await createBot();
    const conv = await botConversation(bot);
    await t.db.update(conversations).set({ lastMessageAt: new Date() }).where(eq(conversations.id, conv.id));
    const stale = await addMessage(t.db, conv, {
      senderType: 'bot',
      status: 'queued',
      sentAt: secAgo(120),
      createdAt: secAgo(120),
    });
    const tooOld = await addMessage(t.db, conv, {
      senderType: 'bot',
      status: 'queued',
      sentAt: new Date(Date.now() - 2 * HOUR),
      createdAt: new Date(Date.now() - 2 * HOUR),
    });
    const sent = await addMessage(t.db, conv, {
      senderType: 'bot',
      status: 'sent',
      sentAt: secAgo(120),
      createdAt: secAgo(120),
    });
    const young = await addMessage(t.db, conv, { senderType: 'bot', status: 'queued', sentAt: new Date() });
    const scheduler = createFakeScheduler();
    await requeueQueuedBotMessages(t.db, scheduler, { minAgeSec: 60 });
    const ids = scheduler.outbound.map((o) => o.messageId);
    expect(ids).toContain(stale);
    for (const id of [tooOld, sent, young]) expect(ids).not.toContain(id);
  });
});

describe('cờ ai-dirty', () => {
  it('job kết thúc thấy cờ ⇒ xóa cờ và lên lịch lại', async () => {
    const bot = await createBot({ replyDelaySec: 3 });
    const conv = await botConversation(bot);
    await kit.redis.set(aiDirtyKey(conv.id), '1');
    await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(kit.redis.store.has(aiDirtyKey(conv.id))).toBe(false);
    expect(kit.scheduler.replies).toEqual([{ conversationId: conv.id, delayMs: 3_000 }]);
  });

  it('không có cờ ⇒ không lên lịch', async () => {
    const bot = await createBot();
    const conv = await botConversation(bot);
    await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(kit.scheduler.replies).toHaveLength(0);
  });
});

describe('lịch sử: mốc chuyển người / trả lại cho AI', () => {
  it('prompt có dòng [Hệ thống] sau yêu cầu cũ đã được nhân viên xử lý', async () => {
    const bot = await createBot();
    const conv = await botConversation(bot);
    const old = await addMessage(t.db, conv, { text: 'Giảm giá cho em đi', sentAt: secAgo(3600) });
    // Khách nhắn thêm khi đang chờ người (không có job vì ai_mode off) — nhân viên lo qua điện thoại.
    await addMessage(t.db, conv, {
      text: 'Gọi lại cho em nhé',
      sentAt: secAgo(3000),
      createdAt: secAgo(3000),
    });
    await t.db.insert(handoffs).values({
      conversationId: conv.id,
      reasonCode: 'discount',
      summary: 'Khách xin giảm giá',
      createdBy: 'ai',
      createdAt: secAgo(3500),
      resolvedAt: secAgo(1800),
    });
    await t.db.insert(aiRuns).values({
      conversationId: conv.id,
      chatbotId: bot.id,
      model: 'x',
      decision: 'escalate',
      triggerMessageIds: [old],
      createdAt: secAgo(3550),
    });
    const fresh = await addMessage(t.db, conv, { text: 'Bảo hành bao lâu ạ?', sentAt: new Date() });
    await processAiReplyJob(t.db, kit.deps, conv.id);
    // Tin nhắn trong lúc chờ người (trước lần "trả lại cho AI") không còn là tin chưa xử lý.
    expect((await runsOf(conv.id)).at(-1)!.triggerMessageIds).toEqual([fresh]);
    const text = contentText(kit);
    const iOld = text.indexOf('Giảm giá cho em đi');
    const iCreated = text.indexOf(
      '[Hệ thống] Hội thoại đã được chuyển cho nhân viên (lý do: Khách hỏi giảm giá',
    );
    const iResolved = text.indexOf('[Hệ thống] Nhân viên đã xử lý xong');
    const iNew = text.indexOf('Bảo hành bao lâu');
    expect(iOld).toBeGreaterThanOrEqual(0);
    expect(iCreated).toBeGreaterThan(iOld);
    expect(iResolved).toBeGreaterThan(iCreated);
    expect(iNew).toBeGreaterThan(iResolved);
  });
});

// Ảnh cho model: xem ai-images.integration.test.ts.

describe('escalate kèm tin cho khách', () => {
  const HANDOFF = 'Dạ em chuyển nhân viên hỗ trợ mình ngay ạ.';
  const QUOTE = 'Dạ với 5 ảnh công trình thì mức thù lao dự kiến là 50.000đ ạ.';
  const FORWARDED = 'Em đã chuyển hồ sơ cho bộ phận duyệt ạ.';
  const botMessages = async (conversationId: string) =>
    (await messagesOf(conversationId)).filter((m) => m.senderType === 'bot');
  const escalateWith = (messages_to_customer?: unknown) => async () => ({
    functionCall: {
      name: 'escalate',
      args: {
        reason_code: 'other',
        summary_for_agent: 'CT A, 5 ảnh, 50.000đ',
        ...(messages_to_customer !== undefined ? { messages_to_customer } : {}),
      },
    },
    text: null,
    usage: { inputTokens: 1, outputTokens: 1 },
    model: 'gemini-test',
  });

  it('messages_to_customer ⇒ gửi các tin đó (bong bóng bot, ai_run_id, giãn cách) THAY handoffMessage, rồi chuyển người + Lark', async () => {
    const bot = await createBot({ handoffMessage: HANDOFF });
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'Em gửi 5 ảnh công trình A', sentAt: secAgo(3) });
    kit.llm.impl = escalateWith([QUOTE, FORWARDED]);
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'done', decision: 'escalate' });

    const bots = await botMessages(conv.id);
    expect(bots.map((m) => m.text)).toEqual([QUOTE, FORWARDED]);
    expect(bots.every((m) => m.aiRunId === out.aiRunId && m.status === 'queued')).toBe(true);
    const msgs = await messagesOf(conv.id);
    expect(msgs.at(-1)?.senderType).toBe('system');
    // Cùng đường gửi với reply: bong bóng đầu delay 0, bong bóng sau giãn cách.
    expect(kit.scheduler.outbound.map((o) => o.messageId)).toEqual(bots.map((m) => m.id));
    expect(kit.scheduler.outbound[0]!.delayMs).toBe(0);
    expect(kit.scheduler.outbound[1]!.delayMs).toBeGreaterThan(0);

    const [after] = await t.db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(after).toMatchObject({ status: 'pending_human', aiMode: 'off', handoffReason: 'other' });
    const [h] = await t.db.select().from(handoffs).where(eq(handoffs.conversationId, conv.id));
    expect(h).toMatchObject({ reasonCode: 'other', summary: 'CT A, 5 ảnh, 50.000đ', createdBy: 'ai' });
    expect(kit.publisher.events.some((e) => e.event === 'handoff.created')).toBe(true);
    expect(kit.lark.calls).toHaveLength(1);
    expect(JSON.stringify(kit.lark.calls[0]!.body)).toContain('CT A, 5 ảnh, 50.000đ');
  });

  it('không có messages_to_customer ⇒ gửi handoffMessage như cũ', async () => {
    const bot = await createBot({ handoffMessage: HANDOFF });
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'Em gửi ảnh rồi', sentAt: secAgo(3) });
    kit.llm.impl = escalateWith([' ']);
    await processAiReplyJob(t.db, kit.deps, conv.id);
    expect((await botMessages(conv.id)).map((m) => m.text)).toEqual([HANDOFF]);
    expect(kit.scheduler.outbound).toHaveLength(1);
    expect(kit.lark.calls).toHaveLength(1);
  });

  it('ngoài cửa sổ gửi ⇒ không gửi tin nào nhưng vẫn chuyển người', async () => {
    const bot = await createBot({ handoffMessage: HANDOFF });
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'Em gửi ảnh rồi', sentAt: secAgo(3) });
    // Lượt chạy đã qua điều kiện; cửa sổ 24h đóng ngay trước khi chuyển người.
    kit.llm.impl = async () => {
      await t.db
        .update(conversations)
        .set({ lastCustomerMessageAt: new Date(Date.now() - 30 * 3600_000) })
        .where(eq(conversations.id, conv.id));
      return escalateWith([QUOTE])();
    };
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'done', decision: 'escalate' });
    expect(await botMessages(conv.id)).toHaveLength(0);
    expect(kit.scheduler.outbound).toHaveLength(0);
    const [after] = await t.db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(after).toMatchObject({ status: 'pending_human' });
    expect(kit.lark.calls).toHaveLength(1);
  });

  it('reply tự nói "đã chuyển hồ sơ cho bộ phận" ⇒ gọi lại; lần sau escalate ⇒ gửi messages_to_customer, không lặp handoffMessage', async () => {
    const bot = await createBot({ handoffMessage: HANDOFF });
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'Em gửi đủ ảnh rồi nhé', sentAt: secAgo(3) });
    const bubble = 'Em đã chuyển hồ sơ cho bộ phận duyệt để kiểm tra và thanh toán cho anh/chị nhé.';
    const steps = [async () => llmReply([bubble]), escalateWith([QUOTE, FORWARDED])];
    kit.llm.impl = async () => steps.shift()!();
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'done', decision: 'escalate' });
    expect(kit.llm.calls).toHaveLength(2);
    expect((await botMessages(conv.id)).map((m) => m.text)).toEqual([QUOTE, FORWARDED]);
    const [run] = await runsOf(conv.id);
    expect(run).toMatchObject({ decision: 'escalate', inputTokens: 121, outputTokens: 31 });
    expect((run!.toolCalls as { name: string }[]).map((c) => c.name)).toEqual([
      'reply',
      'handoff_claim_guard',
      'escalate',
    ]);
    expect(kit.lark.calls).toHaveLength(1);
  });

  it('reply VẪN tự nói đã chuyển sau khi gọi lại ⇒ hệ thống tự chuyển người thật, gửi bong bóng đó', async () => {
    const bot = await createBot({ handoffMessage: HANDOFF });
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'Em gửi đủ ảnh rồi nhé', sentAt: secAgo(3) });
    const bubble = 'Em đã chuyển hồ sơ cho bộ phận duyệt để kiểm tra và thanh toán cho anh/chị nhé.';
    kit.llm.impl = async () => llmReply([bubble]);
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'done', decision: 'escalate' });
    expect((await botMessages(conv.id)).map((m) => m.text)).toEqual([bubble]);
    const [after] = await t.db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(after).toMatchObject({ status: 'pending_human', handoffReason: 'other' });
    const [run] = await runsOf(conv.id);
    expect((run!.toolCalls as { name: string }[]).map((c) => c.name)).toEqual([
      'reply',
      'handoff_claim_guard',
      'reply',
      'handoff_claim_guard',
    ]);
    expect(kit.lark.calls).toHaveLength(1);
  });

  it('độ tự tin thấp ⇒ KHÔNG gửi câu trả lời không chắc, chỉ handoffMessage', async () => {
    const bot = await createBot({ handoffMessage: HANDOFF });
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'Giá bao nhiêu', sentAt: secAgo(3) });
    kit.llm.impl = async () => llmReply(['Chắc khoảng 5 triệu'], 0.2);
    await processAiReplyJob(t.db, kit.deps, conv.id);
    expect((await botMessages(conv.id)).map((m) => m.text)).toEqual([HANDOFF]);
  });
});

describe('chỉ báo "đang soạn tin"', () => {
  let typingChannel: ChannelAccount;
  let fake: FakeTypingConnector;

  beforeAll(async () => {
    typingChannel = await createChannel(t.db, {
      displayName: 'Fanpage Typing',
      credentials: { enc: JSON.stringify({ pageAccessToken: 'page-token' }) },
    });
  });

  beforeEach(() => {
    fake = createFakeTypingConnector();
    kit.deps.connectors = { messenger: fake.connector };
  });

  const typingEvents = () =>
    kit.publisher.events
      .filter((e) => e.event === 'ai.typing')
      .map((e) => e.payload as { conversationId: string; typing: boolean; chatbotName: string | null });
  const actions = () => fake.actions.map((a) => a.action);

  async function typingConversation(bot: Chatbot, extra: Partial<NewConversation> = {}) {
    const conv = await createConversation(t.db, {
      channel: typingChannel,
      contactName: 'Anh Nam',
      chatbotId: bot.id,
      aiMode: 'auto',
      lastCustomerMessageAt: new Date(),
      ...extra,
    });
    await addMessage(t.db, conv, { text: 'Shop ơi', sentAt: new Date() });
    return conv;
  }

  it('trả lời: realtime typing true TRƯỚC khi gọi LLM, false sau; mark_seen + typing_on, không typing_off', async () => {
    const bot = await createBot({ name: 'Bot Gõ' });
    const conv = await typingConversation(bot);
    const seenAtLlm: unknown[] = [];
    const base = kit.llm.impl;
    kit.llm.impl = async (req) => {
      seenAtLlm.push(...typingEvents());
      return base(req);
    };

    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'done', decision: 'reply' });
    expect(seenAtLlm).toEqual([{ conversationId: conv.id, typing: true, chatbotName: 'Bot Gõ' }]);
    expect(typingEvents()).toEqual([
      { conversationId: conv.id, typing: true, chatbotName: 'Bot Gõ' },
      { conversationId: conv.id, typing: false, chatbotName: 'Bot Gõ' },
    ]);
    // typing:false phát sau message.created của tin bot, cùng phòng realtime.
    const names = kit.publisher.events.map((e) => e.event);
    expect(names.lastIndexOf('ai.typing')).toBeGreaterThan(names.lastIndexOf('message.created'));
    const typingRooms = kit.publisher.events.find((e) => e.event === 'ai.typing')!.rooms;
    expect(typingRooms).toEqual(kit.publisher.events.find((e) => e.event === 'message.created')!.rooms);

    await vi.waitFor(() => expect(actions()).toEqual(['mark_seen', 'typing_on']));
    const [identity] = await t.db
      .select({ psid: contactIdentities.externalUserId })
      .from(contactIdentities)
      .where(eq(contactIdentities.id, conv.contactIdentityId));
    expect(fake.actions.every((a) => a.psid === identity!.psid && a.token === 'page-token')).toBe(true);
  });

  it('escalate ⇒ typing_off sau typing_on, realtime typing false', async () => {
    const bot = await createBot();
    const conv = await typingConversation(bot);
    kit.llm.impl = async () => ({
      functionCall: {
        name: 'escalate',
        args: { reason_code: 'complaint', summary_for_agent: 'Khách bực' },
      },
      text: null,
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'gemini-test',
    });
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'done', decision: 'escalate' });
    expect(typingEvents().map((e) => e.typing)).toEqual([true, false]);
    await vi.waitFor(() => expect(actions()).toEqual(['mark_seen', 'typing_on', 'typing_off']));
  });

  it('escalate có messages_to_customer ⇒ tin bot tự tắt dấu ba chấm (không typing_off)', async () => {
    const bot = await createBot();
    const conv = await typingConversation(bot);
    kit.llm.impl = async () => ({
      functionCall: {
        name: 'escalate',
        args: {
          reason_code: 'other',
          summary_for_agent: 'Đủ ảnh',
          messages_to_customer: ['Dạ em đã chuyển hồ sơ ạ.'],
        },
      },
      text: null,
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'gemini-test',
    });
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'done', decision: 'escalate' });
    expect(typingEvents().map((e) => e.typing)).toEqual([true, false]);
    await vi.waitFor(() => expect(actions()).toEqual(['mark_seen', 'typing_on']));
    expect(actions()).not.toContain('typing_off');
  });

  it('LLM lỗi (decision error) ⇒ typing_off', async () => {
    const bot = await createBot();
    const conv = await typingConversation(bot);
    kit.llm.impl = async () => {
      throw new Error('hỏng');
    };
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'done', decision: 'error' });
    expect(typingEvents().map((e) => e.typing)).toEqual([true, false]);
    await vi.waitFor(() => expect(actions()).toEqual(['mark_seen', 'typing_on', 'typing_off']));
  });

  it('hủy (chống đua) ⇒ typing_off', async () => {
    const bot = await createBot();
    const conv = await typingConversation(bot);
    const base = kit.llm.impl;
    kit.llm.impl = async (req) => {
      await addMessage(t.db, conv, { text: 'nhắn thêm', sentAt: new Date() });
      return base(req);
    };
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out.status).toBe('cancelled');
    expect(typingEvents().map((e) => e.typing)).toEqual([true, false]);
    await vi.waitFor(() => expect(actions()).toEqual(['mark_seen', 'typing_on', 'typing_off']));
  });

  it('hai job chồng nhau: job cũ bị hủy KHÔNG tắt chỉ báo khi job mới đang soạn; job mới tắt khi xong', async () => {
    const bot = await createBot();
    const conv = await typingConversation(bot);
    let bInLlm!: () => void;
    const bStarted = new Promise<void>((r) => (bInLlm = r));
    let releaseB!: () => void;
    const bGate = new Promise<void>((r) => (releaseB = r));
    let jobB: ReturnType<typeof processAiReplyJob> | undefined;
    let call = 0;
    kit.llm.impl = async () => {
      call++;
      if (call === 1) {
        // Job A đang gọi LLM: khách nhắn thêm, job B (khe -next) bắt đầu và cũng vào LLM.
        await addMessage(t.db, conv, { text: 'nhắn thêm', sentAt: new Date() });
        jobB = processAiReplyJob(t.db, kit.deps, conv.id);
        await bStarted;
        return llmReply(['Trả lời A']);
      }
      bInLlm();
      await bGate;
      return llmReply(['Trả lời B']);
    };

    const outA = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(outA).toMatchObject({ status: 'cancelled', reason: 'Khách vừa nhắn thêm' });
    await new Promise((r) => setTimeout(r, 20));
    // B vẫn đang soạn: không có typing:false, không typing_off.
    expect(typingEvents().map((e) => e.typing)).toEqual([true, true]);
    expect(actions()).not.toContain('typing_off');

    releaseB();
    expect(await jobB).toMatchObject({ status: 'done', decision: 'reply' });
    expect(typingEvents().map((e) => e.typing)).toEqual([true, true, false]);
    await new Promise((r) => setTimeout(r, 20));
    expect(actions()).not.toContain('typing_off'); // B có tin bot ⇒ Messenger tự tắt
    const bots = (await messagesOf(conv.id)).filter((m) => m.senderType === 'bot');
    expect(bots.map((m) => m.text)).toEqual(['Trả lời B']);
  });

  it('lỗi hạ tầng sau LLM (ném cho BullMQ) ⇒ vẫn tắt typing (finally)', async () => {
    const bot = await createBot();
    const conv = await typingConversation(bot);
    kit.scheduler.enqueueOutbound = async () => {
      throw new Error('Redis hỏng');
    };
    await expect(processAiReplyJob(t.db, kit.deps, conv.id)).rejects.toThrow('Redis hỏng');
    expect(typingEvents().map((e) => e.typing)).toEqual([true, false]);
    await vi.waitFor(() => expect(actions()).toEqual(['mark_seen', 'typing_on', 'typing_off']));
  });

  it('không được chạy (ngoài cửa sổ 24 giờ) hoặc skip ⇒ không phát typing, không gửi sender_action', async () => {
    const bot = await createBot();
    const conv = await typingConversation(bot, {
      lastCustomerMessageAt: new Date(Date.now() - 30 * HOUR),
    });
    expect((await processAiReplyJob(t.db, kit.deps, conv.id)).status).toBe('skipped');
    // Lần sau: không còn tin mới ⇒ skip im lặng.
    expect((await processAiReplyJob(t.db, kit.deps, conv.id)).status).toBe('skipped');
    await new Promise((r) => setTimeout(r, 20));
    expect(typingEvents()).toEqual([]);
    expect(actions()).toEqual([]);
  });

  it('kênh mất kết nối ⇒ không phát typing', async () => {
    const lost = await createChannel(t.db, {
      status: 'expired',
      credentials: { enc: JSON.stringify({ pageAccessToken: 'x' }) },
    });
    const bot = await createBot();
    const conv = await createConversation(t.db, {
      channel: lost,
      chatbotId: bot.id,
      aiMode: 'auto',
      lastCustomerMessageAt: new Date(),
    });
    await addMessage(t.db, conv, { text: 'Alo', sentAt: new Date() });
    expect((await processAiReplyJob(t.db, kit.deps, conv.id)).status).toBe('skipped');
    await new Promise((r) => setTimeout(r, 20));
    expect(typingEvents()).toEqual([]);
    expect(actions()).toEqual([]);
  });

  it('chỉ báo sớm: lên lịch (hook tin khách) ⇒ mark_seen + typing_on + typing:true NGAY, trước debounce', async () => {
    const bot = await createBot({ name: 'Bot Sớm', replyDelaySec: 10 });
    const conv = await typingConversation(bot);
    expect(
      await maybeScheduleChatbotReply(t.db, kit.redis, kit.scheduler, conv.id, new Date(), kit.deps),
    ).toBe(true);
    expect(kit.scheduler.replies.at(-1)).toMatchObject({ conversationId: conv.id, delayMs: 10_000 });
    await vi.waitFor(() => expect(actions()).toEqual(['mark_seen', 'typing_on']));
    expect(typingEvents()).toEqual([{ conversationId: conv.id, typing: true, chatbotName: 'Bot Sớm' }]);

    // Job chạy sau debounce: nhận lại chỉ báo, trả lời, tắt realtime; có tin bot ⇒ không typing_off.
    expect(await processAiReplyJob(t.db, kit.deps, conv.id)).toMatchObject({
      status: 'done',
      decision: 'reply',
    });
    expect(typingEvents().map((e) => e.typing)).toEqual([true, true, false]);
    await new Promise((r) => setTimeout(r, 20));
    expect(actions()).not.toContain('typing_off');
  });

  it('chỉ báo sớm rồi job bị skip (không có tin mới / giới hạn lượt) ⇒ typing:false + typing_off', async () => {
    const bot = await createBot();
    const conv = await typingConversation(bot);
    await processAiReplyJob(t.db, kit.deps, conv.id); // xử lý hết tin
    kit.publisher.events.length = 0;
    fake.actions.length = 0;
    await maybeScheduleChatbotReply(t.db, kit.redis, kit.scheduler, conv.id, new Date(), kit.deps);
    await vi.waitFor(() => expect(actions()).toEqual(['mark_seen', 'typing_on']));
    expect(await processAiReplyJob(t.db, kit.deps, conv.id)).toMatchObject({
      status: 'skipped',
      reason: 'no_new_messages',
    });
    expect(typingEvents().map((e) => e.typing)).toEqual([true, false]);
    await vi.waitFor(() => expect(actions()).toEqual(['mark_seen', 'typing_on', 'typing_off']));

    const capped = await createBot({ maxRepliesPerHour: 0 });
    const c2 = await typingConversation(capped);
    kit.publisher.events.length = 0;
    fake.actions.length = 0;
    await maybeScheduleChatbotReply(t.db, kit.redis, kit.scheduler, c2.id, new Date(), kit.deps);
    await vi.waitFor(() => expect(actions()).toEqual(['mark_seen', 'typing_on']));
    expect((await processAiReplyJob(t.db, kit.deps, c2.id)).status).toBe('skipped');
    expect(typingEvents().map((e) => e.typing)).toEqual([true, false]);
    await vi.waitFor(() => expect(actions()).toEqual(['mark_seen', 'typing_on', 'typing_off']));
  });

  it('chỉ báo sớm KHÔNG bật khi ngoài cửa sổ 24 giờ / AI tạm dừng / job khác đang soạn', async () => {
    const bot = await createBot();
    const outside = await typingConversation(bot, {
      lastCustomerMessageAt: new Date(Date.now() - 30 * HOUR),
    });
    const paused = await typingConversation(bot, { aiPausedUntil: new Date(Date.now() + HOUR) });
    const busy = await typingConversation(bot);
    kit.redis.store.set(`ai-typing:${busy.id}`, 'job-token');
    for (const c of [outside, paused, busy]) {
      expect(
        await maybeScheduleChatbotReply(t.db, kit.redis, kit.scheduler, c.id, new Date(), kit.deps),
      ).toBe(true);
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(typingEvents()).toEqual([]);
    expect(actions()).toEqual([]);
    expect(kit.redis.store.get(`ai-typing:${busy.id}`)).toBe('job-token');
  });

  it('sender_action lỗi / connector không hỗ trợ / token không giải mã được ⇒ vẫn trả lời bình thường', async () => {
    fake.fail = true;
    const bot = await createBot();
    const a = await typingConversation(bot);
    expect(await processAiReplyJob(t.db, kit.deps, a.id)).toMatchObject({
      status: 'done',
      decision: 'reply',
    });

    const noTyping: ChannelConnector = { ...fake.connector };
    delete noTyping.sendSenderAction;
    kit.deps.connectors = { messenger: noTyping };
    const b = await typingConversation(bot);
    expect(await processAiReplyJob(t.db, kit.deps, b.id)).toMatchObject({
      status: 'done',
      decision: 'reply',
    });

    // Kênh fixture mặc định có credentials không giải mã được.
    fake.fail = false;
    kit.deps.connectors = { messenger: fake.connector };
    const c = await botConversation(bot);
    await addMessage(t.db, c, { text: 'Alo', sentAt: new Date() });
    expect(await processAiReplyJob(t.db, kit.deps, c.id)).toMatchObject({
      status: 'done',
      decision: 'reply',
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(actions()).toEqual([]);
    // Realtime vẫn phát cho cả ba lượt.
    expect(typingEvents().map((e) => e.typing)).toEqual([true, false, true, false, true, false]);
  });
});

describe('tạm dừng sau tin nhân viên không "nuốt" tin khách đang chờ', () => {
  const sendStaff = (conversationId: string, text: string) =>
    sendAgentMessage(t.db, t.admin, conversationId, { text, attachments: [] }, ctx);

  /**
   * Tin khách trước tin nhân viên (nhân viên đã lo) ⇒ nhân viên nhắn (áp agent_reply_mode) ⇒ tin khách trong lúc
   * pause ⇒ job bị chặn, KHÔNG coi tin là đã xử lý ⇒ "Tiếp tục AI" ⇒ kick ⇒ bot trả lời đúng tin đang chờ.
   */
  async function pausedThenResume(mode: 'pause' | 'stop') {
    const bot = await createBot({ agentReplyMode: mode, agentPauseMinutes: 30 });
    const conv = await botConversation(bot);
    const before = await addMessage(t.db, conv, { text: 'Shop ơi báo giá', sentAt: secAgo(30) });
    const staff = await sendStaff(conv.id, 'Dạ em gửi chị bảng giá');
    expect(staff.conversation.aiPausedUntil).not.toBeNull();
    const during = await addMessage(t.db, conv, { text: 'Mẫu này còn màu trắng không?', sentAt: new Date() });

    const blocked = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(blocked).toMatchObject({ status: 'skipped', reason: AI_BLOCKED_PAUSED });
    const [blockedRun] = await runsOf(conv.id);
    expect(blockedRun).toMatchObject({
      decision: 'no_reply',
      error: AI_BLOCKED_PAUSED,
      triggerMessageIds: [],
    });
    expect(kit.llm.calls).toHaveLength(0);
    // Tin trong lúc pause vẫn chờ; tin trước tin nhân viên thì không (nhân viên đã lo).
    expect((await loadPendingMessages(t.db, conv.id)).map((m) => m.id)).toEqual([during]);

    // Job lặp lại trong lúc pause (tin khách kế tiếp) cũng không nuốt tin.
    expect(await processAiReplyJob(t.db, kit.deps, conv.id)).toMatchObject({ reason: AI_BLOCKED_PAUSED });
    expect((await loadPendingMessages(t.db, conv.id)).map((m) => m.id)).toEqual([during]);

    await resumeConversationAi(t.db, t.admin, conv.id, ctx);
    expect(await needsChatbotKick(t.db, conv.id, ctx.now())).toBe(true);
    // Kick (worker) = lên lịch job reply như tin khách mới.
    expect(await maybeScheduleChatbotReply(t.db, kit.redis, kit.scheduler, conv.id)).toBe(true);
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'done', decision: 'reply' });
    const runs = await runsOf(conv.id);
    expect(runs.at(-1)).toMatchObject({ decision: 'reply', triggerMessageIds: [during] });
    expect(runs.at(-1)!.triggerMessageIds).not.toContain(before);
    expect(kit.llm.calls).toHaveLength(1);
    expect((await messagesOf(conv.id)).some((m) => m.senderType === 'bot')).toBe(true);
  }

  it('\'stop\' (dừng hẳn) ⇒ tin khách trong lúc dừng được trả lời sau "Tiếp tục AI"', () =>
    pausedThenResume('stop'));

  it('\'pause\' (tạm nghỉ) ⇒ tin khách trong lúc tạm nghỉ được trả lời sau "Tiếp tục AI"', () =>
    pausedThenResume('pause'));

  it('pause hết hạn tự nhiên ⇒ tin khách kế tiếp kéo theo cả tin đến trong lúc pause', async () => {
    const bot = await createBot({ agentReplyMode: 'pause', agentPauseMinutes: 30 });
    const conv = await botConversation(bot);
    await sendStaff(conv.id, 'Dạ em chào chị');
    const during = await addMessage(t.db, conv, { text: 'Còn hàng không?', sentAt: new Date() });
    expect(await processAiReplyJob(t.db, kit.deps, conv.id)).toMatchObject({ reason: AI_BLOCKED_PAUSED });
    // Giả lập pause đã hết hạn.
    await t.db
      .update(conversations)
      .set({ aiPausedUntil: new Date(Date.now() - 1000) })
      .where(eq(conversations.id, conv.id));
    const next = await addMessage(t.db, conv, { text: 'Shop ơi?', sentAt: new Date() });
    expect(await processAiReplyJob(t.db, kit.deps, conv.id)).toMatchObject({
      status: 'done',
      decision: 'reply',
    });
    const last = (await runsOf(conv.id)).at(-1)!;
    expect([...last.triggerMessageIds].sort()).toEqual([during, next].sort());
  });

  it('tạm nghỉ có giờ ⇒ job bị chặn tự hẹn chạy lại lúc hết nghỉ; tới giờ bot tự trả lời tin đang chờ (không cần khách nhắn thêm)', async () => {
    const bot = await createBot({ agentReplyMode: 'pause', agentPauseMinutes: 2 });
    const conv = await botConversation(bot);
    const staff = await sendStaff(conv.id, 'a');
    const pausedUntil = new Date(staff.conversation.aiPausedUntil!);
    const hello = await addMessage(t.db, conv, { text: 'hello', sentAt: new Date() });

    const t0 = Date.now();
    expect(await processAiReplyJob(t.db, kit.deps, conv.id)).toMatchObject({ reason: AI_BLOCKED_PAUSED });
    const t1 = Date.now();
    expect(kit.scheduler.wakeups).toHaveLength(1);
    const wake = kit.scheduler.wakeups[0]!;
    expect(wake.conversationId).toBe(conv.id);
    // delay = (mốc hết nghỉ − lúc job chạy) + PAUSE_WAKEUP_GRACE_MS, lúc job chạy nằm trong [t0, t1].
    expect(wake.delayMs).toBeGreaterThanOrEqual(pausedUntil.getTime() - t1 + PAUSE_WAKEUP_GRACE_MS);
    expect(wake.delayMs).toBeLessThanOrEqual(pausedUntil.getTime() - t0 + PAUSE_WAKEUP_GRACE_MS);
    // Không dùng scheduleReply (lượt đánh thức không được đè job đang chờ).
    expect(kit.scheduler.replies).toHaveLength(0);

    // Tới giờ hẹn (pause đã hết) ⇒ job chạy, trả lời đúng tin "hello".
    await t.db
      .update(conversations)
      .set({ aiPausedUntil: new Date(Date.now() - 1000) })
      .where(eq(conversations.id, conv.id));
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'done', decision: 'reply' });
    expect((await runsOf(conv.id)).at(-1)!.triggerMessageIds).toEqual([hello]);
  });

  it("'stop' (dừng hẳn) ⇒ job bị chặn KHÔNG tự hẹn chạy lại", async () => {
    const bot = await createBot({ agentReplyMode: 'stop' });
    const conv = await botConversation(bot);
    await sendStaff(conv.id, 'a');
    await addMessage(t.db, conv, { text: 'hello', sentAt: new Date() });
    expect(await processAiReplyJob(t.db, kit.deps, conv.id)).toMatchObject({ reason: AI_BLOCKED_PAUSED });
    expect(kit.scheduler.wakeups).toEqual([]);
  });

  it('lượt đánh thức bị chặn vì lý do khác (bot vừa bị gỡ) ⇒ KHÔNG coi tin khách là đã xử lý', async () => {
    const bot = await createBot({ agentReplyMode: 'pause', agentPauseMinutes: 2 });
    const conv = await botConversation(bot);
    await sendStaff(conv.id, 'a');
    const hello = await addMessage(t.db, conv, { text: 'hello', sentAt: new Date() });
    // Nhân viên gỡ bot trong lúc nghỉ; tới giờ lượt đánh thức chạy.
    await t.db
      .update(conversations)
      .set({ chatbotId: null, aiMode: 'off', aiPausedUntil: null })
      .where(eq(conversations.id, conv.id));
    const out = await processAiReplyJob(t.db, kit.deps, conv.id, { wakeup: true });
    expect(out.status).toBe('skipped');
    const [run] = await runsOf(conv.id);
    expect(run).toMatchObject({ decision: 'no_reply', triggerMessageIds: [] });
    expect((await loadPendingMessages(t.db, conv.id)).map((m) => m.id)).toEqual([hello]);

    // Gắn lại bot ⇒ tin "hello" vẫn chờ ⇒ kick trả lời được.
    await t.db
      .update(conversations)
      .set({ chatbotId: bot.id, aiMode: 'auto' })
      .where(eq(conversations.id, conv.id));
    const reply = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(reply).toMatchObject({ status: 'done', decision: 'reply' });
    const replied = (await runsOf(conv.id)).find((r) => r.decision === 'reply');
    expect(replied!.triggerMessageIds).toEqual([hello]);
  });

  it('lượt THƯỜNG bị chặn vì bot đã gỡ ⇒ vẫn coi là đã xử lý như trước (không đổi)', async () => {
    const bot = await createBot();
    const conv = await botConversation(bot);
    const msg = await addMessage(t.db, conv, { text: 'hello', sentAt: new Date() });
    await t.db
      .update(conversations)
      .set({ chatbotId: null, aiMode: 'off' })
      .where(eq(conversations.id, conv.id));
    await processAiReplyJob(t.db, kit.deps, conv.id);
    const [run] = await runsOf(conv.id);
    expect(run!.triggerMessageIds).toEqual([msg]);
  });
});
