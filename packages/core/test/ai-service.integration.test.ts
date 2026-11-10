// Test tích hợp CRUD chatbot, thao tác chatbot/handoff trên hội thoại, read model, các điểm tích hợp
// (pipeline gắn bot mặc định + hook + pause khi echo Business Suite, sendAgentMessage pause, kênh).
import {
  aiRuns,
  auditLogs,
  channelAccounts,
  chatbots,
  conversations,
  handoffs,
  messages,
  type ChannelAccount,
} from '@dezon/db';
import type { NormalizedInboundMessage } from '@dezon/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toChatbotConfig } from '../src/ai/config';
import { ChatbotNameConflictError } from '../src/ai/errors';
import {
  ackHandoff,
  createChatbot,
  deleteChatbot,
  getChatbot,
  listAiRuns,
  listChatbots,
  resolveHandoff,
  resumeConversationAi,
  setConversationChatbot,
  updateChatbot,
} from '../src/ai/service';
import { updateChannel } from '../src/channels/service';
import { sendAgentMessage } from '../src/inbox/commands';
import { InboxForbiddenError, InboxNotFoundError, InboxValidationError } from '../src/inbox/errors';
import { getMessageDto, listConversations } from '../src/inbox/queries';
import { processInboundMessage } from '../src/pipeline/inbound';
import type { CustomerMessageStoredEvent, PipelineDeps } from '../src/pipeline/types';
import { createRecordingPublisher, fakeCipher, silentLogger } from './helpers/ai-fakes';
import { createMemoryStorage } from './helpers/memory-storage';
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
const ctx = makeCtx();
const MIN = 60_000;

beforeAll(async () => {
  t = await startTestDb();
  channel = await createChannel(t.db);
});

afterAll(async () => {
  await t?.stop();
});

