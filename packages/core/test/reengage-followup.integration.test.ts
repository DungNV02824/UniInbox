// "Tái chăm sóc — Khách không bị bỏ sót" (mode 'followup'): quét, xếp hàng, lượt ai-reply CHỦ ĐỘNG nhắn khơi gợi lại.
// Postgres thật (Testcontainers), Redis/scheduler/LLM giả.
import {
  aiRuns,
  auditLogs,
  chatbots,
  contacts,
  conversations,
  messages,
  projectLogs,
  type ChannelAccount,
  type Chatbot,
  type Conversation,
  type NewConversation,
} from '@dezon/db';
import {
  DEFAULT_CAPTURE_CONFIG,
  DEFAULT_PROJECT_LOG_CONFIG,
  REENGAGE_FOLLOWUP_MIN_IDLE_MINUTES,
  type CaptureConfig,
} from '@dezon/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InboxValidationError } from '../src/inbox/errors';
import { aiReengageJobId, type AiReengageJobOptions } from '../src/jobs';
import {
  previewChatbotReengage,
  REENGAGE_FOLLOWUP_TOOL_LOG,
  startChatbotReengage,
  type ReengageJob,
  type ReengageQueue,
} from '../src/ai/reengage';
import {
  AI_BLOCKED_FOLLOWUP_ALREADY_SENT,
  AI_BLOCKED_FOLLOWUP_CUSTOMER_WROTE,
  AI_BLOCKED_FOLLOWUP_LAST_FAILED,
  AI_BLOCKED_FOLLOWUP_RECENT_ACTIVITY,
  AI_BLOCKED_REENGAGE_BOT_CHANGED,
  AI_BLOCKED_REENGAGE_RESOLVED,
  AI_FOLLOWUP_DECLINED,
  processAiReplyJob,
} from '../src/ai/runtime';
import { loadPendingMessages } from '../src/ai/turn-input';
import type { LlmResponse } from '../src/ai/llm';
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

const DAY = 24 * HOUR;
const MIN = 60_000;

let t: TestDb;
let messenger: ChannelAccount;
let zalo: ChannelAccount;
let kit: AiTestKit;
const ctx = makeCtx();

beforeAll(async () => {
  t = await startTestDb();
  messenger = await createChannel(t.db, { displayName: 'Fanpage Dezon' });
  zalo = await createChannel(t.db, {
    type: 'zalo_personal',
    displayName: 'Zalo Dezon',
    ownerUserId: t.admin.id,
  });
});

afterAll(async () => {
  await t?.stop();
});

beforeEach(() => {
  kit = createAiKit(ctx);
});

let botSeq = 0;
async function createBot(values: Partial<typeof chatbots.$inferInsert> = {}): Promise<Chatbot> {
  const [bot] = await t.db
    .insert(chatbots)
    .values({ name: `Bot khơi gợi ${++botSeq}`, ...values })
    .returning();
  return bot!;
}

/** Hội thoại gắn bot, khách nhắn cách đây `agoMs` (chưa ai trả lời). */
async function missedWithId(
  bot: Chatbot,
  channel: ChannelAccount,
  agoMs: number,
  extra: Partial<NewConversation> = {},
): Promise<{ conv: Conversation; customerMessageId: string }> {
  const conv = await createConversation(t.db, {
    channel,
    contactName: 'Chị Lan',
    chatbotId: bot.id,
    aiMode: 'auto',
    lastCustomerMessageAt: ago(agoMs),
    ...extra,
  });
  const customerMessageId = await addMessage(t.db, conv, {
    text: 'Bên em thi công nhà phố không?',
    sentAt: ago(agoMs),
  });
  return { conv, customerMessageId };
}

const missed = async (...args: Parameters<typeof missedWithId>) => (await missedWithId(...args)).conv;

