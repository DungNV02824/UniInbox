// Vòng đời handoff khi đóng hội thoại bằng "Xong", bật lại bot, chống handoff mở trùng, điều kiện "kick" bot,
// thứ tự hội thoại bị gỡ khi xóa bot. Postgres thật (Testcontainers), Redis/scheduler/LLM/Lark giả.
import { chatbots, conversations, handoffs, type ChannelAccount, type Chatbot } from '@dezon/db';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { escalateConversation, processHandoffReminderJob } from '../src/ai/escalate';
import { deleteChatbot, needsChatbotKick, setConversationChatbot } from '../src/ai/service';
import { updateConversation } from '../src/inbox/commands';
import { createAiKit } from './helpers/ai-fakes';
import {
  addMessage,
  ago,
  createChannel,
  createConversation,
  makeCtx,
  startTestDb,
  type TestDb,
} from './inbox-fixtures';

let t: TestDb;
let channel: ChannelAccount;
const ctx = makeCtx();
const MIN = 60_000;

beforeAll(async () => {
  t = await startTestDb();
  channel = await createChannel(t.db);
});

afterAll(async () => {
  await t?.stop();
});

async function createBot(values: Partial<typeof chatbots.$inferInsert> = {}): Promise<Chatbot> {
  const [bot] = await t.db
    .insert(chatbots)
    .values({ name: `Bot ${Math.random().toString(36).slice(2, 8)}`, ...values })
    .returning();
  return bot!;
}

/** Hội thoại đang chờ người (như sau escalate): ai_mode off, GIỮ chatbot_id, một handoff mở. */
async function pendingHumanConversation(bot: Chatbot) {
  const conv = await createConversation(t.db, {
    channel,
    chatbotId: bot.id,
    aiMode: 'off',
    status: 'pending_human',
    handoffReason: 'discount',
    handoffAt: new Date(),
    lastCustomerMessageAt: new Date(),
  });
  await addMessage(t.db, conv, { sentAt: ago(2 * MIN), text: 'Giảm giá được không?' });
  await t.db
    .insert(handoffs)
    .values({ conversationId: conv.id, reasonCode: 'discount', summary: 'Khách xin giảm', createdBy: 'ai' });
  return conv;
}

const openHandoffs = (conversationId: string) =>
  t.db
    .select()
    .from(handoffs)
    .where(and(eq(handoffs.conversationId, conversationId), isNull(handoffs.resolvedAt)));

const convRow = async (id: string) =>
  (await t.db.select().from(conversations).where(eq(conversations.id, id)))[0]!;

describe('đóng hội thoại đang chờ người bằng "Xong"', () => {
  it('đóng handoff, xóa lý do, GIỮ ai_mode off; lần chuyển người sau tạo handoff mới (chỉ một handoff mở)', async () => {
    const bot = await createBot();
    const conv = await pendingHumanConversation(bot);

    const res = await updateConversation(t.db, t.agent, conv.id, { status: 'resolved' }, ctx);
    expect(res.conversation).toMatchObject({
      status: 'resolved',
      aiMode: 'off',
      chatbot: { id: bot.id },
      handoff: null,
    });
    expect(await openHandoffs(conv.id)).toHaveLength(0);
    const [closed] = await t.db.select().from(handoffs).where(eq(handoffs.conversationId, conv.id));
    expect(closed!.resolvedAt).toBeTruthy();
    expect(closed!.acknowledgedBy).toBe(t.agent.id);
    expect(await convRow(conv.id)).toMatchObject({ handoffReason: null, handoffAt: null });

    // Khách nhắn lại (pipeline mở lại thành 'open'), AI chuyển người lần nữa ⇒ handoff mới, không trùng.
    await t.db.update(conversations).set({ status: 'open' }).where(eq(conversations.id, conv.id));
    const kit = createAiKit(ctx);
    const again = await escalateConversation(t.db, kit.deps, conv.id, {
      reasonCode: 'complaint',
      summary: 'Khách phàn nàn',
      createdBy: 'ai',
    });
    expect(again.created).toBe(true);
    const open = await openHandoffs(conv.id);
    expect(open.map((h) => h.id)).toEqual([again.handoffId]);
    expect((await convRow(conv.id)).status).toBe('pending_human');
  });

  it('pending_human ⇒ open bằng PATCH status cũng đóng handoff', async () => {
    const conv = await pendingHumanConversation(await createBot());
    const res = await updateConversation(t.db, t.agent, conv.id, { status: 'open' }, ctx);
    expect(res.conversation).toMatchObject({ status: 'open', aiMode: 'off', handoff: null });
    expect(await openHandoffs(conv.id)).toHaveLength(0);
  });
});

