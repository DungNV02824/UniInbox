// "Khi AI tự chuyển người thật": chatbots.ai_handoff_mode 'continue' — vẫn pending_human + handoff + Lark nhưng
// ai_mode giữ 'auto', bot vẫn trả lời. Postgres thật (Testcontainers), Redis/scheduler/LLM/Lark giả.
import {
  aiRuns,
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
import type { LlmResponse } from '../src/ai/llm';
import { handoffContinueTurnNote } from '../src/ai/prompt';
import {
  escalateConversation,
  HANDOFF_BOT_STOPPED_SUFFIX,
  HANDOFF_REPEAT_NOTIFY_THROTTLE_MIN,
  HANDOFF_REPEAT_PREFIX,
  HANDOFF_SYSTEM_PREFIX,
  maybeScheduleChatbotReply,
  processAiReplyJob,
} from '../src/ai/runtime';
import {
  ackHandoff,
  createChatbot,
  getChatbot,
  needsChatbotKick,
  resolveHandoff,
  updateChatbot,
} from '../src/ai/service';
import { getConversationSummary } from '../src/inbox/queries';
import { createAiKit, llmReply, type AiTestKit } from './helpers/ai-fakes';
import {
  addMessage,
  createChannel,
  createConversation,
  makeCtx,
  startTestDb,
  type TestDb,
} from './inbox-fixtures';

let t: TestDb;
let channel: ChannelAccount;
let kit: AiTestKit;
const ctx = makeCtx();

const PHOTOS_OK = 'Dạ em đã nhận đủ ảnh và chuyển thông tin cho bộ phận kiểm tra ạ.';

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
    contactName: 'Anh Tuấn',
    chatbotId: bot.id,
    aiMode: 'auto',
    lastCustomerMessageAt: new Date(),
    ...extra,
  });
}

const convRow = async (id: string) =>
  (await t.db.select().from(conversations).where(eq(conversations.id, id)))[0]!;

const handoffsOf = (conversationId: string) =>
  t.db.select().from(handoffs).where(eq(handoffs.conversationId, conversationId));

const openHandoffs = (conversationId: string) =>
  t.db
    .select()
    .from(handoffs)
    .where(and(eq(handoffs.conversationId, conversationId), isNull(handoffs.resolvedAt)));

const messagesOf = (conversationId: string) =>
  t.db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.sentAt), asc(messages.id));

const runsOf = (conversationId: string) =>
  t.db.select().from(aiRuns).where(eq(aiRuns.conversationId, conversationId)).orderBy(asc(aiRuns.createdAt));

function llmEscalate(messagesToCustomer?: string[], summary = 'CTV gửi 7 ảnh công trình'): LlmResponse {
  return {
    functionCall: {
      name: 'escalate',
      args: {
        reason_code: 'other',
        summary_for_agent: summary,
        ...(messagesToCustomer ? { messages_to_customer: messagesToCustomer } : {}),
      },
    },
    text: null,
    usage: { inputTokens: 1, outputTokens: 1 },
    model: 'gemini-test',
  };
}

/** Text part cuối của content cuối trong lần gọi LLM thứ i (dòng "(Bối cảnh lượt này)"). */
function lastContextText(i: number): string {
  const contents = kit.llm.calls[i]!.contents;
  const parts = contents[contents.length - 1]!.parts;
  const last = parts[parts.length - 1]!;
  return 'text' in last ? last.text : '';
}

const allPromptText = (i: number) =>
  kit.llm.calls[i]!.contents.map((c) => c.parts.map((p) => ('text' in p ? p.text : '')).join('\n')).join(
    '\n',
  );

/** Kịch bản thật: CTV gửi ảnh ⇒ AI escalate kèm messages_to_customer. Trả hội thoại đã ở "Cần người". */
async function escalatedContinueConversation(botValues: Partial<typeof chatbots.$inferInsert> = {}) {
  const bot = await createBot({ aiHandoffMode: 'continue', handoffReminderMin: 20, ...botValues });
  const conv = await botConversation(bot);
  await addMessage(t.db, conv, { text: 'Em gửi 7 ảnh công trình', sentAt: new Date(Date.now() - 2000) });
  kit.llm.impl = async () => llmEscalate([PHOTOS_OK]);
  const out = await processAiReplyJob(t.db, kit.deps, conv.id);
  expect(out).toMatchObject({ status: 'done', decision: 'escalate' });
  return { bot, conv, out };
}