/**
 * Như missed nhưng bên mình (`by`, mặc định bot) đã trả lời cách đây `replyAgoMs`. Bot trả lời ⇒ có ai_runs nhận tin
 * khách (như lượt thật) để tin khách cũ không còn "chưa xử lý".
 */
async function answered(
  bot: Chatbot,
  channel: ChannelAccount,
  customerAgoMs: number,
  replyAgoMs: number,
  extra: Partial<NewConversation> & { by?: 'bot' | 'agent'; replyStatus?: 'sent' | 'failed' } = {},
): Promise<Conversation> {
  const { by = 'bot', replyStatus = 'sent', ...rest } = extra;
  const { conv, customerMessageId } = await missedWithId(bot, channel, customerAgoMs, rest);
  let aiRunId: string | null = null;
  if (by === 'bot') {
    const [run] = await t.db
      .insert(aiRuns)
      .values({
        conversationId: conv.id,
        chatbotId: bot.id,
        triggerMessageIds: [customerMessageId],
        model: 'gemini-test',
        decision: 'reply',
        createdAt: ago(replyAgoMs),
      })
      .returning({ id: aiRuns.id });
    aiRunId = run!.id;
  }
  await addMessage(t.db, conv, {
    senderType: by,
    text: 'Dạ bên em có nhận thi công nhà phố trọn gói ạ',
    status: replyStatus,
    aiRunId,
    sentAt: ago(replyAgoMs),
  });
  return conv;
}

/** Tin bot của một lượt "Khách không bị bỏ sót" (ai_runs.tool_calls mở đầu REENGAGE_FOLLOWUP_TOOL_LOG) lúc `agoMs`. */
async function addFollowUpNudge(bot: Chatbot, conv: Conversation, agoMs: number): Promise<void> {
  const [run] = await t.db
    .insert(aiRuns)
    .values({
      conversationId: conv.id,
      chatbotId: bot.id,
      triggerMessageIds: [],
      model: 'gemini-test',
      decision: 'reply',
      toolCalls: [{ name: REENGAGE_FOLLOWUP_TOOL_LOG, args: { mode: 'followup' } }],
      createdAt: ago(agoMs),
    })
    .returning({ id: aiRuns.id });
  await addMessage(t.db, conv, {
    senderType: 'bot',
    text: 'Dạ chị đã cân nhắc thêm về nhà phố chưa ạ?',
    status: 'sent',
    aiRunId: run!.id,
    sentAt: ago(agoMs),
  });
}

const ids = (items: { conversationId: string }[]) => items.map((i) => i.conversationId).sort();
const sorted = (...xs: string[]) => [...xs].sort();

/** Hàng đợi giả kiểu BullMQ (khe giãn cách chung, jobId cố định). */
function fakeQueue() {
  const jobs: ReengageJob[] = [];
  const held = new Set<string>();
  let nextSlot = 0;
  const queue: ReengageQueue = {
    pending: async (convIds) => new Set(convIds.filter((id) => held.has(aiReengageJobId(id)))),
    reserveSlot: async ({ nowMs, spacingMs, latestMs }) => {
      const slot = Math.max(nowMs, nextSlot);
      if (latestMs !== null && slot > latestMs) return null;
      nextSlot = slot + spacingMs;
      return slot;
    },
    enqueue: async (job) => {
      if (held.has(job.jobId)) return false;
      held.add(job.jobId);
      jobs.push(job);
      return true;
    },
  };
  return { jobs, queue };
}

const preview = (chatbotId: string, mode: 'missed' | 'followup', days = 15) =>
  previewChatbotReengage(t.db, ctx, chatbotId, days, fakeQueue().queue, mode);

/** Text part cuối của content cuối trong lần gọi LLM thứ i (dòng "(Bối cảnh lượt này)" + chỉ dẫn). */
function lastContextText(i: number): string {
  const contents = kit.llm.calls[i]!.contents;
  const parts = contents[contents.length - 1]!.parts;
  const last = parts[parts.length - 1]!;
  return 'text' in last ? last.text : '';
}