describe('escalate với handoff mở sót lại', () => {
  it('hội thoại không ở pending_human nhưng còn handoff mở ⇒ đóng cái cũ, tạo một cái mới', async () => {
    const bot = await createBot();
    const conv = await createConversation(t.db, { channel, chatbotId: bot.id, aiMode: 'auto' });
    await addMessage(t.db, conv, { sentAt: ago(MIN), text: 'alo' });
    const [stale] = await t.db
      .insert(handoffs)
      .values({ conversationId: conv.id, reasonCode: 'other', summary: 'cũ', createdBy: 'ai' })
      .returning();
    const kit = createAiKit(ctx);
    const res = await escalateConversation(t.db, kit.deps, conv.id, {
      reasonCode: 'human_request',
      summary: 'Khách muốn gặp nhân viên',
      createdBy: 'ai',
    });
    expect(res.created).toBe(true);
    expect(res.handoffId).not.toBe(stale!.id);
    expect((await openHandoffs(conv.id)).map((h) => h.id)).toEqual([res.handoffId]);

    // Gọi lại khi đã pending_human ⇒ dùng lại handoff đang mở.
    const dup = await escalateConversation(t.db, kit.deps, conv.id, {
      reasonCode: 'other',
      summary: 'x',
      createdBy: 'ai',
    });
    expect(dup).toEqual({ handoffId: res.handoffId, created: false, botMessagesQueued: 0 });
    expect(await openHandoffs(conv.id)).toHaveLength(1);
  });
});

describe('bật lại bot', () => {
  it('chọn lại đúng bot đang gắn khi ai_mode off ⇒ ai_mode auto, xóa tạm dừng', async () => {
    const bot = await createBot();
    const conv = await createConversation(t.db, {
      channel,
      chatbotId: bot.id,
      aiMode: 'off',
      status: 'resolved',
      aiPausedUntil: new Date(Date.now() + 10 * MIN),
    });
    const res = await setConversationChatbot(t.db, t.agent, conv.id, bot.id, ctx);
    expect(res.conversation).toMatchObject({ aiMode: 'auto', aiPausedUntil: null, status: 'resolved' });
  });

  it('bật bot khi đang pending_human ⇒ như "trả lại cho AI" (đóng handoff, mở lại); tắt bot thì giữ chờ người', async () => {
    const bot = await createBot();
    const keep = await pendingHumanConversation(bot);
    const off = await setConversationChatbot(t.db, t.agent, keep.id, null, ctx);
    expect(off.conversation).toMatchObject({ status: 'pending_human', aiMode: 'off', chatbot: null });
    expect(await openHandoffs(keep.id)).toHaveLength(1);

    const conv = await pendingHumanConversation(bot);
    const on = await setConversationChatbot(t.db, t.agent, conv.id, bot.id, ctx);
    expect(on.conversation).toMatchObject({
      status: 'open',
      aiMode: 'auto',
      handoff: null,
      chatbot: { id: bot.id },
    });
    expect(await openHandoffs(conv.id)).toHaveLength(0);
    expect(await convRow(conv.id)).toMatchObject({ handoffReason: null, handoffAt: null });
  });
});

describe('needsChatbotKick', () => {
  it('chỉ khi bot bật, không chờ người, không tạm dừng và tin cuối (bỏ qua system) là của khách', async () => {
    const bot = await createBot();
    const now = new Date();
    const conv = await createConversation(t.db, { channel, chatbotId: bot.id, aiMode: 'auto' });
    expect(await needsChatbotKick(t.db, conv.id, now)).toBe(false); // chưa có tin

    await addMessage(t.db, conv, { sentAt: ago(3 * MIN), text: 'Cho hỏi giá' });
    await addMessage(t.db, conv, { sentAt: ago(2 * MIN), senderType: 'system', text: 'AI đã chuyển…' });
    expect(await needsChatbotKick(t.db, conv.id, now)).toBe(true);

    await t.db
      .update(conversations)
      .set({ aiPausedUntil: new Date(Date.now() + 10 * MIN) })
      .where(eq(conversations.id, conv.id));
    expect(await needsChatbotKick(t.db, conv.id, now)).toBe(false);
    await t.db.update(conversations).set({ aiPausedUntil: null }).where(eq(conversations.id, conv.id));

    await t.db.update(conversations).set({ status: 'pending_human' }).where(eq(conversations.id, conv.id));
    expect(await needsChatbotKick(t.db, conv.id, now)).toBe(false);
    await t.db
      .update(conversations)
      .set({ status: 'open', aiMode: 'off' })
      .where(eq(conversations.id, conv.id));
    expect(await needsChatbotKick(t.db, conv.id, now)).toBe(false);
    await t.db.update(conversations).set({ aiMode: 'auto' }).where(eq(conversations.id, conv.id));

    await t.db.update(chatbots).set({ isActive: false }).where(eq(chatbots.id, bot.id));
    expect(await needsChatbotKick(t.db, conv.id, now)).toBe(false);
    await t.db.update(chatbots).set({ isActive: true }).where(eq(chatbots.id, bot.id));

    await addMessage(t.db, conv, {
      sentAt: ago(MIN),
      senderType: 'agent',
      senderUserId: t.agent.id,
      text: 'Dạ',
    });
    expect(await needsChatbotKick(t.db, conv.id, now)).toBe(false);
  });
});

