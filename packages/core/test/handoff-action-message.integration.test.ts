// Tin bot gửi khách khi nhân viên bấm hai nút trên banner "Cần người" (handoff_ack_message /
// handoff_resolve_message). Postgres thật (Testcontainers); scheduler/publisher giả.
import { chatbots, conversations, handoffs, messages, type ChannelAccount, type Chatbot } from '@dezon/db';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fillHandoffActionMessage,
  handoffActionBlockedText,
  sendHandoffActionMessage,
  type HandoffActionMessageDeps,
} from '../src/ai/handoff-action';
import { ackHandoff, needsChatbotKick, resolveHandoff } from '../src/ai/service';
import { createFakeScheduler, createRecordingPublisher, silentLogger } from './helpers/ai-fakes';
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

function makeDeps() {
  const scheduler = createFakeScheduler();
  const publisher = createRecordingPublisher();
  const deps: HandoffActionMessageDeps = { ctx, publisher, logger: silentLogger, scheduler, random: () => 0 };
  return { deps, scheduler, publisher };
}

async function createBot(values: Partial<typeof chatbots.$inferInsert> = {}): Promise<Chatbot> {
  const [bot] = await t.db
    .insert(chatbots)
    .values({ name: `Bot ${Math.random().toString(36).slice(2, 8)}`, ...values })
    .returning();
  return bot!;
}

/** Hội thoại đang chờ người (như sau escalate) với một handoff mở; khách nhắn lúc `customerAt`. */
async function pendingHuman(
  bot: Chatbot | null,
  opts: { contactName?: string; customerAt?: Date; channel?: ChannelAccount } = {},
) {
  const customerAt = opts.customerAt ?? ago(2 * MIN);
  const conv = await createConversation(t.db, {
    channel: opts.channel ?? channel,
    contactName: opts.contactName ?? 'Chị Mai',
    chatbotId: bot?.id ?? null,
    aiMode: 'off',
    status: 'pending_human',
    handoffReason: 'discount',
    handoffAt: ago(MIN),
    lastCustomerMessageAt: customerAt,
    lastMessageAt: customerAt,
  });
  await addMessage(t.db, conv, { sentAt: customerAt, text: 'Cho em gặp nhân viên' });
  await t.db
    .insert(handoffs)
    .values({ conversationId: conv.id, reasonCode: 'discount', summary: 'Khách xin giảm', createdBy: 'ai' });
  return conv;
}

const rows = (conversationId: string) =>
  t.db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.sentAt), asc(messages.id));

const createdEvents = (publisher: ReturnType<typeof createRecordingPublisher>) =>
  publisher.events.filter((e) => e.event === 'message.created');

describe('fillHandoffActionMessage', () => {
  it('thay mọi {ten_khach}; thiếu tên ⇒ "anh/chị"', () => {
    expect(fillHandoffActionMessage('Dạ {ten_khach} ơi, {ten_khach} chờ chút', 'Mai')).toBe(
      'Dạ Mai ơi, Mai chờ chút',
    );
    expect(fillHandoffActionMessage('Chào {ten_khach}', '  ')).toBe('Chào anh/chị');
    expect(fillHandoffActionMessage('Chào {ten_khach}', null)).toBe('Chào anh/chị');
    expect(fillHandoffActionMessage('Không có chỗ thay', 'Mai')).toBe('Không có chỗ thay');
  });
});