const runsOf = (conversationId: string) =>
  t.db.select().from(aiRuns).where(eq(aiRuns.conversationId, conversationId)).orderBy(asc(aiRuns.createdAt));

const botMessagesOf = (conversationId: string) =>
  t.db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.senderType, 'bot')))
    .orderBy(asc(messages.sentAt));

const followUp = (bot: Chatbot, extra: Partial<AiReengageJobOptions> = {}): AiReengageJobOptions => ({
  pendingMaxAgeHours: 15 * 24,
  chatbotId: bot.id,
  mode: 'followup',
  ...extra,
});

describe('previewChatbotReengage — Khách không bị bỏ sót', () => {
  it('phân loại: khách nhắn sau cùng ⇒ chỉ ở "bỏ sót"; bên mình nhắn sau cùng + đã lặng ⇒ followup; có tin trong khoảng lặng ⇒ loại; Messenger quá 24 giờ ⇒ outsideWindow', async () => {
    const bot = await createBot();
    const customerLast = await missed(bot, zalo, 2 * HOUR);
    const botLast = await answered(bot, zalo, 3 * HOUR, 2 * HOUR);
    const agentLast = await answered(bot, zalo, 5 * DAY, 4 * DAY, { by: 'agent' });
    const messengerOk = await answered(bot, messenger, 5 * HOUR, 4 * HOUR);
    const messengerOld = await answered(bot, messenger, 30 * HOUR, 29 * HOUR);
    // Vừa trò chuyện (tin bot / tin system trong khoảng lặng) ⇒ không chen vào.
    await answered(bot, zalo, 3 * HOUR, (REENGAGE_FOLLOWUP_MIN_IDLE_MINUTES - 10) * MIN);
    const withSystem = await answered(bot, zalo, 3 * HOUR, 2 * HOUR);
    await addMessage(t.db, withSystem, { senderType: 'system', text: 'Đã gắn nhãn', sentAt: ago(5 * MIN) });
    // Chỉ có echo tự động của Page sau tin khách ⇒ vẫn là khách bị bỏ sót, không phải followup.
    const awayEcho = await missed(bot, zalo, 3 * HOUR);
    await addMessage(t.db, awayEcho, {
      senderType: 'agent',
      text: 'Cảm ơn bạn đã nhắn tin',
      raw: { automatedEcho: true },
      sentAt: ago(3 * HOUR - 2_000),
    });
    // Loại như 'missed': đã xử lý, chờ người (bot dừng), đang tạm dừng, ai_mode off.
    await answered(bot, zalo, 3 * HOUR, 2 * HOUR, { status: 'resolved' });
    await answered(bot, zalo, 3 * HOUR, 2 * HOUR, { status: 'pending_human' });
    await answered(bot, zalo, 3 * HOUR, 2 * HOUR, { aiPausedUntil: new Date(Date.now() + 10 * MIN) });
    await answered(bot, zalo, 3 * HOUR, 2 * HOUR, { aiMode: 'off' });
    // Không có tin khách nào (chỉ tin bot) ⇒ loại.
    const noCustomer = await createConversation(t.db, {
      channel: zalo,
      contactName: 'Anh Tú',
      chatbotId: bot.id,
      aiMode: 'auto',
      lastCustomerMessageAt: ago(3 * HOUR),
    });
    await addMessage(t.db, noCustomer, { senderType: 'bot', text: 'Xin chào', sentAt: ago(2 * HOUR) });

    const follow = await preview(bot.id, 'followup');
    expect(ids(follow.eligible)).toEqual(sorted(botLast.id, agentLast.id, messengerOk.id));
    expect(ids(follow.outsideWindow)).toEqual([messengerOld.id]);
    expect(follow.outsideWindow[0]!.reason).toContain('24 giờ');
    const item = follow.eligible.find((i) => i.conversationId === botLast.id)!;
    expect(item).toMatchObject({
      waitingMessages: 0,
      lastCustomerText: 'Bên em thi công nhà phố không?',
      channelType: 'zalo_personal',
    });

    const miss = await preview(bot.id, 'missed');
    expect(ids(miss.eligible)).toEqual(sorted(customerLast.id, awayEcho.id));

    // Quá N ngày (tin khách cuối) ⇒ loại như 'missed'.
    expect(ids((await preview(bot.id, 'followup', 3)).eligible)).toEqual(sorted(botLast.id, messengerOk.id));
  });

  it('đã nhắn khơi gợi mà khách chưa đáp ⇒ không quét lại (không nhắn dồn); khách nhắn lại rồi bên mình trả lời ⇒ quét lại; tin cuối gửi thất bại ⇒ loại', async () => {
    const bot = await createBot();
    const nudged = await answered(bot, zalo, 5 * HOUR, 4 * HOUR);
    await addFollowUpNudge(bot, nudged, 2 * HOUR);
    // Đã nhắn khơi gợi từ trước, sau đó khách nhắn lại và bot đã trả lời ⇒ lại đủ điều kiện.
    const revived = await answered(bot, zalo, 9 * HOUR, 8 * HOUR);
    await addFollowUpNudge(bot, revived, 7 * HOUR);
    await addMessage(t.db, revived, { text: 'Dạ chị vẫn đang tính ạ', sentAt: ago(3 * HOUR) });
    await addMessage(t.db, revived, {
      senderType: 'bot',
      text: 'Dạ vâng ạ',
      status: 'sent',
      sentAt: ago(2 * HOUR),
    });
    // Câu trả lời của bot không tới được khách ⇒ không nhắn khơi gợi về điều khách chưa thấy.
    await answered(bot, zalo, 3 * HOUR, 2 * HOUR, { replyStatus: 'failed' });
    const ok = await answered(bot, zalo, 3 * HOUR, 2 * HOUR);

    expect(ids((await preview(bot.id, 'followup')).eligible)).toEqual(sorted(revived.id, ok.id));
  });

  it("bot 'continue': hội thoại chờ người vẫn được quét", async () => {
    const bot = await createBot({ aiHandoffMode: 'continue' });
    const conv = await answered(bot, zalo, 3 * HOUR, 2 * HOUR, { status: 'pending_human' });
    expect(ids((await preview(bot.id, 'followup')).eligible)).toEqual([conv.id]);
  });

  it('mode lạ ⇒ 400', async () => {
    const bot = await createBot();
    await expect(
      previewChatbotReengage(t.db, ctx, bot.id, 15, fakeQueue().queue, 'spam' as never),
    ).rejects.toBeInstanceOf(InboxValidationError);
  });
});

