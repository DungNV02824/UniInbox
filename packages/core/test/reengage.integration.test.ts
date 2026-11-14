// "Tái chăm sóc khách bị bỏ sót": quét (preview), kiểm lại + xếp hàng (start), lượt ai-reply reengage.
// Postgres thật (Testcontainers), Redis/scheduler/LLM giả.
import {
  aiRuns,
  auditLogs,
  chatbots,
  conversations,
  type ChannelAccount,
  type Chatbot,
  type Conversation,
  type NewConversation,
} from '@dezon/db';
import { REENGAGE_LIMITS } from '@dezon/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InboxNotFoundError, InboxValidationError } from '../src/inbox/errors';
import { aiReengageJobId } from '../src/jobs';
import {
  previewChatbotReengage,
  REENGAGE_SEND_MARGIN_MINUTES,
  REENGAGE_TEXT_EXCERPT_CHARS,
  reengageTextExcerpt,
  startChatbotReengage,
  type ReengageJob,
  type ReengageQueue,
} from '../src/ai/reengage';
import { needsChatbotKick } from '../src/ai/service';
import {
  AI_BLOCKED_REENGAGE_BOT_CHANGED,
  AI_BLOCKED_REENGAGE_RESOLVED,
  AI_SKIP_NO_NEW_MESSAGES,
  processAiReplyJob,
} from '../src/ai/runtime';
import { putAiSettings } from '../src/ai/settings';
import { loadPendingMessages } from '../src/ai/turn-input';
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
const RANDOM_ID = '7f1c2a9e-3b4d-4c5e-8f60-112233445566';

let t: TestDb;
let messenger: ChannelAccount;
let zalo: ChannelAccount;
let offline: ChannelAccount;
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
  offline = await createChannel(t.db, { displayName: 'Page mất kết nối', status: 'disconnected' });
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
    .values({ name: `Bot tái chăm sóc ${++botSeq}`, ...values })
    .returning();
  return bot!;
}

/** Hội thoại gắn bot, khách nhắn `text` cách đây `agoMs` (chưa ai trả lời). */
async function missed(
  bot: Chatbot,
  channel: ChannelAccount,
  agoMs: number,
  extra: Partial<NewConversation> & { text?: string; contactName?: string } = {},
): Promise<Conversation> {
  const { text = 'Shop ơi còn hàng không?', contactName = 'Chị Lan', ...rest } = extra;
  const conv = await createConversation(t.db, {
    channel,
    contactName,
    chatbotId: bot.id,
    aiMode: 'auto',
    lastCustomerMessageAt: ago(agoMs),
    ...rest,
  });
  await addMessage(t.db, conv, { text, sentAt: ago(agoMs) });
  return conv;
}

const ids = (items: { conversationId: string }[]) => items.map((i) => i.conversationId).sort();
const sorted = (...xs: string[]) => [...xs].sort();

/** Khe giãn cách chung giả (cùng quy tắc RESERVE_SLOT_LUA của API). */
function slotKeeper(): ReengageQueue['reserveSlot'] {
  let nextSlot = 0;
  return async ({ nowMs, spacingMs, latestMs }) => {
    const slot = Math.max(nowMs, nextSlot);
    if (latestMs !== null && slot > latestMs) return null;
    nextSlot = slot + spacingMs;
    return slot;
  };
}

/** Hàng đợi giả kiểu BullMQ: jobId còn giữ ⇒ pending, enqueue trả false (không thêm); khe giãn cách chung. */
function fakeQueue(pendingConversationIds: string[] = []) {
  const jobs: ReengageJob[] = [];
  const held = new Set(pendingConversationIds.map(aiReengageJobId));
  const queue: ReengageQueue = {
    pending: async (convIds) => new Set(convIds.filter((id) => held.has(aiReengageJobId(id)))),
    reserveSlot: slotKeeper(),
    enqueue: async (job) => {
      if (held.has(job.jobId)) return false;
      held.add(job.jobId);
      jobs.push(job);
      return true;
    },
  };
  return { jobs, held, queue };
}

const runPreview = (chatbotId: string, days: number, queue: ReengageQueue = fakeQueue().queue) =>
  previewChatbotReengage(t.db, ctx, chatbotId, days, queue);

/** Text part cuối của content cuối trong lần gọi LLM thứ i (dòng "(Bối cảnh lượt này)"). */
function lastContextText(i: number): string {
  const contents = kit.llm.calls[i]!.contents;
  const parts = contents[contents.length - 1]!.parts;
  const last = parts[parts.length - 1]!;
  return 'text' in last ? last.text : '';
}