describe('nút "nhận" (ack)', () => {
  it('gửi tin bot (sender bot, ai_run_id null, queued) với {ten_khach}; bấm lại không gửi lại', async () => {
    const bot = await createBot({
      handoffAckLabel: 'Nghiệm thu',
      handoffAckMessage: '  Dạ {ten_khach} ơi, bên em đã nhận yêu cầu nghiệm thu ạ  ',
    });
    const conv = await pendingHuman(bot, { contactName: 'Chị Mai' });
    const { deps, scheduler, publisher } = makeDeps();

    const first = await ackHandoff(t.db, t.agent, conv.id, ctx);
    expect(first.ackedHandoffId).toBeTruthy();
    const res = await sendHandoffActionMessage(t.db, deps, {
      conversationId: conv.id,
      action: 'ack',
      handoffIds: [first.ackedHandoffId!],
    });
    expect(res.status).toBe('sent');

    const bots = (await rows(conv.id)).filter((m) => m.senderType === 'bot');
    expect(bots).toHaveLength(1);
    expect(bots[0]).toMatchObject({
      text: 'Dạ Chị Mai ơi, bên em đã nhận yêu cầu nghiệm thu ạ',
      status: 'queued',
      aiRunId: null,
    });
    expect(scheduler.outbound).toEqual([{ messageId: bots[0]!.id, delayMs: 0 }]);
    expect(
      createdEvents(publisher).map((e) => (e.payload as { message: { id: string } }).message.id),
    ).toEqual([bots[0]!.id]);
    // Tin bot không phải tin nhân viên ⇒ không đặt tạm dừng bot.
    const [after] = await t.db.select().from(conversations).where(eq(conversations.id, conv.id));
    expect(after!.aiPausedUntil).toBeNull();
    expect(after!.lastMessageAt!.getTime()).toBeGreaterThanOrEqual(bots[0]!.sentAt.getTime());

    // Bấm lại: core không trả handoff mới ⇒ không gửi trùng.
    const again = await ackHandoff(t.db, t.agent, conv.id, ctx);
    expect(again.ackedHandoffId).toBeNull();
    const res2 = await sendHandoffActionMessage(t.db, deps, {
      conversationId: conv.id,
      action: 'ack',
      handoffIds: again.ackedHandoffId ? [again.ackedHandoffId] : [],
    });
    expect(res2).toEqual({ status: 'skipped' });
    expect((await rows(conv.id)).filter((m) => m.senderType === 'bot')).toHaveLength(1);
    expect(scheduler.outbound).toHaveLength(1);
  });

  it('tin dài > 1999 ký tự ⇒ tách bong bóng, cùng batch, giãn cách', async () => {
    const long = `${'a'.repeat(1500)} ${'b'.repeat(1500)}`;
    const bot = await createBot({ handoffAckMessage: long });
    const conv = await pendingHuman(bot);
    const { deps, scheduler } = makeDeps();
    const res = await sendHandoffActionMessage(t.db, deps, {
      conversationId: conv.id,
      action: 'ack',
      handoffIds: ['x'],
    });
    expect(res.status).toBe('sent');
    const bots = (await rows(conv.id)).filter((m) => m.senderType === 'bot');
    expect(bots.length).toBe(2);
    expect(bots.every((m) => (m.text ?? '').length <= 1999)).toBe(true);
    expect(scheduler.outbound.map((o) => o.messageId)).toEqual(bots.map((m) => m.id));
    expect(scheduler.outbound[1]!.delayMs).toBeGreaterThan(0);
  });

  it('không đặt tin (null / chỉ khoảng trắng) hoặc hội thoại không gắn bot ⇒ không gửi gì', async () => {
    const cases = [
      await pendingHuman(await createBot({ handoffAckMessage: null })),
      await pendingHuman(await createBot({ handoffAckMessage: '   ' })),
      await pendingHuman(null),
    ];
    for (const conv of cases) {
      const { deps, scheduler, publisher } = makeDeps();
      const res = await sendHandoffActionMessage(t.db, deps, {
        conversationId: conv.id,
        action: 'ack',
        handoffIds: ['x'],
      });
      expect(res).toEqual({ status: 'skipped' });
      expect((await rows(conv.id)).filter((m) => m.senderType !== 'customer')).toHaveLength(0);
      expect(scheduler.outbound).toHaveLength(0);
      expect(publisher.events).toHaveLength(0);
    }
  });

  it('chỉ đặt tin cho nút kia ⇒ nút này không gửi', async () => {
    const bot = await createBot({ handoffResolveMessage: 'Đã chuyển tiền cho {ten_khach}' });
    const conv = await pendingHuman(bot);
    const { deps } = makeDeps();
    expect(
      await sendHandoffActionMessage(t.db, deps, {
        conversationId: conv.id,
        action: 'ack',
        handoffIds: ['x'],
      }),
    ).toEqual({ status: 'skipped' });
  });
});