describe('CRUD chatbot', () => {
  it('tạo, đọc, sửa, trùng tên, danh sách theo quyền, xóa', async () => {
    const bot = await createChatbot(t.db, t.admin.id, {
      name: '  Bot Bán Hàng ',
      handoffKeywords: [' Gặp NV ', 'gap nv', 'khiếu nại'],
      handoffMessage: '   ',
      examples: [{ customer: 'Giá?', reply: 'Dạ inbox ạ' }],
    });
    expect(bot).toMatchObject({
      name: 'Bot Bán Hàng',
      handoffKeywords: ['Gặp NV', 'khiếu nại'],
      handoffMessage: null,
      isActive: true,
      temperature: expect.closeTo(0.4, 5),
      replyDelaySec: 10,
      maxWaitSec: 45,
      maxRepliesPerHour: 20,
      escalateWhenUnsure: true,
      conversationCount: 0,
    });
    await expect(createChatbot(t.db, t.admin.id, { name: 'Bot Bán Hàng' })).rejects.toBeInstanceOf(
      ChatbotNameConflictError,
    );

    const off = await createChatbot(t.db, t.admin.id, {
      name: 'Bot Tắt',
      isActive: false,
      escalateWhenUnsure: false,
    });
    expect(off.escalateWhenUnsure).toBe(false);
    await expect(updateChatbot(t.db, t.admin.id, off.id, { name: 'Bot Bán Hàng' })).rejects.toBeInstanceOf(
      ChatbotNameConflictError,
    );
    const updated = await updateChatbot(t.db, t.admin.id, off.id, {
      knowledge: 'Sofa da Ý',
      temperature: 0.2,
    });
    expect(updated).toMatchObject({ name: 'Bot Tắt', knowledge: 'Sofa da Ý', escalateWhenUnsure: false });
    expect(
      (await updateChatbot(t.db, t.admin.id, off.id, { escalateWhenUnsure: true })).escalateWhenUnsure,
    ).toBe(true);
    expect((await getChatbot(t.db, off.id)).escalateWhenUnsure).toBe(true);
    await expect(updateChatbot(t.db, t.admin.id, crypto.randomUUID(), { name: 'x' })).rejects.toBeInstanceOf(
      InboxNotFoundError,
    );
    await expect(getChatbot(t.db, crypto.randomUUID())).rejects.toBeInstanceOf(InboxNotFoundError);

    await createConversation(t.db, { channel, chatbotId: bot.id, aiMode: 'auto' });
    const adminList = await listChatbots(t.db, t.admin);
    expect(adminList.map((b) => b.name)).toEqual(expect.arrayContaining(['Bot Bán Hàng', 'Bot Tắt']));
    expect(adminList.find((b) => b.id === bot.id)?.conversationCount).toBe(1);
    const agentList = await listChatbots(t.db, t.agent);
    expect(agentList.some((b) => b.id === off.id)).toBe(false);
    expect(agentList.some((b) => b.id === bot.id)).toBe(true);
    expect((await getChatbot(t.db, bot.id)).conversationCount).toBe(1);

    const audits = await t.db.select().from(auditLogs).where(eq(auditLogs.entityId, off.id));
    expect(audits.map((a) => a.action).sort()).toEqual([
      'chatbot.create',
      'chatbot.update',
      'chatbot.update',
    ]);
  });

  it('responseSpeed: mặc định fast, tạo/sửa/đọc lại; toChatbotConfig lấy từ dòng, draft ghi đè', async () => {
    const plain = await createChatbot(t.db, t.admin.id, { name: 'Bot Tốc Độ Mặc Định' });
    expect(plain.responseSpeed).toBe('fast');
    const bot = await createChatbot(t.db, t.admin.id, { name: 'Bot Tốc Độ', responseSpeed: 'thorough' });
    expect(bot.responseSpeed).toBe('thorough');
    expect((await updateChatbot(t.db, t.admin.id, bot.id, { responseSpeed: 'balanced' })).responseSpeed).toBe(
      'balanced',
    );
    // Sửa trường khác không đổi tốc độ.
    expect((await updateChatbot(t.db, t.admin.id, bot.id, { knowledge: 'x' })).responseSpeed).toBe(
      'balanced',
    );
    expect((await getChatbot(t.db, bot.id)).responseSpeed).toBe('balanced');

    const [row] = await t.db.select().from(chatbots).where(eq(chatbots.id, bot.id));
    expect(toChatbotConfig(row!).responseSpeed).toBe('balanced');
    expect(toChatbotConfig(row!, { responseSpeed: 'fast' }).responseSpeed).toBe('fast');
  });

  it('xóa bot gỡ khỏi hội thoại (ai_mode off) và kênh', async () => {
    const bot = await createChatbot(t.db, t.admin.id, { name: 'Bot Sẽ Xóa' });
    const ch = await createChannel(t.db, { defaultChatbotId: bot.id });
    const conv = await createConversation(t.db, { channel: ch, chatbotId: bot.id, aiMode: 'auto' });
    const res = await deleteChatbot(t.db, t.admin.id, bot.id);
    expect(res.detachedConversationIds).toEqual([conv.id]);
    const [c] = await t.db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(c).toMatchObject({ chatbotId: null, aiMode: 'off' });
    const [a] = await t.db.select().from(channelAccounts).where(eq(channelAccounts.id, ch.id));
    expect(a!.defaultChatbotId).toBeNull();
    await expect(deleteChatbot(t.db, t.admin.id, bot.id)).rejects.toBeInstanceOf(InboxNotFoundError);
  });
});