/** Đồng hồ đứng yên (delay so sánh chính xác giữa nhiều lần bấm). */
const frozenCtx = (at: Date = new Date()) => makeCtx({ now: () => at });

const runsOf = (conversationId: string) =>
  t.db.select().from(aiRuns).where(eq(aiRuns.conversationId, conversationId)).orderBy(asc(aiRuns.createdAt));

describe('previewChatbotReengage — phân loại theo kênh', () => {
  it('Messenger trong 24 giờ / Zalo cá nhân nhiều ngày ⇒ eligible; Messenger quá 24 giờ, quảng cáo quá 7 ngày, kênh mất kết nối ⇒ outsideWindow kèm lý do', async () => {
    const bot = await createBot();
    const fresh = await missed(bot, messenger, 2 * HOUR, { text: '  Giá   bộ sofa\nnày bao nhiêu? ' });
    const zaloOld = await missed(bot, zalo, 5 * DAY);
    const stale = await missed(bot, messenger, 30 * HOUR);
    // Quảng cáo: tin đầu 3 ngày trước ⇒ cửa sổ 7 ngày còn; tin đầu 10 ngày trước ⇒ hết.
    const adsOk = await missed(bot, messenger, 2 * DAY, { windowSource: 'ads' });
    await addMessage(t.db, adsOk, { text: 'Tin đầu từ quảng cáo', sentAt: ago(3 * DAY) });
    const adsOld = await missed(bot, messenger, 2 * DAY, { windowSource: 'ads' });
    await addMessage(t.db, adsOld, { text: 'Tin đầu từ quảng cáo', sentAt: ago(10 * DAY) });
    const disconnected = await missed(bot, offline, HOUR);

    const preview = await runPreview(bot.id, 15);
    expect(preview.days).toBe(15);
    expect(preview.truncated).toBe(false);
    expect(ids(preview.eligible)).toEqual(sorted(fresh.id, zaloOld.id, adsOk.id));
    expect(ids(preview.outsideWindow)).toEqual(sorted(stale.id, adsOld.id, disconnected.id));

    const item = preview.eligible.find((i) => i.conversationId === fresh.id)!;
    expect(item).toMatchObject({
      contactName: 'Chị Lan',
      channelName: 'Fanpage Dezon',
      channelType: 'messenger',
      waitingMessages: 1,
      lastCustomerText: 'Giá bộ sofa này bao nhiêu?',
    });
    expect(item.reason).toBeUndefined();
    expect(Date.parse(item.lastCustomerMessageAt)).toBeGreaterThan(Date.now() - 2 * HOUR - MIN);
    // Mới nhất trước.
    expect(preview.eligible[0]!.conversationId).toBe(fresh.id);

    const reasons = Object.fromEntries(preview.outsideWindow.map((i) => [i.conversationId, i.reason]));
    expect(reasons[stale.id]).toContain('24 giờ');
    expect(reasons[adsOld.id]).toBeTruthy();
    expect(reasons[disconnected.id]).toBe('Kênh đang mất kết nối');
  });

  it('đếm tin chờ sau tin nhân viên cuối; tin chỉ có tệp ⇒ lastCustomerText null', async () => {
    const bot = await createBot();
    const conv = await missed(bot, zalo, 3 * DAY, { text: 'Tin cũ trước khi nhân viên trả lời' });
    await addMessage(t.db, conv, { senderType: 'agent', text: 'Dạ em gửi giá', sentAt: ago(3 * DAY - HOUR) });
    await addMessage(t.db, conv, { text: 'Cảm ơn, cho chị hỏi thêm', sentAt: ago(2 * DAY) });
    await addMessage(t.db, conv, {
      text: null,
      attachments: [{ type: 'image', storage_key: 'k', mime: 'image/jpeg' }],
      sentAt: ago(2 * DAY - MIN),
    });
    await t.db
      .update(conversations)
      .set({ lastCustomerMessageAt: ago(2 * DAY - MIN) })
      .where(eq(conversations.id, conv.id));

    const preview = await runPreview(bot.id, 15);
    expect(preview.eligible).toHaveLength(1);
    expect(preview.eligible[0]).toMatchObject({ waitingMessages: 2, lastCustomerText: null });
  });
});