beforeAll(async () => {
  t = await startTestDb();
  channel = await createChannel(t.db, { displayName: 'Vua Thầu' });
});

afterAll(async () => {
  await t?.stop();
});

beforeEach(() => {
  kit = createAiKit(ctx);
});

describe("aiHandoffMode 'continue' — AI tự chuyển người", () => {
  it('escalate ⇒ pending_human + handoff + tin system + Lark + nhắc lại, ai_mode GIỮ auto; read model aiHandoffContinues', async () => {
    const { bot, conv, out } = await escalatedContinueConversation();

    expect(await convRow(conv.id)).toMatchObject({
      status: 'pending_human',
      aiMode: 'auto',
      chatbotId: bot.id,
      handoffReason: 'other',
    });
    const hs = await handoffsOf(conv.id);
    expect(hs).toHaveLength(1);
    expect(hs[0]).toMatchObject({ createdBy: 'ai', resolvedAt: null, summary: 'CTV gửi 7 ảnh công trình' });
    const msgs = await messagesOf(conv.id);
    expect(msgs.filter((m) => m.senderType === 'bot').map((m) => m.text)).toEqual([PHOTOS_OK]);
    expect(msgs.filter((m) => m.senderType === 'system').map((m) => m.text)).toEqual([
      `${HANDOFF_SYSTEM_PREFIX}Lý do khác`,
    ]);
    expect(msgs.find((m) => m.senderType === 'bot')!.aiRunId).toBe(out.aiRunId);
    expect(kit.publisher.events.filter((e) => e.event === 'handoff.created')).toHaveLength(1);
    expect(kit.lark.calls).toHaveLength(1);
    expect(kit.scheduler.reminders).toEqual([
      { data: { conversationId: conv.id, handoffId: hs[0]!.id }, delayMs: 20 * 60_000 },
    ]);

    const summary = await getConversationSummary(t.db, conv.id, ctx);
    expect(summary).toMatchObject({ status: 'pending_human', aiMode: 'auto' });
    expect(summary.chatbot).toEqual({ id: bot.id, name: bot.name, aiHandoffContinues: true });
    expect(summary.handoff).toMatchObject({ reasonCode: 'other' });
  });

  it('khách nhắn "hello" khi đang Cần người ⇒ bot VẪN trả lời; prompt biết đã chuyển; vẫn pending_human', async () => {
    const { conv } = await escalatedContinueConversation();
    await addMessage(t.db, conv, { text: 'hello', sentAt: new Date() });
    expect(await needsChatbotKick(t.db, conv.id, new Date())).toBe(true);
    expect(await maybeScheduleChatbotReply(t.db, kit.redis, kit.scheduler, conv.id)).toBe(true);

    kit.llm.impl = async () => llmReply(['Dạ em chào anh, anh cần em hỗ trợ gì thêm không ạ?']);
    const before = kit.llm.calls.length;
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'done', decision: 'reply' });
    expect(kit.llm.calls).toHaveLength(before + 1);
    expect(lastContextText(before)).toContain(handoffContinueTurnNote());
    expect(allPromptText(before)).toContain(
      '[Hệ thống] Hội thoại đã được chuyển cho nhân viên (lý do: Lý do khác).',
    );
    // systemInstruction theo cấu hình bot (ổn định giữa các lượt) nói bot vẫn trả lời sau khi escalate.
    expect(kit.llm.calls[before]!.systemInstruction).toContain('hội thoại KHÔNG dừng');
    expect(kit.llm.calls[before]!.systemInstruction).toBe(kit.llm.calls[0]!.systemInstruction);

    const bots = (await messagesOf(conv.id)).filter((m) => m.senderType === 'bot');
    expect(bots.at(-1)!.text).toBe('Dạ em chào anh, anh cần em hỗ trợ gì thêm không ạ?');
    expect(await convRow(conv.id)).toMatchObject({ status: 'pending_human', aiMode: 'auto' });
    expect(await openHandoffs(conv.id)).toHaveLength(1);
    expect(await needsChatbotKick(t.db, conv.id, new Date())).toBe(false); // tin cuối là của bot
  });

  it('escalate yêu cầu MỚI khi đã Cần người ⇒ gửi messages_to_customer + BÁO nhân viên (tin system, tóm tắt, handoff.created, Lark); không handoff/nhắc mới', async () => {
    const { conv } = await escalatedContinueConversation({ handoffMessage: 'Dạ em chuyển nhân viên ạ' });
    const larkBefore = kit.lark.calls.length;
    const remindersBefore = kit.scheduler.reminders.length;
    const handoffEvents = () => kit.publisher.events.filter((e) => e.event === 'handoff.created');
    const eventsBefore = handoffEvents().length;
    await addMessage(t.db, conv, { text: 'Em gửi thêm 2 ảnh công trình B', sentAt: new Date() });
    const SECOND = 'Dạ em đã nhận thêm 2 ảnh công trình B và chuyển cho bộ phận kiểm tra luôn ạ.';
    kit.llm.impl = async () => llmEscalate([SECOND], 'CT B, 2 ảnh');
    const outboundBefore = kit.scheduler.outbound.length;

    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'done', decision: 'escalate' });
    const msgs = await messagesOf(conv.id);
    const last = msgs.filter((m) => m.senderType === 'bot').at(-1)!;
    expect(last).toMatchObject({ text: SECOND, aiRunId: out.aiRunId, status: 'queued' });
    expect(kit.scheduler.outbound.slice(outboundBefore).map((o) => o.messageId)).toEqual([last.id]);
    expect(kit.publisher.events.some((e) => e.event === 'message.created')).toBe(true);
    // Không gửi lại handoffMessage mặc định.
    expect(msgs.some((m) => m.text === 'Dạ em chuyển nhân viên ạ')).toBe(false);

    const hs = await handoffsOf(conv.id);
    expect(hs).toHaveLength(1);
    expect(hs[0]!.summary).toBe('CTV gửi 7 ảnh công trình\n+ CT B, 2 ảnh');
    const systems = msgs.filter((m) => m.senderType === 'system');
    expect(systems.map((m) => m.text)).toEqual([
      `${HANDOFF_SYSTEM_PREFIX}Lý do khác`,
      `${HANDOFF_REPEAT_PREFIX}Lý do khác`,
    ]);
    expect(systems[1]!.aiRunId).toBe(out.aiRunId);
    expect(kit.lark.calls).toHaveLength(larkBefore + 1);
    expect(JSON.stringify(kit.lark.calls.at(-1))).toContain('CT B, 2 ảnh');
    expect(handoffEvents()).toHaveLength(eventsBefore + 1);
    expect(handoffEvents().at(-1)!.payload).toMatchObject({
      conversationId: conv.id,
      summary: 'CT B, 2 ảnh',
    });
    expect(kit.scheduler.reminders).toHaveLength(remindersBefore);
    expect(await convRow(conv.id)).toMatchObject({ status: 'pending_human', aiMode: 'auto' });

    // Gọi trực tiếp: kết quả created false, có tin xếp hàng, bot vẫn tiếp tục, đã báo nhân viên.
    const direct = await escalateConversation(t.db, kit.deps, conv.id, {
      reasonCode: 'other',
      summary: 'x',
      createdBy: 'ai',
      messages: ['Dạ vâng ạ'],
    });
    expect(direct).toMatchObject({
      created: false,
      botMessagesQueued: 1,
      botContinues: true,
      staffNotified: true,
    });
    // Không có messages (độ tự tin thấp / lỗi lặp lại) ⇒ không gửi gì cho khách, nhưng vẫn báo nhân viên.
    const silent = await escalateConversation(t.db, kit.deps, conv.id, {
      reasonCode: 'low_confidence',
      summary: 'y',
      createdBy: 'ai',
    });
    expect(silent).toMatchObject({ created: false, botMessagesQueued: 0, staffNotified: true });
    expect(await handoffsOf(conv.id)).toHaveLength(1);
  });

  it(`báo thêm CÙNG lý do trong ${HANDOFF_REPEAT_NOTIFY_THROTTLE_MIN} phút ⇒ không báo nhân viên lại (chống spam Lark); lý do khác vẫn báo`, async () => {
    const { conv } = await escalatedContinueConversation();
    const systems = async () =>
      (await messagesOf(conv.id)).filter((m) => m.senderType === 'system').map((m) => m.text);
    const handoffEvents = () => kit.publisher.events.filter((e) => e.event === 'handoff.created').length;
    const unsure = () =>
      escalateConversation(t.db, kit.deps, conv.id, {
        reasonCode: 'low_confidence',
        summary: 'AI không chắc câu trả lời',
        createdBy: 'ai',
      });

    const larkBefore = kit.lark.calls.length;
    const eventsBefore = handoffEvents();
    expect(await unsure()).toMatchObject({ created: false, staffNotified: true });
    expect(kit.lark.calls).toHaveLength(larkBefore + 1);
    expect(handoffEvents()).toBe(eventsBefore + 1);
    const afterFirst = await systems();
    expect(afterFirst.at(-1)).toBe(`${HANDOFF_REPEAT_PREFIX}AI không chắc câu trả lời`);

    // Lặp lại ngay (AI lỗi / không chắc nhiều lượt liền) ⇒ im lặng với nhân viên.
    for (let i = 0; i < 3; i++) {
      expect(await unsure()).toMatchObject({ created: false, botMessagesQueued: 0, staffNotified: true });
    }
    expect(kit.lark.calls).toHaveLength(larkBefore + 1);
    expect(handoffEvents()).toBe(eventsBefore + 1);
    expect(await systems()).toEqual(afterFirst);

    // Lý do khác ⇒ vẫn báo.
    await escalateConversation(t.db, kit.deps, conv.id, {
      reasonCode: 'complaint',
      summary: 'Khách phàn nàn',
      createdBy: 'ai',
    });
    expect(kit.lark.calls).toHaveLength(larkBefore + 2);
    expect(handoffEvents()).toBe(eventsBefore + 2);
  });

  it('chống trùng theo aiRunId: gọi escalate hai lần cho cùng lần chạy ⇒ lần hai không gửi lại gì', async () => {
    const { bot, conv } = await escalatedContinueConversation();
    const [run] = await t.db
      .insert(aiRuns)
      .values({ conversationId: conv.id, chatbotId: bot.id, model: 'm', decision: 'escalate' })
      .returning();
    const input = {
      reasonCode: 'other' as const,
      summary: 'CT D',
      createdBy: 'ai' as const,
      aiRunId: run!.id,
      messages: ['Dạ em đã nhận ảnh CT D ạ'],
    };
    const first = await escalateConversation(t.db, kit.deps, conv.id, input);
    expect(first).toMatchObject({ created: false, botMessagesQueued: 1, staffNotified: true });
    const larkBefore = kit.lark.calls.length;
    const second = await escalateConversation(t.db, kit.deps, conv.id, input);
    expect(second).toMatchObject({ created: false, botMessagesQueued: 0, staffNotified: false });
    expect((await messagesOf(conv.id)).filter((m) => m.text === 'Dạ em đã nhận ảnh CT D ạ')).toHaveLength(1);
    expect(kit.lark.calls).toHaveLength(larkBefore);
  });

  it('từ khóa chuyển người khi ĐANG Cần người (bot continue đang trả lời) ⇒ DỪNG bot, gửi handoffMessage, báo nhân viên', async () => {
    const { conv } = await escalatedContinueConversation({
      handoffKeywords: ['gặp nhân viên'],
      handoffMessage: 'Dạ em chuyển anh sang nhân viên ạ',
    });
    const larkBefore = kit.lark.calls.length;
    await addMessage(t.db, conv, { text: 'cho em gặp nhân viên', sentAt: new Date() });
    const before = kit.llm.calls.length;
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'done', decision: 'escalate' });
    expect(kit.llm.calls).toHaveLength(before); // pre-filter, không gọi LLM
    expect(await convRow(conv.id)).toMatchObject({ status: 'pending_human', aiMode: 'off' });
    expect(await openHandoffs(conv.id)).toHaveLength(1);
    const msgs = await messagesOf(conv.id);
    expect(msgs.filter((m) => m.senderType === 'bot').at(-1)!.text).toBe('Dạ em chuyển anh sang nhân viên ạ');
    expect(msgs.filter((m) => m.senderType === 'system').at(-1)!.text).toBe(
      `${HANDOFF_SYSTEM_PREFIX}Khách muốn gặp nhân viên${HANDOFF_BOT_STOPPED_SUFFIX}`,
    );
    expect(kit.lark.calls).toHaveLength(larkBefore + 1);
    const updated = kit.publisher.events.filter((e) => e.event === 'conversation.updated');
    expect(updated.at(-1)!.payload).toMatchObject({ conversation: { id: conv.id, aiMode: 'off' } });

    // Bot im từ đây (như chế độ 'stop').
    await addMessage(t.db, conv, { text: 'hello', sentAt: new Date() });
    expect(await maybeScheduleChatbotReply(t.db, kit.redis, kit.scheduler, conv.id)).toBe(false);
    expect(await needsChatbotKick(t.db, conv.id, new Date())).toBe(false);

    // Bot đã bị dừng trong handoff này ⇒ "trả lại cho AI" coi tin trước đó là nhân viên đã lo (như 'stop').
    await resolveHandoff(t.db, t.agent, conv.id, makeCtx({ now: () => new Date(Date.now() + 5000) }));
    const outAfter = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(outAfter).toMatchObject({ status: 'skipped', reason: 'no_new_messages' });
  });

  it('giới hạn lượt/giờ tính cả escalate lặp lại có gửi tin: quá giới hạn ⇒ không gửi thêm, vẫn báo nhân viên', async () => {
    const { conv } = await escalatedContinueConversation({ maxRepliesPerHour: 2 });
    // Lượt chuyển đầu đã gửi PHOTOS_OK (escalate có tin bot) ⇒ tính 1.
    await addMessage(t.db, conv, { text: 'ảnh CT B', sentAt: new Date() });
    kit.llm.impl = async () => llmEscalate(['Dạ em nhận ảnh CT B ạ'], 'CT B');
    await processAiReplyJob(t.db, kit.deps, conv.id);
    expect((await messagesOf(conv.id)).some((m) => m.text === 'Dạ em nhận ảnh CT B ạ')).toBe(true);
    // Đã 2 lượt gửi trong giờ ⇒ lượt kế bị chặn trước khi gọi LLM.
    await addMessage(t.db, conv, { text: 'ảnh CT C', sentAt: new Date() });
    const before = kit.llm.calls.length;
    const blocked = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(blocked).toMatchObject({ status: 'skipped', reason: 'Đã đạt giới hạn 2 lượt trả lời/giờ' });
    expect(kit.llm.calls).toHaveLength(before);
    // Gọi thẳng (vd. escalate bù) khi đã đạt giới hạn ⇒ không gửi tin, vẫn báo nhân viên.
    const direct = await escalateConversation(t.db, kit.deps, conv.id, {
      reasonCode: 'other',
      summary: 'CT C',
      createdBy: 'ai',
      messages: ['không được gửi'],
    });
    expect(direct).toMatchObject({ created: false, botMessagesQueued: 0, staffNotified: true });
    expect((await messagesOf(conv.id)).some((m) => m.text === 'không được gửi')).toBe(false);
  });

  it('"Đã chuyển tiền" lúc tin khách đang chờ bot trả lời ⇒ bot VẪN trả lời tin đó (không coi là nhân viên đã lo)', async () => {
    const { conv } = await escalatedContinueConversation();
    // Tin khách tạo TRƯỚC lúc bấm (created_at mặc định của Postgres), job chưa chạy.
    await addMessage(t.db, conv, { text: 'hello', sentAt: new Date() });
    await resolveHandoff(t.db, t.agent, conv.id, makeCtx({ now: () => new Date(Date.now() + 5000) }));
    expect(await needsChatbotKick(t.db, conv.id, new Date())).toBe(true);
    kit.llm.impl = async () => llmReply(['Dạ em chào anh']);
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'done', decision: 'reply' });
    expect((await messagesOf(conv.id)).filter((m) => m.senderType === 'bot').at(-1)!.text).toBe(
      'Dạ em chào anh',
    );
  });

  it('"Đã chuyển tiền" trong lúc đang gọi LLM ⇒ lượt KHÔNG bị hủy, tin trả lời vẫn gửi', async () => {
    const { conv } = await escalatedContinueConversation();
    await addMessage(t.db, conv, { text: 'hello', sentAt: new Date() });
    kit.llm.impl = async () => {
      await resolveHandoff(t.db, t.agent, conv.id, makeCtx({ now: () => new Date(Date.now() + 5000) }));
      return llmReply(['Dạ em chào anh']);
    };
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'done', decision: 'reply' });
    expect(await convRow(conv.id)).toMatchObject({ status: 'open', aiMode: 'auto' });
  });

  it('bot \'stop\': "trả lại cho AI" vẫn coi tin khách trước đó là nhân viên đã lo (không đổi)', async () => {
    const bot = await createBot();
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'Em gửi ảnh', sentAt: new Date(Date.now() - 2000) });
    kit.llm.impl = async () => llmEscalate([PHOTOS_OK]);
    await processAiReplyJob(t.db, kit.deps, conv.id);
    await addMessage(t.db, conv, { text: 'hello', sentAt: new Date() });
    await resolveHandoff(t.db, t.agent, conv.id, makeCtx({ now: () => new Date(Date.now() + 5000) }));
    expect(await processAiReplyJob(t.db, kit.deps, conv.id)).toMatchObject({
      status: 'skipped',
      reason: 'no_new_messages',
    });
  });

  it('handoff mở: bot nói "em đã chuyển thông tin cho bộ phận kiểm tra" ⇒ reply (không gọi lại); hứa "nhân viên sẽ gọi lại" vẫn bị chặn', async () => {
    const { conv } = await escalatedContinueConversation();
    await addMessage(t.db, conv, { text: 'ảnh em duyệt chưa', sentAt: new Date() });
    kit.llm.impl = async () =>
      llmReply(['Dạ em đã chuyển thông tin cho bộ phận kiểm tra rồi ạ, anh chờ giúp em nhé.']);
    const before = kit.llm.calls.length;
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'done', decision: 'reply' });
    expect(kit.llm.calls).toHaveLength(before + 1);

    await addMessage(t.db, conv, { text: 'bao giờ có kết quả', sentAt: new Date() });
    kit.llm.impl = async () => llmReply(['Dạ nhân viên sẽ gọi lại cho anh lúc 3 giờ chiều ạ.']);
    const before2 = kit.llm.calls.length;
    const out2 = await processAiReplyJob(t.db, kit.deps, conv.id);
    // Gọi lại một lần; vẫn hứa ⇒ đổi thành escalate (handoff đã mở ⇒ chỉ gửi tin, không tạo handoff mới).
    expect(kit.llm.calls).toHaveLength(before2 + 2);
    expect(out2).toMatchObject({ status: 'done', decision: 'escalate' });
    expect(await handoffsOf(conv.id)).toHaveLength(1);
    expect(await convRow(conv.id)).toMatchObject({ status: 'pending_human', aiMode: 'auto' });
  });

  it('độ tự tin thấp / LLM lỗi cũng là AI tự chuyển ⇒ giữ ai_mode auto', async () => {
    const lowBot = await createBot({ aiHandoffMode: 'continue' });
    const low = await botConversation(lowBot);
    await addMessage(t.db, low, { text: 'giá bao nhiêu', sentAt: new Date() });
    kit.llm.impl = async () => llmReply(['Chắc 5 triệu'], 0.2);
    expect(await processAiReplyJob(t.db, kit.deps, low.id)).toMatchObject({ decision: 'escalate' });
    expect(await convRow(low.id)).toMatchObject({
      status: 'pending_human',
      aiMode: 'auto',
      handoffReason: 'low_confidence',
    });

    const errConv = await botConversation(lowBot);
    await addMessage(t.db, errConv, { text: 'alo', sentAt: new Date() });
    kit.llm.impl = async () => {
      throw new Error('hỏng');
    };
    expect(await processAiReplyJob(t.db, kit.deps, errConv.id)).toMatchObject({ decision: 'error' });
    expect(await convRow(errConv.id)).toMatchObject({ status: 'pending_human', aiMode: 'auto' });
  });

  it('từ khóa chuyển người vẫn DỪNG bot (kể cả bot continue); chuyển tay của nhân viên cũng dừng', async () => {
    const bot = await createBot({ aiHandoffMode: 'continue', handoffKeywords: ['gặp nhân viên'] });
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'cho em gặp nhân viên', sentAt: new Date() });
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'done', decision: 'escalate' });
    expect(kit.llm.calls).toHaveLength(0);
    expect(await convRow(conv.id)).toMatchObject({ status: 'pending_human', aiMode: 'off' });
    await addMessage(t.db, conv, { text: 'hello', sentAt: new Date() });
    expect(await maybeScheduleChatbotReply(t.db, kit.redis, kit.scheduler, conv.id)).toBe(false);
    expect(await needsChatbotKick(t.db, conv.id, new Date())).toBe(false);

    const manual = await botConversation(bot);
    await addMessage(t.db, manual, { text: 'alo', sentAt: new Date() });
    const res = await escalateConversation(t.db, kit.deps, manual.id, {
      reasonCode: 'human_request',
      summary: 'Nhân viên tự chuyển',
      createdBy: 'user',
      createdByUserId: t.agent.id,
    });
    expect(res).toMatchObject({ created: true, botContinues: false });
    expect(await convRow(manual.id)).toMatchObject({ status: 'pending_human', aiMode: 'off' });

    // Escalate truyền matchedKeyword (đường escalate bù của lượt từ khóa) ⇒ dừng bot.
    const kw = await botConversation(bot);
    const kwRes = await escalateConversation(t.db, kit.deps, kw.id, {
      reasonCode: 'human_request',
      summary: 'từ khóa',
      createdBy: 'ai',
      matchedKeyword: 'gặp nhân viên',
    });
    expect(kwRes.botContinues).toBe(false);
    expect(await convRow(kw.id)).toMatchObject({ aiMode: 'off' });
  });

  it("admin đổi bot sang 'stop' khi hội thoại đang Cần người (ai_mode auto) ⇒ bot bị chặn lại, tin coi như đã xử lý", async () => {
    const { bot, conv } = await escalatedContinueConversation();
    await t.db.update(chatbots).set({ aiHandoffMode: 'stop' }).where(eq(chatbots.id, bot.id));
    const msgId = await addMessage(t.db, conv, { text: 'hello', sentAt: new Date() });
    expect(await needsChatbotKick(t.db, conv.id, new Date())).toBe(false);
    const before = kit.llm.calls.length;
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'skipped', reason: 'Hội thoại đang chờ người thật xử lý' });
    expect(kit.llm.calls).toHaveLength(before);
    const runs = await runsOf(conv.id);
    expect(runs.at(-1)!.triggerMessageIds).toEqual([msgId]);
    const summary = await getConversationSummary(t.db, conv.id, ctx);
    expect(summary.chatbot).toEqual({ id: bot.id, name: bot.name });
  });

  it("đổi sang 'stop' trong lúc gọi LLM ⇒ lượt bị hủy dưới khóa (chống đua)", async () => {
    const { bot, conv } = await escalatedContinueConversation();
    await addMessage(t.db, conv, { text: 'hello', sentAt: new Date() });
    kit.llm.impl = async () => {
      await t.db.update(chatbots).set({ aiHandoffMode: 'stop' }).where(eq(chatbots.id, bot.id));
      return llmReply(['Dạ em chào anh']);
    };
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'cancelled' });
    expect((await messagesOf(conv.id)).filter((m) => m.senderType === 'bot')).toHaveLength(1);
  });

  it('Nghiệm thu (ack) chỉ nhận xử lý — bot vẫn trả lời; Đã chuyển tiền (resolve) ⇒ open, handoff đóng, bot vẫn bật', async () => {
    const { conv } = await escalatedContinueConversation();
    const acked = await ackHandoff(t.db, t.agent, conv.id, ctx);
    expect(acked.ackedHandoffId).not.toBeNull();
    expect(acked.conversation).toMatchObject({ status: 'pending_human', aiMode: 'auto' });

    await addMessage(t.db, conv, { text: 'hello', sentAt: new Date() });
    kit.llm.impl = async () => llmReply(['Dạ em chào anh']);
    expect(await processAiReplyJob(t.db, kit.deps, conv.id)).toMatchObject({ decision: 'reply' });

    const resolved = await resolveHandoff(t.db, t.agent, conv.id, ctx);
    expect(resolved.resolvedHandoffIds).toHaveLength(1);
    expect(resolved.conversation).toMatchObject({ status: 'open', aiMode: 'auto', handoff: null });
    expect(await openHandoffs(conv.id)).toHaveLength(0);

    // Sau khi đóng: lượt mới không còn ghi chú "đã chuyển cho nhân viên".
    // created_at đặt rõ (đồng hồ container Postgres có thể lệch so với resolved_at lấy từ đồng hồ máy chạy test).
    await addMessage(t.db, conv, {
      text: 'cảm ơn em',
      sentAt: new Date(Date.now() + 1000),
      createdAt: new Date(Date.now() + 1000),
    });
    kit.llm.impl = async () => llmReply(['Dạ không có gì ạ']);
    const before = kit.llm.calls.length;
    expect(await processAiReplyJob(t.db, kit.deps, conv.id)).toMatchObject({ decision: 'reply' });
    expect(lastContextText(before)).not.toContain(handoffContinueTurnNote());
  });

  it('escalate bù: lượt escalate lặp lại khi Cần người mất tin gửi khách ⇒ job sau gửi bù đúng một lần', async () => {
    const { bot, conv } = await escalatedContinueConversation();
    const trigger = await addMessage(t.db, conv, {
      text: 'ảnh công trình C',
      sentAt: new Date(Date.now() - 1000),
    });
    const LOST = 'Dạ em đã nhận ảnh công trình C ạ.';
    const [run] = await t.db
      .insert(aiRuns)
      .values({
        conversationId: conv.id,
        chatbotId: bot.id,
        triggerMessageIds: [trigger],
        model: 'gemini-test',
        decision: 'escalate',
        toolCalls: [
          {
            name: 'escalate',
            args: { reason_code: 'other', summary_for_agent: 'CT C', messages_to_customer: [LOST] },
          },
        ],
        reasoningSummary: 'CT C',
      })
      .returning();
    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'skipped' }); // không còn tin mới
    const lost = (await messagesOf(conv.id)).filter((m) => m.text === LOST);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.aiRunId).toBe(run!.id);
    expect(await handoffsOf(conv.id)).toHaveLength(1);
    await processAiReplyJob(t.db, kit.deps, conv.id);
    expect((await messagesOf(conv.id)).filter((m) => m.text === LOST)).toHaveLength(1);
  });
});