describe('không gửi được (botCanSend chặn)', () => {
  it('ngoài cửa sổ 24 giờ ⇒ không có tin bot, thêm tin system cho nhân viên', async () => {
    const bot = await createBot({
      handoffAckLabel: 'Nghiệm thu',
      handoffAckMessage: 'Dạ {ten_khach} ơi',
    });
    const conv = await pendingHuman(bot, { customerAt: ago(25 * HOUR) });
    const { deps, scheduler, publisher } = makeDeps();
    const res = await sendHandoffActionMessage(t.db, deps, {
      conversationId: conv.id,
      action: 'ack',
      handoffIds: ['x'],
    });
    expect(res.status).toBe('blocked');
    const all = await rows(conv.id);
    expect(all.filter((m) => m.senderType === 'bot')).toHaveLength(0);
    const system = all.filter((m) => m.senderType === 'system');
    expect(system).toHaveLength(1);
    expect(system[0]!.text).toMatch(/^Không gửi được tin «Nghiệm thu» cho khách: .*24 giờ/);
    expect(system[0]!.status).toBe('sent');
    expect(scheduler.outbound).toHaveLength(0);
    expect(createdEvents(publisher)).toHaveLength(1);
  });

  it('kênh mất kết nối ⇒ tin system với nhãn mặc định khi bot không đặt tên nút', async () => {
    const offline = await createChannel(t.db, { status: 'disconnected' });
    const bot = await createBot({ handoffResolveMessage: 'Đã chuyển tiền ạ' });
    const conv = await pendingHuman(bot, { channel: offline });
    const { deps, scheduler } = makeDeps();
    const res = await sendHandoffActionMessage(t.db, deps, {
      conversationId: conv.id,
      action: 'resolve',
      handoffIds: ['x'],
    });
    expect(res).toMatchObject({ status: 'blocked', reason: 'Kênh đang mất kết nối' });
    const system = (await rows(conv.id)).filter((m) => m.senderType === 'system');
    expect(system.map((m) => m.text)).toEqual([
      handoffActionBlockedText('Đã xong, trả lại cho AI', 'Kênh đang mất kết nối'),
    ]);
    expect(scheduler.outbound).toHaveLength(0);
  });
});

describe('nút "xong" (resolve)', () => {
  it('khách đang chờ: kick tính TRƯỚC khi gửi ⇒ vẫn kick; tin của nút xếp hàng trước kick', async () => {
    const bot = await createBot({
      handoffResolveLabel: 'Đã chuyển tiền',
      handoffResolveMessage: 'Dạ {ten_khach}, bên em đã chuyển tiền rồi ạ',
    });
    const conv = await pendingHuman(bot, { contactName: 'Anh Tùng' });
    const { deps, scheduler } = makeDeps();
    // Một nhật ký chung để kiểm thứ tự đẩy job như ConversationAiService.resolveHandoff.
    const order: string[] = [];
    const enqueue = scheduler.enqueueOutbound.bind(scheduler);
    deps.scheduler = {
      enqueueOutbound: async (id, delay) => {
        order.push(`outbound:${id}`);
        await enqueue(id, delay);
      },
    };

    const result = await resolveHandoff(t.db, t.agent, conv.id, ctx);
    expect(result.resolvedHandoffIds).toHaveLength(1);
    const kick = await needsChatbotKick(t.db, conv.id, ctx.now());
    expect(kick).toBe(true);
    const res = await sendHandoffActionMessage(t.db, deps, {
      conversationId: conv.id,
      action: 'resolve',
      handoffIds: result.resolvedHandoffIds,
    });
    if (kick) order.push('kick');

    expect(res.status).toBe('sent');
    const bots = (await rows(conv.id)).filter((m) => m.senderType === 'bot');
    expect(bots.map((m) => m.text)).toEqual(['Dạ Anh Tùng, bên em đã chuyển tiền rồi ạ']);
    expect(order).toEqual([`outbound:${bots[0]!.id}`, 'kick']);
    // Lý do phải tính kick trước: sau khi có tin bot, tin cuối không còn là của khách.
    expect(await needsChatbotKick(t.db, conv.id, ctx.now())).toBe(false);
  });

  it('bấm "xong" lần nữa (không còn handoff mở) ⇒ không gửi lại', async () => {
    const bot = await createBot({ handoffResolveMessage: 'Đã chuyển tiền ạ' });
    const conv = await pendingHuman(bot);
    const { deps, scheduler } = makeDeps();
    const r1 = await resolveHandoff(t.db, t.agent, conv.id, ctx);
    await sendHandoffActionMessage(t.db, deps, {
      conversationId: conv.id,
      action: 'resolve',
      handoffIds: r1.resolvedHandoffIds,
    });
    const r2 = await resolveHandoff(t.db, t.agent, conv.id, ctx);
    expect(r2.resolvedHandoffIds).toEqual([]);
    expect(
      await sendHandoffActionMessage(t.db, deps, {
        conversationId: conv.id,
        action: 'resolve',
        handoffIds: r2.resolvedHandoffIds,
      }),
    ).toEqual({ status: 'skipped' });
    expect((await rows(conv.id)).filter((m) => m.senderType === 'bot')).toHaveLength(1);
    expect(scheduler.outbound).toHaveLength(1);
  });
});