describe('previewChatbotReengage — loại trừ', () => {
  it('nhân viên trả lời sau cùng, chờ người (bot dừng), đã xử lý, đang tạm dừng, bot khác, ai_mode off, quá N ngày, tin đã xử lý, tin vừa đến', async () => {
    const bot = await createBot();
    const other = await createBot();
    const ok = await missed(bot, zalo, 2 * HOUR);

    const staffLast = await missed(bot, zalo, 3 * HOUR);
    await addMessage(t.db, staffLast, { senderType: 'agent', text: 'Dạ còn ạ', sentAt: ago(2 * HOUR) });

    await missed(bot, zalo, 2 * HOUR, { status: 'pending_human' });
    // Nhân viên đánh dấu "Đã xử lý" sau tin khách (đã gọi điện…) ⇒ coi như đã lo.
    await missed(bot, zalo, 2 * HOUR, { status: 'resolved' });
    await missed(bot, zalo, 2 * HOUR, { aiPausedUntil: new Date(Date.now() + 10 * MIN) });
    const pauseOver = await missed(bot, zalo, 2 * HOUR, { aiPausedUntil: ago(MIN) });
    await missed(other, zalo, 2 * HOUR);
    await missed(bot, zalo, 2 * HOUR, { aiMode: 'off' });
    const fiveDays = await missed(bot, zalo, 5 * DAY);

    const processed = await missed(bot, zalo, 4 * HOUR);
    const [msg] = await loadPendingMessages(t.db, processed.id, { maxAgeHours: 24 });
    await t.db.insert(aiRuns).values({
      conversationId: processed.id,
      chatbotId: bot.id,
      triggerMessageIds: [msg!.id],
      model: 'gemini-test',
      decision: 'reply',
    });

    await missed(bot, zalo, MIN); // vừa nhắn: luồng debounce thường đang lo

    const preview3 = await runPreview(bot.id, 3);
    expect(ids(preview3.eligible)).toEqual(sorted(ok.id, pauseOver.id));
    expect(preview3.outsideWindow).toEqual([]);

    const preview7 = await runPreview(bot.id, 7);
    expect(ids(preview7.eligible)).toEqual(sorted(ok.id, pauseOver.id, fiveDays.id));
  });

  it("bot 'continue': hội thoại chờ người vẫn được quét", async () => {
    const bot = await createBot({ aiHandoffMode: 'continue' });
    const conv = await missed(bot, zalo, 2 * HOUR, { status: 'pending_human' });
    expect(ids((await runPreview(bot.id, 15)).eligible)).toEqual([conv.id]);
  });

  it('echo tự động của Page (Tin vắng mặt / Trả lời nhanh) không tính là nhân viên trả lời', async () => {
    const bot = await createBot();
    // Khách nhắn lúc bot tắt, Page tự gửi tin vắng mặt 2 giây sau (raw.automatedEcho), rồi không ai trả lời.
    const away = await missed(bot, messenger, 2 * HOUR, { text: 'Cho mình hỏi giá' });
    await addMessage(t.db, away, {
      senderType: 'agent',
      text: 'Cảm ơn bạn đã nhắn tin, chúng tôi sẽ trả lời sớm',
      raw: { automatedEcho: true },
      sentAt: ago(2 * HOUR - 2_000),
    });
    // Nhân viên thật trả lời sau tin khách ⇒ vẫn loại.
    const staff = await missed(bot, messenger, 2 * HOUR);
    await addMessage(t.db, staff, { senderType: 'agent', text: 'Dạ', sentAt: ago(2 * HOUR - 2_000) });

    const preview = await runPreview(bot.id, 15);
    expect(ids(preview.eligible)).toEqual([away.id]);
    expect(preview.eligible[0]).toMatchObject({ waitingMessages: 1, lastCustomerText: 'Cho mình hỏi giá' });
    // "Đánh thức" bot (bật lại bot / Tiếp tục AI) dùng cùng quy tắc người gửi cuối.
    expect(await needsChatbotKick(t.db, away.id, new Date())).toBe(true);
    expect(await needsChatbotKick(t.db, staff.id, new Date())).toBe(false);
  });

  it('khách đã có lượt tái chăm sóc đang chờ (lần bấm trước) ⇒ không vào eligible, đếm alreadyQueued', async () => {
    const bot = await createBot();
    const first = await missed(bot, zalo, 2 * HOUR);
    const second = await missed(bot, zalo, 3 * HOUR);
    const q = fakeQueue([first.id]);
    const preview = await runPreview(bot.id, 15, q.queue);
    expect(ids(preview.eligible)).toEqual([second.id]);
    expect(preview.alreadyQueued).toBe(1);
    expect(preview.truncated).toBe(false);
  });

  it(`khung gửi đóng trong vòng ${REENGAGE_SEND_MARGIN_MINUTES} phút ⇒ outsideWindow (nhân viên trả lời ngay)`, async () => {
    const bot = await createBot();
    const closing = await missed(bot, messenger, DAY - 2 * MIN);
    const preview = await runPreview(bot.id, 15);
    expect(preview.eligible).toEqual([]);
    expect(ids(preview.outsideWindow)).toEqual([closing.id]);
    expect(preview.outsideWindow[0]!.reason).toContain('sắp đóng');
  });

  it('bot không có ⇒ 404; bot tắt / AI tổng tắt / số ngày sai ⇒ 400', async () => {
    await expect(runPreview(RANDOM_ID, 15)).rejects.toBeInstanceOf(InboxNotFoundError);
    const inactive = await createBot({ isActive: false });
    await expect(runPreview(inactive.id, 15)).rejects.toBeInstanceOf(InboxValidationError);
    const bot = await createBot();
    await expect(runPreview(bot.id, 0)).rejects.toBeInstanceOf(InboxValidationError);
    await expect(runPreview(bot.id, 31)).rejects.toBeInstanceOf(InboxValidationError);
    await putAiSettings(t.db, t.admin.id, { enabled: false });
    try {
      await expect(runPreview(bot.id, 15)).rejects.toBeInstanceOf(InboxValidationError);
      await expect(
        startChatbotReengage(
          t.db,
          ctx,
          { actorUserId: t.admin.id, chatbotId: bot.id, days: 15, conversationIds: [RANDOM_ID] },
          fakeQueue().queue,
        ),
      ).rejects.toBeInstanceOf(InboxValidationError);
    } finally {
      await putAiSettings(t.db, t.admin.id, { enabled: true });
    }
  });
});