describe('startChatbotReengage — Khách không bị bỏ sót', () => {
  it('kiểm lại theo mode, job mang mode followup, audit ghi mode; id của "bỏ sót" bị bỏ qua', async () => {
    const bot = await createBot();
    const a = await answered(bot, zalo, 3 * DAY, 2 * DAY);
    const b = await answered(bot, messenger, 3 * HOUR, 2 * HOUR);
    const customerLast = await missed(bot, zalo, 2 * HOUR);

    const rec = fakeQueue();
    const result = await startChatbotReengage(
      t.db,
      ctx,
      {
        actorUserId: t.admin.id,
        chatbotId: bot.id,
        days: 15,
        mode: 'followup',
        conversationIds: [a.id, customerLast.id, b.id],
        content: ' Mời khảo sát miễn phí ',
      },
      rec.queue,
    );
    expect(result).toMatchObject({ queued: 2, alreadyQueued: 0, skipped: 1 });
    // Khung đóng sớm nhất trước (Messenger), Zalo cá nhân sau.
    expect(rec.jobs.map((j) => j.conversationId)).toEqual([b.id, a.id]);
    expect(rec.jobs[0]!.data.reengage).toEqual({
      pendingMaxAgeHours: 15 * 24,
      chatbotId: bot.id,
      content: 'Mời khảo sát miễn phí',
      mode: 'followup',
    });

    // Cùng các id ở mode 'missed' ⇒ chỉ khách nhắn sau cùng; job không ghi mode (giữ y như trước).
    const rec2 = fakeQueue();
    const missedResult = await startChatbotReengage(
      t.db,
      ctx,
      { actorUserId: t.admin.id, chatbotId: bot.id, days: 15, conversationIds: [a.id, customerLast.id] },
      rec2.queue,
    );
    expect(missedResult).toMatchObject({ queued: 1, skipped: 1 });
    expect(rec2.jobs[0]!.data.reengage).toEqual({ pendingMaxAgeHours: 15 * 24, chatbotId: bot.id });

    const audits = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'chatbot.reengage'), eq(auditLogs.entityId, bot.id)));
    expect(audits.map((x) => x.data)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mode: 'followup', requested: 3, queued: 2, skipped: 1, contentChars: 21 }),
        expect.objectContaining({ mode: 'missed', requested: 2, queued: 1, skipped: 1 }),
      ]),
    );
  });
});