describe('xóa bot', () => {
  it('trả hội thoại bị gỡ theo last_message_at mới nhất trước', async () => {
    const bot = await createBot();
    const old = await createConversation(t.db, {
      channel,
      chatbotId: bot.id,
      aiMode: 'auto',
      lastMessageAt: ago(60 * MIN),
    });
    const recent = await createConversation(t.db, {
      channel,
      chatbotId: bot.id,
      aiMode: 'auto',
      lastMessageAt: ago(MIN),
    });
    const mid = await createConversation(t.db, {
      channel,
      chatbotId: bot.id,
      aiMode: 'auto',
      lastMessageAt: ago(10 * MIN),
    });
    const res = await deleteChatbot(t.db, t.admin.id, bot.id);
    expect(res.detachedConversationIds).toEqual([recent.id, mid.id, old.id]);
  });
});

describe('nhắc lại "chưa ai nhận hội thoại" theo từng bot (handoffReminderMin)', () => {
  const escalate = (kit: ReturnType<typeof createAiKit>, conversationId: string) =>
    escalateConversation(t.db, kit.deps, conversationId, {
      reasonCode: 'human_request',
      summary: 'Khách muốn gặp nhân viên',
      createdBy: 'ai',
    });

  it('bot để 0 (mặc định) ⇒ không lên lịch nhắc dù env > 0; job đã xếp sẵn cũng không nhắc', async () => {
    const bot = await createBot();
    expect(bot.handoffReminderMin).toBe(0);
    const conv = await createConversation(t.db, { channel, chatbotId: bot.id, aiMode: 'auto' });
    const kit = createAiKit(ctx);
    expect(kit.deps.config.handoffReminderMin).toBe(15);
    const res = await escalate(kit, conv.id);
    expect(res.created).toBe(true);
    expect(kit.scheduler.reminders).toEqual([]);

    const before = kit.lark.calls.length;
    expect(
      await processHandoffReminderJob(t.db, kit.deps, { conversationId: conv.id, handoffId: res.handoffId }),
    ).toBe(false);
    expect(kit.lark.calls).toHaveLength(before);
  });

  it('bot > 0 ⇒ lên lịch theo số phút của bot; tắt (0) trước giờ nhắc ⇒ job không nhắc', async () => {
    const bot = await createBot({ handoffReminderMin: 20 });
    const conv = await createConversation(t.db, { channel, chatbotId: bot.id, aiMode: 'auto' });
    const kit = createAiKit(ctx);
    const res = await escalate(kit, conv.id);
    expect(kit.scheduler.reminders).toEqual([
      { data: { conversationId: conv.id, handoffId: res.handoffId }, delayMs: 20 * MIN },
    ]);
    const data = { conversationId: conv.id, handoffId: res.handoffId };

    expect(await processHandoffReminderJob(t.db, kit.deps, data)).toBe(true);
    expect(kit.lark.calls).toHaveLength(2);
    const reminder = kit.publisher.events.filter((e) => e.event === 'handoff.created').at(-1)!;
    expect(reminder.payload).toMatchObject({ conversationId: conv.id, reminder: true });

    await t.db.update(chatbots).set({ handoffReminderMin: 0 }).where(eq(chatbots.id, bot.id));
    expect(await processHandoffReminderJob(t.db, kit.deps, data)).toBe(false);
    expect(kit.lark.calls).toHaveLength(2);
  });

  it('hội thoại không có bot ⇒ dùng env (HANDOFF_ESCALATE_AFTER_MIN); env 0 ⇒ không nhắc', async () => {
    const conv = await createConversation(t.db, { channel });
    const kit = createAiKit(ctx);
    const res = await escalateConversation(t.db, kit.deps, conv.id, {
      reasonCode: 'other',
      summary: 'Nhân viên chuyển tay',
      createdBy: 'user',
      createdByUserId: t.agent.id,
    });
    expect(kit.scheduler.reminders).toEqual([
      { data: { conversationId: conv.id, handoffId: res.handoffId }, delayMs: 15 * MIN },
    ]);
    const data = { conversationId: conv.id, handoffId: res.handoffId };
    expect(await processHandoffReminderJob(t.db, kit.deps, data)).toBe(true);

    const off = createAiKit(ctx);
    off.deps.config.handoffReminderMin = 0;
    expect(await processHandoffReminderJob(t.db, off.deps, data)).toBe(false);
    expect(off.lark.calls).toHaveLength(0);

    const conv2 = await createConversation(t.db, { channel });
    await escalateConversation(t.db, off.deps, conv2.id, {
      reasonCode: 'other',
      summary: 'x',
      createdBy: 'user',
      createdByUserId: t.agent.id,
    });
    expect(off.scheduler.reminders).toEqual([]);
  });
});