describe('startChatbotReengage', () => {
  it('kiểm lại từng id, giãn cách spacingSec, jobId riêng, bỏ trùng; audit chỉ có số đếm', async () => {
    const bot = await createBot();
    const a = await missed(bot, zalo, 3 * DAY, { text: 'Nội dung riêng tư của khách' });
    const b = await missed(bot, messenger, 2 * HOUR);
    const outside = await missed(bot, messenger, 30 * HOUR);
    const answered = await missed(bot, zalo, 3 * HOUR);
    await addMessage(t.db, answered, { senderType: 'agent', text: 'Dạ', sentAt: ago(HOUR) });

    const rec = fakeQueue();
    const result = await startChatbotReengage(
      t.db,
      ctx,
      {
        actorUserId: t.admin.id,
        chatbotId: bot.id,
        days: 15,
        conversationIds: [a.id, outside.id, b.id, answered.id, RANDOM_ID, a.id],
      },
      rec.queue,
    );
    expect(result).toMatchObject({
      queued: 2,
      alreadyQueued: 0,
      skipped: 3,
      spacingSec: REENGAGE_LIMITS.spacingSec,
      estimatedMinutes: 1,
      startsInMinutes: 0,
    });
    // Khung đóng trong lúc chờ ⇒ trả lại cho nhân viên, kèm lý do.
    expect(ids(result.outsideWindow)).toEqual([outside.id]);
    expect(result.outsideWindow[0]!.reason).toContain('24 giờ');
    // Khung đóng sớm nhất trước: Messenger (còn ~22 giờ) rồi mới Zalo cá nhân (không giới hạn).
    expect(rec.jobs.map((j) => [j.conversationId, j.jobId, j.delayMs])).toEqual([
      [b.id, aiReengageJobId(b.id), 0],
      [a.id, aiReengageJobId(a.id), REENGAGE_LIMITS.spacingSec * 1000],
    ]);
    expect(aiReengageJobId(a.id)).toBe(`ai-${a.id}-reengage`);
    expect(rec.jobs[1]!.data).toMatchObject({
      conversationId: a.id,
      reengage: { pendingMaxAgeHours: 15 * 24, chatbotId: bot.id },
    });

    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'chatbot.reengage'), eq(auditLogs.entityId, bot.id)));
    expect(audit).toMatchObject({ userId: t.admin.id, entity: 'chatbot' });
    expect(audit!.data).toEqual({
      days: 15,
      requested: 5,
      queued: 2,
      alreadyQueued: 0,
      skipped: 3,
      rulesChars: 0,
      contentChars: 0,
    });
    expect(JSON.stringify(audit!.data)).not.toContain('riêng tư');
  });

  it('chỉ dẫn gõ tay (Quy tắc chăm sóc / Nội dung chăm sóc lại) đi theo job (trim, ô trống bỏ); audit chỉ ghi độ dài', async () => {
    const bot = await createBot();
    const a = await missed(bot, zalo, 3 * DAY);
    const rec = fakeQueue();
    await startChatbotReengage(
      t.db,
      ctx,
      {
        actorUserId: t.admin.id,
        chatbotId: bot.id,
        days: 15,
        conversationIds: [a.id],
        rules: '  Xưng em, nhắn ngắn gọn  ',
        content: '   ',
      },
      rec.queue,
    );
    expect(rec.jobs[0]!.data.reengage).toEqual({
      pendingMaxAgeHours: 15 * 24,
      chatbotId: bot.id,
      rules: 'Xưng em, nhắn ngắn gọn',
    });
    const [audit] = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'chatbot.reengage'), eq(auditLogs.entityId, bot.id)));
    expect(audit!.data).toMatchObject({ rulesChars: 22, contentChars: 0 });
    expect(JSON.stringify(audit!.data)).not.toContain('Xưng em');
  });

  it('bấm lại khi job còn chờ ⇒ alreadyQueued (không đếm là đã xếp); preview sau đó chuyển sang khách tiếp theo', async () => {
    const bot = await createBot();
    const a = await missed(bot, zalo, 2 * HOUR);
    const b = await missed(bot, zalo, 3 * HOUR);
    const q = fakeQueue();
    const input = { actorUserId: t.admin.id, chatbotId: bot.id, days: 15 };
    const clock = frozenCtx();

    const first = await startChatbotReengage(t.db, clock, { ...input, conversationIds: [a.id] }, q.queue);
    expect(first).toMatchObject({ queued: 1, alreadyQueued: 0, skipped: 0 });

    // "Kiểm tra lại" ngay: a đã nằm trong hàng ⇒ chỉ còn b.
    const preview = await runPreview(bot.id, 15, q.queue);
    expect(ids(preview.eligible)).toEqual([b.id]);
    expect(preview.alreadyQueued).toBe(1);

    const again = await startChatbotReengage(
      t.db,
      clock,
      { ...input, conversationIds: [a.id, b.id] },
      q.queue,
    );
    expect(again).toMatchObject({
      queued: 1,
      alreadyQueued: 1,
      skipped: 0,
      estimatedMinutes: 1,
      startsInMinutes: 1,
    });
    // a (còn chờ) không giữ khe; b nối sau a trong hàng chung.
    expect(q.jobs.map((j) => [j.conversationId, j.delayMs])).toEqual([
      [a.id, 0],
      [b.id, REENGAGE_LIMITS.spacingSec * 1000],
    ]);

    // Hai admin cùng bấm: job kia vừa được thêm giữa lúc kiểm tra và lúc đẩy ⇒ enqueue false ⇒ alreadyQueued.
    const c = await missed(bot, zalo, 4 * HOUR);
    const racing: ReengageQueue = {
      pending: async () => new Set(),
      reserveSlot: async ({ nowMs }) => nowMs,
      enqueue: async () => false,
    };
    const raced = await startChatbotReengage(t.db, ctx, { ...input, conversationIds: [c.id] }, racing);
    expect(raced).toMatchObject({ queued: 0, alreadyQueued: 1, skipped: 0, estimatedMinutes: 0 });

    const audits = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'chatbot.reengage'), eq(auditLogs.entityId, bot.id)));
    expect(audits.map((x) => x.data)).toEqual(
      expect.arrayContaining([
        { days: 15, requested: 2, queued: 1, alreadyQueued: 1, skipped: 0, rulesChars: 0, contentChars: 0 },
      ]),
    );
  });

  it('xếp khung đóng sớm nhất trước; khách mà khung đóng trước lượt của bot ⇒ không xếp, trả về outsideWindow', async () => {
    const bot = await createBot();
    // Ba khách Messenger còn ~3 phút 22 giây (tạo trước ⇒ đóng sớm hơn chút), một khách Zalo cá nhân.
    const left = DAY - (REENGAGE_SEND_MARGIN_MINUTES * MIN + 22_000);
    const e1 = await missed(bot, messenger, left);
    const e2 = await missed(bot, messenger, left);
    const e3 = await missed(bot, messenger, left);
    const z = await missed(bot, zalo, 2 * DAY);

    const q = fakeQueue();
    const result = await startChatbotReengage(
      t.db,
      ctx,
      { actorUserId: t.admin.id, chatbotId: bot.id, days: 15, conversationIds: [z.id, e3.id, e2.id, e1.id] },
      q.queue,
    );
    const spacingMs = REENGAGE_LIMITS.spacingSec * 1000;
    // e1 chạy ngay, e2 sau 15 giây (còn > 3 phút); e3 tới lượt sau 30 giây thì khung chỉ còn < 3 phút ⇒ nhân viên.
    expect(q.jobs.map((j) => [j.conversationId, j.delayMs])).toEqual([
      [e1.id, 0],
      [e2.id, spacingMs],
      [z.id, 2 * spacingMs],
    ]);
    expect(result).toMatchObject({ queued: 3, alreadyQueued: 0, skipped: 1 });
    expect(ids(result.outsideWindow)).toEqual([e3.id]);
    expect(result.outsideWindow[0]!.reason).toContain('trước lượt của bot');
  });

  it('nhiều lần bấm (bot khác, admin khác, bấm lại sau "Kiểm tra lại") nối tiếp trong MỘT hàng giãn cách', async () => {
    const bot1 = await createBot();
    const bot2 = await createBot();
    const spacingMs = REENGAGE_LIMITS.spacingSec * 1000;
    const batch1: Conversation[] = [];
    for (let i = 0; i < 5; i++) batch1.push(await missed(bot1, zalo, (2 + i) * HOUR));
    // Lần sau: một khách Messenger chỉ còn ~3 phút 22 giây (lượt nối sau hàng ⇒ không kịp) + hai khách Zalo.
    const closing = await missed(bot2, messenger, DAY - (REENGAGE_SEND_MARGIN_MINUTES * MIN + 22_000));
    const z1 = await missed(bot2, zalo, 2 * DAY);
    const z2 = await missed(bot2, zalo, 3 * DAY);

    const q = fakeQueue(); // cùng Redis ⇒ cùng hàng cho mọi bot
    const clock = frozenCtx();
    const first = await startChatbotReengage(
      t.db,
      clock,
      { actorUserId: t.admin.id, chatbotId: bot1.id, days: 15, conversationIds: batch1.map((c) => c.id) },
      q.queue,
    );
    expect(first).toMatchObject({ queued: 5, estimatedMinutes: 2, startsInMinutes: 0 });
    expect(q.jobs.map((j) => j.delayMs)).toEqual([0, 1, 2, 3, 4].map((k) => k * spacingMs));

    const second = await startChatbotReengage(
      t.db,
      clock,
      { actorUserId: t.admin.id, chatbotId: bot2.id, days: 15, conversationIds: [closing.id, z1.id, z2.id] },
      q.queue,
    );
    // Nối sau 5 khe của lần trước (75 s, 90 s); thời gian ước tính tính cả hàng còn chờ.
    expect(q.jobs.slice(5).map((j) => [j.conversationId, j.delayMs])).toEqual([
      [z1.id, 5 * spacingMs],
      [z2.id, 6 * spacingMs],
    ]);
    expect(second).toMatchObject({
      queued: 2,
      alreadyQueued: 0,
      skipped: 1,
      estimatedMinutes: 2,
      startsInMinutes: 2,
    });
    // Khung đóng trước lượt (đã dời) của bot ⇒ nhân viên trả lời ngay.
    expect(ids(second.outsideWindow)).toEqual([closing.id]);
    expect(second.outsideWindow[0]!.reason).toContain('trước lượt của bot');
  });

  it(`tối đa ${REENGAGE_LIMITS.maxPerRun} hội thoại mỗi lần`, async () => {
    const bot = await createBot();
    const conv = await missed(bot, zalo, 2 * HOUR);
    const fake = Array.from(
      { length: REENGAGE_LIMITS.maxPerRun },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const rec = fakeQueue();
    // Id thật đứng thứ 101 ⇒ bị cắt.
    const result = await startChatbotReengage(
      t.db,
      ctx,
      { actorUserId: t.admin.id, chatbotId: bot.id, days: 15, conversationIds: [...fake, conv.id] },
      rec.queue,
    );
    expect(result).toMatchObject({ queued: 0, skipped: REENGAGE_LIMITS.maxPerRun, estimatedMinutes: 0 });
    expect(rec.jobs).toEqual([]);
  });
});