describe("aiHandoffMode 'stop' (mặc định) — không đổi", () => {
  it('escalate ⇒ ai_mode off, bot im khi khách nhắn tiếp; read model không có aiHandoffContinues', async () => {
    const bot = await createBot();
    expect(bot.aiHandoffMode).toBe('stop');
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'Em gửi ảnh', sentAt: new Date(Date.now() - 2000) });
    kit.llm.impl = async () => llmEscalate([PHOTOS_OK]);
    await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(await convRow(conv.id)).toMatchObject({ status: 'pending_human', aiMode: 'off' });
    expect((await getConversationSummary(t.db, conv.id, ctx)).chatbot).toEqual({
      id: bot.id,
      name: bot.name,
    });

    await addMessage(t.db, conv, { text: 'hello', sentAt: new Date() });
    expect(await maybeScheduleChatbotReply(t.db, kit.redis, kit.scheduler, conv.id)).toBe(false);
    expect(await needsChatbotKick(t.db, conv.id, new Date())).toBe(false);
    const dup = await escalateConversation(t.db, kit.deps, conv.id, {
      reasonCode: 'other',
      summary: 'lần hai',
      createdBy: 'ai',
      messages: ['không được gửi'],
    });
    expect(dup).toMatchObject({ created: false, botMessagesQueued: 0, botContinues: false });
    expect((await messagesOf(conv.id)).some((m) => m.text === 'không được gửi')).toBe(false);
  });
});

describe('CRUD aiHandoffMode', () => {
  it("tạo mặc định 'stop'; tạo/sửa 'continue'; audit ghi tên trường", async () => {
    const plain = await createChatbot(t.db, t.admin.id, { name: `CRUD ${Date.now()}` });
    expect(plain.aiHandoffMode).toBe('stop');
    const made = await createChatbot(t.db, t.admin.id, {
      name: `CRUD2 ${Date.now()}`,
      aiHandoffMode: 'continue',
    });
    expect(made.aiHandoffMode).toBe('continue');
    const updated = await updateChatbot(t.db, t.admin.id, plain.id, { aiHandoffMode: 'continue' });
    expect(updated.aiHandoffMode).toBe('continue');
    expect((await getChatbot(t.db, plain.id)).aiHandoffMode).toBe('continue');
    const back = await updateChatbot(t.db, t.admin.id, plain.id, { aiHandoffMode: 'stop' });
    expect(back.aiHandoffMode).toBe('stop');
  });
});