const CAPTURE_ON: CaptureConfig = {
  ...DEFAULT_CAPTURE_CONFIG,
  enabled: true,
  projectLog: { ...DEFAULT_PROJECT_LOG_CONFIG, enabled: true },
};

describe('processAiReplyJob — lượt Khách không bị bỏ sót', () => {
  it('bot chủ động nhắn: chỉ tool reply, ghi chú khơi gợi + chỉ dẫn quản trị, ai_runs trigger rỗng, gửi tin bot; không thu thập / nhật ký', async () => {
    const bot = await createBot({ capture: CAPTURE_ON });
    const conv = await answered(bot, zalo, 3 * DAY, 2 * DAY);
    kit.redis.store.set(`debounce:${conv.id}:first`, '1');
    const reply: LlmResponse = {
      functionCall: {
        name: 'reply',
        args: {
          messages: [
            'Dạ chào chị, chị đã cân nhắc thêm về nhà phố chưa ạ?',
            'Bên em có lịch khảo sát miễn phí ạ',
          ],
          confidence: 0.3,
          captured: { phone: '0912345678', need: 'Thi công nhà phố' },
          project_logs: [{ dia_chi: '1 Lê Lợi' }],
        },
      },
      text: null,
      usage: { inputTokens: 100, outputTokens: 20 },
      model: 'gemini-test',
    };
    kit.llm.impl = async () => reply;

    const out = await processAiReplyJob(t.db, kit.deps, conv.id, {
      reengage: followUp(bot, {
        rules: 'Xưng em, gọi chị; nhẹ nhàng',
        content: 'Mời khách đặt lịch khảo sát miễn phí',
      }),
    });
    // Độ tự tin thấp không thành chuyển người.
    expect(out).toMatchObject({ status: 'done', decision: 'reply' });
    expect(kit.llm.calls).toHaveLength(1);
    const call = kit.llm.calls[0]!;
    expect(call.tools.map((tool) => tool.name)).toEqual(['reply', 'no_reply']);
    const note = lastContextText(0);
    expect(note).toContain('CHƯA nhắn gì thêm');
    expect(note).toContain('KHÔNG lặp lại nguyên văn');
    expect(note).not.toContain('xin lỗi ngắn gọn');
    expect(note.indexOf('CHƯA nhắn gì thêm')).toBeLessThan(note.indexOf('Quy tắc chăm sóc:'));
    expect(note).toContain('Quy tắc chăm sóc:\nXưng em, gọi chị; nhẹ nhàng');
    expect(note).toContain('Mời khách đặt lịch khảo sát miễn phí');
    expect(call.systemInstruction).not.toContain('CHƯA nhắn gì thêm');
    // Lịch sử có tin cũ của khách + bot; không có dấu "tin mới".
    const allText = call.contents.flatMap((c) => c.parts.map((p) => ('text' in p ? p.text : ''))).join('\n');
    expect(allText).toContain('Bên em thi công nhà phố không?');

    const [run] = (await runsOf(conv.id)).slice(-1);
    expect(run).toMatchObject({ decision: 'reply', triggerMessageIds: [], chatbotId: bot.id });
    expect((run!.toolCalls as { name: string }[])[0]).toMatchObject({
      name: REENGAGE_FOLLOWUP_TOOL_LOG,
      args: { mode: 'followup', rulesChars: 27, contentChars: 36 },
    });
    expect(JSON.stringify((run!.toolCalls as unknown[])[0])).not.toContain('Xưng em');

    const bots = await botMessagesOf(conv.id);
    const sent = bots.filter((m) => m.aiRunId === run!.id);
    expect(sent.map((m) => m.text)).toEqual(reply.functionCall!.args.messages as string[]);
    expect(sent.every((m) => m.status === 'queued')).toBe(true);
    expect(kit.scheduler.outbound.map((o) => o.messageId)).toEqual(sent.map((m) => m.id));
    expect(kit.scheduler.outbound[0]!.delayMs).toBe(0);
    expect(kit.scheduler.outbound[1]!.delayMs).toBeGreaterThan(0);
    expect(kit.publisher.events.filter((e) => e.event === 'message.created')).toHaveLength(2);

    // Không thu thập thông tin, không nhật ký công trình, không đụng khóa debounce.
    const [contact] = await t.db
      .select({ phone: contacts.phone })
      .from(contacts)
      .where(eq(contacts.id, conv.contactId));
    expect(contact!.phone).toBeNull();
    expect(await t.db.select().from(projectLogs).where(eq(projectLogs.conversationId, conv.id))).toEqual([]);
    expect(kit.redis.store.has(`debounce:${conv.id}:first`)).toBe(true);

    // Chạy lại (job trùng / BullMQ thử lại) ⇒ tin bot vừa tạo nằm trong khoảng lặng ⇒ bỏ qua, không gọi AI.
    const again = await processAiReplyJob(t.db, kit.deps, conv.id, { reengage: followUp(bot) });
    expect(again).toMatchObject({ status: 'skipped', reason: AI_BLOCKED_FOLLOWUP_RECENT_ACTIVITY });
    expect(kit.llm.calls).toHaveLength(1);

    // Khách lờ tin khơi gợi; hết khoảng lặng, admin bấm lần nữa ⇒ KHÔNG nhắn thêm (không nhắn dồn), không gọi AI.
    await t.db
      .update(messages)
      .set({ sentAt: ago(2 * HOUR) })
      .where(and(eq(messages.conversationId, conv.id), eq(messages.aiRunId, run!.id)));
    expect(ids((await preview(bot.id, 'followup')).eligible)).not.toContain(conv.id);
    const third = await processAiReplyJob(t.db, kit.deps, conv.id, { reengage: followUp(bot) });
    expect(third).toMatchObject({ status: 'skipped', reason: AI_BLOCKED_FOLLOWUP_ALREADY_SENT });
    expect(kit.llm.calls).toHaveLength(1);
    expect((await runsOf(conv.id)).at(-1)).toMatchObject({
      decision: 'no_reply',
      error: AI_BLOCKED_FOLLOWUP_ALREADY_SENT,
    });
    expect(kit.scheduler.outbound).toHaveLength(2);
  });

  it('tin cuối của bên mình gửi thất bại ⇒ bỏ qua, không gọi AI', async () => {
    const bot = await createBot();
    const conv = await answered(bot, zalo, 3 * HOUR, 2 * HOUR, { replyStatus: 'failed' });
    const out = await processAiReplyJob(t.db, kit.deps, conv.id, { reengage: followUp(bot) });
    expect(out).toMatchObject({ status: 'skipped', reason: AI_BLOCKED_FOLLOWUP_LAST_FAILED });
    expect(kit.llm.calls).toHaveLength(0);
    expect(kit.scheduler.outbound).toHaveLength(0);
  });

  it('khách đã nhắn sau lúc bấm ⇒ bỏ qua (luồng thường lo), không nuốt tin, không gọi AI', async () => {
    const bot = await createBot();
    const conv = await answered(bot, zalo, 3 * HOUR, 2 * HOUR);
    await addMessage(t.db, conv, { text: 'Cho chị xin báo giá', sentAt: ago(2 * MIN) });

    const out = await processAiReplyJob(t.db, kit.deps, conv.id, { reengage: followUp(bot) });
    expect(out).toMatchObject({ status: 'skipped', reason: AI_BLOCKED_FOLLOWUP_CUSTOMER_WROTE });
    expect(kit.llm.calls).toHaveLength(0);
    const runs = await runsOf(conv.id);
    expect(runs.at(-1)).toMatchObject({ decision: 'no_reply', triggerMessageIds: [] });
    expect(runs.at(-1)!.error).toBe(AI_BLOCKED_FOLLOWUP_CUSTOMER_WROTE);
    expect(await loadPendingMessages(t.db, conv.id)).toHaveLength(1);
    expect(kit.scheduler.outbound).toHaveLength(0);
  });

  it('không còn đủ điều kiện (vừa có tin nhân viên, đã xử lý, đổi bot, ngoài khung Messenger) ⇒ bỏ qua, ghi lý do, không gọi AI', async () => {
    const bot = await createBot();
    const recent = await answered(bot, zalo, 3 * HOUR, 2 * HOUR);
    await addMessage(t.db, recent, {
      senderType: 'agent',
      text: 'Chị cần thêm gì không ạ',
      sentAt: ago(5 * MIN),
    });
    const out1 = await processAiReplyJob(t.db, kit.deps, recent.id, { reengage: followUp(bot) });
    expect(out1).toMatchObject({ status: 'skipped', reason: AI_BLOCKED_FOLLOWUP_RECENT_ACTIVITY });

    const resolved = await answered(bot, zalo, 3 * HOUR, 2 * HOUR, { status: 'resolved' });
    const out2 = await processAiReplyJob(t.db, kit.deps, resolved.id, { reengage: followUp(bot) });
    expect(out2).toMatchObject({ status: 'skipped', reason: AI_BLOCKED_REENGAGE_RESOLVED });

    const other = await createBot();
    const moved = await answered(other, zalo, 3 * HOUR, 2 * HOUR);
    const out3 = await processAiReplyJob(t.db, kit.deps, moved.id, { reengage: followUp(bot) });
    expect(out3).toMatchObject({ status: 'skipped', reason: AI_BLOCKED_REENGAGE_BOT_CHANGED });

    const stale = await answered(bot, messenger, 30 * HOUR, 29 * HOUR);
    const out4 = await processAiReplyJob(t.db, kit.deps, stale.id, { reengage: followUp(bot) });
    expect(out4).toMatchObject({ status: 'skipped' });
    expect((out4 as { reason: string }).reason).toContain('Không được gửi');

    for (const conv of [recent, resolved, moved, stale]) {
      const runs = await runsOf(conv.id);
      expect(runs.at(-1)).toMatchObject({ decision: 'no_reply', triggerMessageIds: [] });
      expect((runs.at(-1)!.toolCalls as { name: string }[])[0]!.name).toBe(REENGAGE_FOLLOWUP_TOOL_LOG);
    }
    expect(kit.llm.calls).toHaveLength(0);
    expect(kit.scheduler.outbound).toHaveLength(0);
  });

  it('khách nhắn trong lúc gọi AI ⇒ hủy dưới khóa, không gửi tin bot', async () => {
    const bot = await createBot();
    const conv = await answered(bot, zalo, 3 * HOUR, 2 * HOUR);
    kit.llm.impl = async () => {
      await addMessage(t.db, conv, { text: 'Chị đang định hỏi đây', sentAt: new Date() });
      return llmReply(['Dạ chị còn quan tâm nhà phố không ạ?']);
    };
    const out = await processAiReplyJob(t.db, kit.deps, conv.id, { reengage: followUp(bot) });
    expect(out).toMatchObject({ status: 'cancelled', reason: AI_BLOCKED_FOLLOWUP_CUSTOMER_WROTE });
    const runs = await runsOf(conv.id);
    expect(runs.at(-1)).toMatchObject({ decision: 'no_reply', triggerMessageIds: [] });
    expect(runs.at(-1)!.error).toBe(`Đã hủy: ${AI_BLOCKED_FOLLOWUP_CUSTOMER_WROTE}`);
    expect((await botMessagesOf(conv.id)).filter((m) => m.status === 'queued')).toHaveLength(0);
    expect(kit.scheduler.outbound).toHaveLength(0);
    // Tin khách vẫn chờ cho luồng thường.
    expect(await loadPendingMessages(t.db, conv.id)).toHaveLength(1);
  });

  it('AI không gọi reply / lỗi AI ⇒ không gửi gì, không chuyển người', async () => {
    const bot = await createBot();
    const conv = await answered(bot, zalo, 3 * HOUR, 2 * HOUR);
    kit.llm.impl = async () => ({
      functionCall: null,
      text: null,
      usage: { inputTokens: 10, outputTokens: 0 },
      model: 'gemini-test',
    });
    const out = await processAiReplyJob(t.db, kit.deps, conv.id, { reengage: followUp(bot) });
    expect(out).toMatchObject({ status: 'done', decision: 'error' });
    const [cur] = await t.db
      .select({ status: conversations.status })
      .from(conversations)
      .where(eq(conversations.id, conv.id));
    expect(cur!.status).not.toBe('pending_human');
    expect((await runsOf(conv.id)).at(-1)).toMatchObject({ decision: 'error', triggerMessageIds: [] });
    expect(kit.scheduler.outbound).toHaveLength(0);
    expect(kit.publisher.events.filter((e) => e.event === 'handoff.created')).toHaveLength(0);

    // Khách đã bảo đừng nhắn nữa ⇒ model gọi no_reply ⇒ ghi no_reply kèm lý do, không gửi.
    const conv2 = await answered(bot, zalo, 3 * HOUR, 2 * HOUR);
    await addMessage(t.db, conv2, {
      text: 'Thôi em không cần nữa, đừng nhắn nữa nhé',
      sentAt: ago(100 * MIN),
    });
    await addMessage(t.db, conv2, {
      senderType: 'bot',
      text: 'Dạ vâng ạ',
      status: 'sent',
      sentAt: ago(90 * MIN),
    });
    kit.llm.impl = async () => ({
      functionCall: { name: 'no_reply', args: { reason: 'Khách đã bảo đừng nhắn nữa' } },
      text: null,
      usage: { inputTokens: 10, outputTokens: 2 },
      model: 'gemini-test',
    });
    const out2 = await processAiReplyJob(t.db, kit.deps, conv2.id, { reengage: followUp(bot) });
    expect(out2).toMatchObject({ status: 'done', decision: 'no_reply' });
    expect(kit.llm.calls.at(-1)!.tools.map((tool) => tool.name)).toContain('no_reply');
    expect((await runsOf(conv2.id)).at(-1)!.error).toBe(
      `${AI_FOLLOWUP_DECLINED}: Khách đã bảo đừng nhắn nữa`,
    );
    expect(kit.scheduler.outbound).toHaveLength(0);
    expect(await botMessagesOf(conv2.id)).toHaveLength(2);
  });
});