describe('processAiReplyJob — lượt tái chăm sóc', () => {
  it('trả lời tin cũ hơn 24 giờ (Zalo cá nhân) với ghi chú xin lỗi trả lời muộn; lượt thường không thấy tin đó, không có ghi chú', async () => {
    const bot = await createBot();
    const conv = await missed(bot, zalo, 3 * DAY + HOUR, { text: 'Báo giá giúp chị bộ bàn ăn' });

    const normal = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(normal).toMatchObject({ status: 'skipped', reason: AI_SKIP_NO_NEW_MESSAGES });
    expect(kit.llm.calls).toHaveLength(0);

    const reengage = { pendingMaxAgeHours: 15 * 24, chatbotId: bot.id };
    const out = await processAiReplyJob(t.db, kit.deps, conv.id, { reengage });
    expect(out).toMatchObject({ status: 'done', decision: 'reply' });
    expect(kit.llm.calls).toHaveLength(1);
    const note = lastContextText(0);
    expect(note).toContain('cách đây khoảng 3 ngày');
    expect(note).toContain('xin lỗi');
    // systemInstruction không đổi theo lượt.
    expect(kit.llm.calls[0]!.systemInstruction).not.toContain('xin lỗi ngắn gọn');
    expect(kit.scheduler.outbound.length).toBeGreaterThan(0);
    const runs = await runsOf(conv.id);
    expect(runs.at(-1)!.triggerMessageIds).toHaveLength(1);

    // Chạy lại (bấm hai lần / job trùng) ⇒ không còn gì, không gọi AI lần nữa.
    const again = await processAiReplyJob(t.db, kit.deps, conv.id, { reengage });
    expect(again).toMatchObject({ status: 'skipped', reason: AI_SKIP_NO_NEW_MESSAGES });
    expect(kit.llm.calls).toHaveLength(1);

    // Lượt thường (tin mới) không có ghi chú trả lời muộn.
    const fresh = await missed(bot, zalo, 10_000);
    await processAiReplyJob(t.db, kit.deps, fresh.id);
    expect(kit.llm.calls).toHaveLength(2);
    expect(lastContextText(1)).not.toContain('CHƯA được ai trả lời');
  });

  it('job có Quy tắc chăm sóc + Nội dung chăm sóc lại ⇒ prompt lượt này có khối chỉ dẫn; systemInstruction không đổi', async () => {
    const bot = await createBot();
    const conv = await missed(bot, zalo, 2 * DAY, { text: 'Bên em còn nhận công trình không' });
    const reengage = {
      pendingMaxAgeHours: 15 * 24,
      chatbotId: bot.id,
      rules: 'Xưng em, gọi anh/chị; không báo giá cụ thể',
      content: 'Mời khách đặt lịch khảo sát miễn phí trong tháng 11',
    };
    const out = await processAiReplyJob(t.db, kit.deps, conv.id, { reengage });
    expect(out).toMatchObject({ status: 'done', decision: 'reply' });
    const note = lastContextText(0);
    expect(note).toContain('xin lỗi');
    expect(note).toContain('Quy tắc chăm sóc:\nXưng em, gọi anh/chị; không báo giá cụ thể');
    expect(note).toContain('Mời khách đặt lịch khảo sát miễn phí trong tháng 11');
    expect(kit.llm.calls[0]!.systemInstruction).not.toContain('Quy tắc chăm sóc');
  });

  it('bị chặn (ngoài cửa sổ, đổi bot, đủ lượt/giờ) ⇒ KHÔNG coi tin là đã xử lý', async () => {
    const bot = await createBot();
    const reengage = { pendingMaxAgeHours: 15 * 24, chatbotId: bot.id };

    // Messenger quá 24 giờ: bot không được gửi.
    const stale = await missed(bot, messenger, 30 * HOUR);
    const out1 = await processAiReplyJob(t.db, kit.deps, stale.id, { reengage });
    expect(out1).toMatchObject({ status: 'skipped' });
    expect((out1 as { reason: string }).reason).toContain('Không được gửi');
    expect((await runsOf(stale.id)).at(-1)!.triggerMessageIds).toEqual([]);
    expect(await loadPendingMessages(t.db, stale.id, { maxAgeHours: 15 * 24 })).toHaveLength(1);

    // Hội thoại đã đổi sang bot khác sau lúc bấm.
    const other = await createBot();
    const moved = await missed(other, zalo, 2 * DAY);
    const out2 = await processAiReplyJob(t.db, kit.deps, moved.id, { reengage });
    expect(out2).toMatchObject({ status: 'skipped', reason: AI_BLOCKED_REENGAGE_BOT_CHANGED });
    expect((await runsOf(moved.id)).at(-1)!.triggerMessageIds).toEqual([]);

    // Đủ lượt trả lời/giờ: vẫn áp giới hạn, không nuốt tin.
    const capped = await createBot({ maxRepliesPerHour: 1 });
    const busy = await missed(capped, zalo, 2 * DAY);
    await t.db.insert(aiRuns).values({
      conversationId: busy.id,
      chatbotId: capped.id,
      triggerMessageIds: [],
      model: 'x',
      decision: 'reply',
    });
    const out3 = await processAiReplyJob(t.db, kit.deps, busy.id, {
      reengage: { pendingMaxAgeHours: 15 * 24, chatbotId: capped.id },
    });
    expect((out3 as { reason: string }).reason).toContain('giới hạn');
    expect((await runsOf(busy.id)).at(-1)!.triggerMessageIds).toEqual([]);
    expect(await loadPendingMessages(t.db, busy.id, { maxAgeHours: 15 * 24 })).toHaveLength(1);
    expect(kit.llm.calls).toHaveLength(0);
  });

  it('nhân viên đánh dấu "Đã xử lý" sau lúc bấm (hoặc trong lúc gọi AI) ⇒ chặn, KHÔNG coi tin là đã xử lý', async () => {
    const bot = await createBot();
    const reengage = { pendingMaxAgeHours: 15 * 24, chatbotId: bot.id };

    const resolved = await missed(bot, zalo, 2 * DAY, { status: 'resolved' });
    const out = await processAiReplyJob(t.db, kit.deps, resolved.id, { reengage });
    expect(out).toMatchObject({ status: 'skipped', reason: AI_BLOCKED_REENGAGE_RESOLVED });
    expect((await runsOf(resolved.id)).at(-1)!.triggerMessageIds).toEqual([]);
    expect(await loadPendingMessages(t.db, resolved.id, { maxAgeHours: 15 * 24 })).toHaveLength(1);
    expect(kit.llm.calls).toHaveLength(0);

    // Đóng trong lúc gọi AI ⇒ hủy dưới khóa, không gửi tin bot.
    const racing = await missed(bot, zalo, 2 * DAY);
    kit.llm.impl = async () => {
      await t.db.update(conversations).set({ status: 'resolved' }).where(eq(conversations.id, racing.id));
      return llmReply(['Dạ xin lỗi anh/chị vì phản hồi muộn']);
    };
    const raced = await processAiReplyJob(t.db, kit.deps, racing.id, { reengage });
    expect(raced).toMatchObject({ status: 'cancelled', reason: AI_BLOCKED_REENGAGE_RESOLVED });
    expect((await runsOf(racing.id)).at(-1)!.triggerMessageIds).toEqual([]);
    expect(kit.scheduler.outbound).toHaveLength(0);
  });

  it('không xóa khóa debounce của luồng thường', async () => {
    const bot = await createBot();
    const conv = await missed(bot, zalo, 2 * DAY);
    kit.redis.store.set(`debounce:${conv.id}:first`, '1');
    await processAiReplyJob(t.db, kit.deps, conv.id, {
      reengage: { pendingMaxAgeHours: 15 * 24, chatbotId: bot.id },
    });
    expect(kit.redis.store.has(`debounce:${conv.id}:first`)).toBe(true);
  });
});

describe('reengageTextExcerpt', () => {
  it('gộp khoảng trắng, cắt kèm dấu …, rỗng ⇒ null', () => {
    expect(reengageTextExcerpt('  a \n b ')).toBe('a b');
    expect(reengageTextExcerpt('   ')).toBeNull();
    expect(reengageTextExcerpt(null)).toBeNull();
    const long = reengageTextExcerpt('ă'.repeat(300))!;
    expect(Array.from(long)).toHaveLength(REENGAGE_TEXT_EXCERPT_CHARS);
    expect(long.endsWith('…')).toBe(true);
  });
});