describe('chatbot trên hội thoại', () => {
  it('bật/tắt bot theo quyền xem, bot tắt bị từ chối, audit', async () => {
    const bot = await createChatbot(t.db, t.admin.id, { name: 'Bot Hội Thoại' });
    const off = await createChatbot(t.db, t.admin.id, { name: 'Bot Hội Thoại Tắt', isActive: false });
    const conv = await createConversation(t.db, {
      channel,
      assignedUserId: t.agent.id,
      aiPausedUntil: new Date(Date.now() + 10 * MIN),
    });

    await expect(setConversationChatbot(t.db, t.agent2, conv.id, bot.id, ctx)).rejects.toBeInstanceOf(
      InboxForbiddenError,
    );
    await expect(setConversationChatbot(t.db, t.agent, conv.id, off.id, ctx)).rejects.toBeInstanceOf(
      InboxValidationError,
    );
    await expect(
      setConversationChatbot(t.db, t.agent, conv.id, crypto.randomUUID(), ctx),
    ).rejects.toBeInstanceOf(InboxValidationError);

    const on = await setConversationChatbot(t.db, t.agent, conv.id, bot.id, ctx);
    expect(on.conversation).toMatchObject({
      aiMode: 'auto',
      chatbot: { id: bot.id, name: 'Bot Hội Thoại' },
      aiPausedUntil: null,
    });
    expect(on.previousAssigneeId).toBe(t.agent.id);

    // Lọc "AI đang lo".
    const handled = await listConversations(t.db, t.admin, { aiState: 'handled', limit: 100 }, ctx);
    expect(handled.items.some((c) => c.id === conv.id)).toBe(true);
    expect(handled.items.every((c) => c.aiMode === 'auto' && c.chatbot)).toBe(true);

    const offRes = await setConversationChatbot(t.db, t.agent, conv.id, null, ctx);
    expect(offRes.conversation).toMatchObject({ aiMode: 'off', chatbot: null });
    const handled2 = await listConversations(t.db, t.admin, { aiState: 'handled', limit: 100 }, ctx);
    expect(handled2.items.some((c) => c.id === conv.id)).toBe(false);

    const logs = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, conv.id), eq(auditLogs.action, 'conversation.chatbot')));
    expect(logs.map((l) => l.data)).toEqual(
      expect.arrayContaining([
        { from: null, to: bot.id },
        { from: bot.id, to: null },
      ]),
    );
  });

  it('tiếp tục AI xóa pause; ack khi không có handoff ⇒ lỗi; resolve không có gì ⇒ không đổi', async () => {
    const bot = await createChatbot(t.db, t.admin.id, { name: 'Bot Pause' });
    const conv = await createConversation(t.db, {
      channel,
      chatbotId: bot.id,
      aiMode: 'auto',
      aiPausedUntil: new Date(Date.now() + 10 * MIN),
    });
    await expect(ackHandoff(t.db, t.agent, conv.id, ctx)).rejects.toBeInstanceOf(InboxValidationError);
    const res = await resumeConversationAi(t.db, t.agent, conv.id, ctx);
    expect(res.conversation.aiPausedUntil).toBeNull();
    const [c] = await t.db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(c!.aiPausedUntil).toBeNull();
    const r = await resolveHandoff(t.db, t.agent, conv.id, ctx);
    expect(r.conversation.status).toBe('open');
  });

  it('resolve: hội thoại không còn bot ⇒ ai_mode off; ack không ghi đè người đã nhận', async () => {
    const conv = await createConversation(t.db, {
      channel,
      status: 'pending_human',
      handoffReason: 'complaint',
      handoffAt: new Date(),
    });
    await t.db.insert(handoffs).values({
      conversationId: conv.id,
      reasonCode: 'complaint',
      summary: 'Khách phàn nàn giao chậm',
      createdBy: 'ai',
      acknowledgedBy: t.agent2.id,
      acknowledgedAt: new Date(),
    });
    const acked = await ackHandoff(t.db, t.agent, conv.id, ctx);
    expect(acked.conversation.handoff).toMatchObject({
      reasonCode: 'complaint',
      summary: 'Khách phàn nàn giao chậm',
      acknowledgedBy: { id: t.agent2.id, name: 'Lan' },
    });
    expect(acked.conversation.assignedUser?.id).toBe(t.agent.id);
    const resolved = await resolveHandoff(t.db, t.agent, conv.id, ctx);
    expect(resolved.conversation).toMatchObject({ status: 'open', aiMode: 'off', handoff: null });
  });

  it('listAiRuns trả tên bot, mới nhất trước', async () => {
    const bot = await createChatbot(t.db, t.admin.id, { name: 'Bot Nhật Ký' });
    const conv = await createConversation(t.db, { channel, chatbotId: bot.id, aiMode: 'auto' });
    await t.db.insert(aiRuns).values([
      {
        conversationId: conv.id,
        chatbotId: bot.id,
        model: 'm',
        decision: 'reply',
        createdAt: new Date(Date.now() - MIN),
      },
      {
        conversationId: conv.id,
        chatbotId: bot.id,
        model: 'm',
        decision: 'no_reply',
        error: 'Đang tạm dừng',
      },
    ]);
    const runs = await listAiRuns(t.db, conv.id);
    expect(runs.map((r) => r.decision)).toEqual(['no_reply', 'reply']);
    expect(runs[0]).toMatchObject({ chatbotName: 'Bot Nhật Ký', error: 'Đang tạm dừng' });
    expect(await listAiRuns(t.db, conv.id, 1)).toHaveLength(1);
  });
});

describe('read model', () => {
  it('senderLabel tin bot = tên bot, thiếu lần chạy ⇒ "AI"; aiPausedUntil đã qua ⇒ null', async () => {
    const bot = await createChatbot(t.db, t.admin.id, { name: 'Bot Nhãn' });
    const conv = await createConversation(t.db, {
      channel,
      chatbotId: bot.id,
      aiMode: 'auto',
      aiPausedUntil: new Date(Date.now() - MIN),
    });
    const [run] = await t.db
      .insert(aiRuns)
      .values({ conversationId: conv.id, chatbotId: bot.id, model: 'm', decision: 'reply' })
      .returning();
    const withRun = await addMessage(t.db, conv, {
      senderType: 'bot',
      text: 'Dạ',
      aiRunId: run!.id,
      sentAt: new Date(),
    });
    const without = await addMessage(t.db, conv, { senderType: 'bot', text: 'Dạ', sentAt: new Date() });
    expect((await getMessageDto(t.db, withRun, ctx)).senderLabel).toBe('Bot Nhãn');
    expect((await getMessageDto(t.db, without, ctx)).senderLabel).toBe('AI');
    const list = await listConversations(t.db, t.admin, { limit: 100 }, ctx);
    const s = list.items.find((c) => c.id === conv.id)!;
    expect(s).toMatchObject({
      chatbot: { id: bot.id, name: 'Bot Nhãn' },
      aiPausedUntil: null,
      handoff: null,
    });
  });
});

describe('nhân viên nhắn ⇒ tạm dừng AI', () => {
  it('sendAgentMessage đặt ai_paused_until = now + 30 phút khi có bot', async () => {
    const bot = await createChatbot(t.db, t.admin.id, { name: 'Bot Agent Pause' });
    const conv = await createConversation(t.db, {
      channel,
      chatbotId: bot.id,
      aiMode: 'auto',
      lastCustomerMessageAt: new Date(),
    });
    const plain = await createConversation(t.db, { channel, lastCustomerMessageAt: new Date() });
    const before = Date.now();
    const res = await sendAgentMessage(
      t.db,
      t.admin,
      conv.id,
      { text: 'Dạ em chào chị', attachments: [] },
      ctx,
    );
    const paused = Date.parse(res.conversation.aiPausedUntil!);
    expect(paused).toBeGreaterThanOrEqual(before + 30 * MIN - 1000);
    expect(paused).toBeLessThanOrEqual(Date.now() + 30 * MIN + 1000);

    const custom = await sendAgentMessage(
      t.db,
      t.admin,
      conv.id,
      { text: 'Thêm', attachments: [] },
      makeCtx({ aiPauseAfterAgentMin: 60 }),
    );
    expect(Date.parse(custom.conversation.aiPausedUntil!)).toBeGreaterThan(paused + 25 * MIN);

    const r2 = await sendAgentMessage(t.db, t.admin, plain.id, { text: 'Dạ', attachments: [] }, ctx);
    expect(r2.conversation.aiPausedUntil).toBeNull();
  });
});

describe('pipeline', () => {
  function pipelineDeps(hookEvents: CustomerMessageStoredEvent[]): PipelineDeps {
    return {
      connectors: {},
      storage: createMemoryStorage(),
      cipher: fakeCipher,
      publisher: createRecordingPublisher(),
      ctx,
      logger: silentLogger,
      maxMediaBytes: 1_000_000,
      ownAppIds: { messenger: '999' },
      onCustomerMessageStored: async (e) => {
        hookEvents.push(e);
      },
    };
  }

  const inbound = (
    ch: ChannelAccount,
    psid: string,
    mid: string,
    extra: Partial<NormalizedInboundMessage> = {},
  ) =>
    ({
      channelAccountId: ch.id,
      channelType: 'messenger',
      externalUserId: psid,
      externalMessageId: mid,
      direction: 'in',
      senderType: 'customer',
      text: 'Shop ơi',
      attachments: [],
      sentAt: new Date(),
      raw: { mid },
      ...extra,
    }) satisfies NormalizedInboundMessage;

  it('hội thoại mới tự gắn bot mặc định của kênh (trừ đồng bộ lịch sử) và gọi hook', async () => {
    const bot = await createChatbot(t.db, t.admin.id, { name: 'Bot Mặc Định' });
    const ch = await createChannel(t.db);
    await expect(
      updateChannel(t.db, { actorUserId: t.admin.id }, ch.id, { defaultChatbotId: crypto.randomUUID() }),
    ).rejects.toBeInstanceOf(InboxValidationError);
    const dto = await updateChannel(t.db, { actorUserId: t.admin.id }, ch.id, { defaultChatbotId: bot.id });
    expect(dto.defaultChatbotId).toBe(bot.id);

    const events: CustomerMessageStoredEvent[] = [];
    const deps = pipelineDeps(events);
    const r = await processInboundMessage(t.db, deps, inbound(ch, 'psid-new', 'mid-1'));
    const [conv] = await t.db.select().from(conversations).where(eq(conversations.id, r.conversation!.id));
    expect(conv).toMatchObject({ chatbotId: bot.id, aiMode: 'auto' });
    expect(events).toEqual([{ conversationId: conv!.id, messageId: expect.any(String), source: 'webhook' }]);

    await processInboundMessage(t.db, deps, inbound(ch, 'psid-new', 'mid-2'), { source: 'sync-incremental' });
    expect(events.at(-1)?.source).toBe('sync-incremental');

    const old = await processInboundMessage(t.db, deps, inbound(ch, 'psid-old', 'mid-3'), {
      source: 'sync-backfill',
    });
    const [oldConv] = await t.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, old.conversation!.id));
    expect(oldConv).toMatchObject({ chatbotId: null, aiMode: 'off' });
    expect(events).toHaveLength(2);

    // Lỗi hook không làm hỏng pipeline.
    deps.onCustomerMessageStored = async () => {
      throw new Error('redis down');
    };
    const ok = await processInboundMessage(t.db, deps, inbound(ch, 'psid-new', 'mid-4'));
    expect(ok.stored).toBe(true);

    // Bot mặc định bị tắt ⇒ không gắn.
    await t.db.update(chatbots).set({ isActive: false }).where(eq(chatbots.id, bot.id));
    const r3 = await processInboundMessage(t.db, deps, inbound(ch, 'psid-x', 'mid-5'));
    const [c3] = await t.db.select().from(conversations).where(eq(conversations.id, r3.conversation!.id));
    expect(c3!.chatbotId).toBeNull();
  });

  it('echo Business Suite (nhân viên trả lời ngoài hệ thống) ⇒ tạm dừng AI', async () => {
    const bot = await createChatbot(t.db, t.admin.id, { name: 'Bot Echo' });
    const ch = await createChannel(t.db, { defaultChatbotId: bot.id });
    const events: CustomerMessageStoredEvent[] = [];
    const deps = pipelineDeps(events);
    // Tin khách 2 phút trước (ngoài cửa sổ echo tự động AUTOMATION_ECHO_WINDOW_SEC = 15 giây).
    const r = await processInboundMessage(
      t.db,
      deps,
      inbound(ch, 'psid-echo', 'mid-e1', { sentAt: new Date(Date.now() - 2 * MIN) }),
    );
    await processInboundMessage(
      t.db,
      deps,
      inbound(ch, 'psid-echo', 'mid-e2', {
        direction: 'out',
        senderType: 'agent',
        text: 'Dạ',
        raw: { message: { mid: 'mid-e2' } },
      }),
    );
    const [conv] = await t.db.select().from(conversations).where(eq(conversations.id, r.conversation!.id));
    expect(conv!.aiPausedUntil!.getTime()).toBeGreaterThan(Date.now() + 29 * MIN);
    expect(events).toHaveLength(1);
    const echo = await t.db.select().from(messages).where(eq(messages.externalMessageId, 'mid-e2'));
    expect(echo[0]!.senderType).toBe('agent');
  });

  it('echo ngay sau tin khách (Trả lời nhanh / Tin vắng mặt của Page) ⇒ KHÔNG tạm dừng AI', async () => {
    const bot = await createChatbot(t.db, t.admin.id, { name: 'Bot Echo Tự Động' });
    const ch = await createChannel(t.db, { defaultChatbotId: bot.id });
    const deps = pipelineDeps([]);
    const at = Date.now() - 10_000;
    const r = await processInboundMessage(
      t.db,
      deps,
      inbound(ch, 'psid-auto', 'mid-a1', { sentAt: new Date(at) }),
    );
    await processInboundMessage(
      t.db,
      deps,
      inbound(ch, 'psid-auto', 'mid-a2', {
        direction: 'out',
        senderType: 'agent',
        text: 'Cảm ơn bạn đã nhắn tin',
        sentAt: new Date(at + 1_000),
        raw: { message: { mid: 'mid-a2', is_echo: true, app_id: 263902037430900 } },
      }),
    );
    const [conv] = await t.db.select().from(conversations).where(eq(conversations.id, r.conversation!.id));
    expect(conv!.aiPausedUntil).toBeNull();
    const [echo] = await t.db.select().from(messages).where(eq(messages.externalMessageId, 'mid-a2'));
    expect(echo!.raw).toMatchObject({ automatedEcho: true });
  });
});
