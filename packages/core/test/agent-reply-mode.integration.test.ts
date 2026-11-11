// Test tích hợp "Khi nhân viên vào nhắn tin" (chatbots.agent_reply_mode: continue / pause / stop): sendAgentMessage,
// echo Business Suite, gỡ pause của echo tự động, "Tiếp tục AI" / bật lại bot với mốc "dừng hẳn".
import { chatbots, conversations, messages, type ChannelAccount } from '@dezon/db';
import {
  AI_PAUSED_INDEFINITELY_ISO,
  isAiPausedIndefinitely,
  type AgentReplyMode,
  type NormalizedInboundMessage,
} from '@dezon/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pauseAiAfterAgentMessage } from '../src/ai/agent-pause';
import { resumeConversationAi, setConversationChatbot } from '../src/ai/service';
import { loadPendingMessages } from '../src/ai/turn-input';
import { sendAgentMessage } from '../src/inbox/commands';
import { processInboundMessage } from '../src/pipeline/inbound';
import type { PipelineDeps } from '../src/pipeline/types';
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
const PAGE_INBOX_APP_ID = 263902037430900;
let botSeq = 0;

beforeAll(async () => {
  t = await startTestDb();
  channel = await createChannel(t.db);
});

afterAll(async () => {
  await t?.stop();
});

async function createBot(mode: AgentReplyMode, agentPauseMinutes: number | null = null) {
  const [bot] = await t.db
    .insert(chatbots)
    .values({ name: `Bot ${mode} ${++botSeq}`, agentReplyMode: mode, agentPauseMinutes })
    .returning();
  return bot!;
}

async function botConv(mode: AgentReplyMode, agentPauseMinutes: number | null = null) {
  const bot = await createBot(mode, agentPauseMinutes);
  const conv = await createConversation(t.db, {
    channel,
    chatbotId: bot.id,
    aiMode: 'auto',
    lastCustomerMessageAt: new Date(),
  });
  return { bot, conv };
}

const pausedUntil = async (conversationId: string) =>
  (await t.db.select().from(conversations).where(eq(conversations.id, conversationId)))[0]!.aiPausedUntil;

const send = (conversationId: string, text = 'Dạ em chào chị', c = ctx) =>
  sendAgentMessage(t.db, t.admin, conversationId, { text, attachments: [] }, c);

describe('pauseAiAfterAgentMessage', () => {
  it('không có bot ⇒ null, không đổi gì', async () => {
    const conv = await createConversation(t.db, { channel });
    expect(await pauseAiAfterAgentMessage(t.db, conv.id, new Date())).toBeNull();
    expect(await pausedUntil(conv.id)).toBeNull();
  });

  it('pause: không rút ngắn pause dài hơn; không gỡ "dừng hẳn"', async () => {
    const { conv } = await botConv('pause', 10);
    const at = new Date();
    const first = await pauseAiAfterAgentMessage(t.db, conv.id, at);
    expect(first).toMatchObject({ mode: 'pause', applied: true });
    expect(first!.pausedUntil!.getTime()).toBe(at.getTime() + 10 * MIN);
    // Tin đồng bộ cũ hơn ⇒ mốc ngắn hơn ⇒ giữ nguyên.
    const older = await pauseAiAfterAgentMessage(t.db, conv.id, new Date(at.getTime() - 5 * MIN));
    expect(older).toMatchObject({ applied: false });
    expect((await pausedUntil(conv.id))!.getTime()).toBe(at.getTime() + 10 * MIN);

    await t.db
      .update(conversations)
      .set({ aiPausedUntil: new Date(AI_PAUSED_INDEFINITELY_ISO) })
      .where(eq(conversations.id, conv.id));
    expect(await pauseAiAfterAgentMessage(t.db, conv.id, new Date())).toMatchObject({ applied: false });
    expect((await pausedUntil(conv.id))!.toISOString()).toBe(AI_PAUSED_INDEFINITELY_ISO);
  });

  it('không deadlock với transaction khác vừa chèn tin vào cùng hội thoại (echo + tin khách song song)', async () => {
    // Tái hiện thứ tự khóa của storeInboundMessage: B (tin khách) INSERT messages ⇒ FOR KEY SHARE dòng hội thoại;
    // A (echo nhân viên) INSERT messages + UPDATE conversations (NO KEY UPDATE) ⇒ B UPDATE conversations chờ A ⇒
    // A gọi pauseAiAfterAgentMessage. Khóa FOR UPDATE (cũ) chờ KEY SHARE của B ⇒ deadlock 40P01.
    const { conv } = await botConv('stop');
    const row = (senderType: 'customer' | 'agent', text: string) => ({
      conversationId: conv.id,
      channelAccountId: conv.channelAccountId,
      senderType,
      text,
      sentAt: new Date(),
    });
    let inserted!: () => void;
    const bInserted = new Promise<void>((resolve) => (inserted = resolve));
    let release!: () => void;
    const bRelease = new Promise<void>((resolve) => (release = resolve));

    const txB = t.db.transaction(async (tx) => {
      await tx.insert(messages).values(row('customer', 'Shop ơi'));
      inserted();
      await bRelease;
      await tx
        .update(conversations)
        .set({ lastCustomerMessageAt: new Date() })
        .where(eq(conversations.id, conv.id));
    });
    // B lỗi trước khi chèn ⇒ không treo test.
    txB.catch(() => inserted());
    await bInserted;

    const txA = t.db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.insert(messages).values(row('agent', 'Dạ em gửi chị bảng giá'));
      await tx.update(conversations).set({ lastMessageAt: new Date() }).where(eq(conversations.id, conv.id));
      release(); // B UPDATE conversations ⇒ chờ khóa dòng của A.
      await new Promise((r) => setTimeout(r, 300));
      return pauseAiAfterAgentMessage(tx, conv.id, new Date());
    });

    const [, pause] = await Promise.all([txB, txA]);
    expect(pause).toMatchObject({ mode: 'stop', applied: true });
    expect((await pausedUntil(conv.id))!.toISOString()).toBe(AI_PAUSED_INDEFINITELY_ISO);
  });
});

describe('sendAgentMessage theo agent_reply_mode', () => {
  it("'continue' ⇒ không tạm dừng; tin khách mới sau tin nhân viên vẫn là tin chưa xử lý", async () => {
    const { conv } = await botConv('continue', 15);
    const res = await send(conv.id);
    expect(res.conversation.aiPausedUntil).toBeNull();
    expect(await pausedUntil(conv.id)).toBeNull();

    // Tin khách TRƯỚC tin nhân viên coi như nhân viên đã lo; tin SAU thì bot trả lời ngay (không bị pause chặn).
    const after = await addMessage(t.db, conv, { text: 'Còn mẫu khác không shop?', sentAt: new Date() });
    const pending = await loadPendingMessages(t.db, conv.id);
    expect(pending.map((p) => p.id)).toEqual([after]);
  });

  it("'pause' ⇒ số phút của bot; bot không đặt ⇒ AI_PAUSE_AFTER_AGENT_MIN của server", async () => {
    const { conv } = await botConv('pause', 5);
    const before = Date.now();
    const res = await send(conv.id, 'Dạ', makeCtx({ aiPauseAfterAgentMin: 60 }));
    const paused = Date.parse(res.conversation.aiPausedUntil!);
    expect(paused).toBeGreaterThanOrEqual(before + 5 * MIN - 1000);
    expect(paused).toBeLessThanOrEqual(Date.now() + 5 * MIN + 1000);

    const { conv: envConv } = await botConv('pause', null);
    const b2 = Date.now();
    const r2 = await send(envConv.id, 'Dạ', makeCtx({ aiPauseAfterAgentMin: 60 }));
    const p2 = Date.parse(r2.conversation.aiPausedUntil!);
    expect(p2).toBeGreaterThanOrEqual(b2 + 60 * MIN - 1000);
    expect(p2).toBeLessThanOrEqual(Date.now() + 60 * MIN + 1000);

    // Thiếu cả hai ⇒ 30 phút.
    const { conv: defConv } = await botConv('pause', null);
    const b3 = Date.now();
    const r3 = await send(defConv.id);
    const p3 = Date.parse(r3.conversation.aiPausedUntil!);
    expect(p3).toBeGreaterThanOrEqual(b3 + 30 * MIN - 1000);
    expect(p3).toBeLessThanOrEqual(Date.now() + 30 * MIN + 1000);
  });

  it("'stop' ⇒ dừng hẳn (mốc xa); 'Tiếp tục AI' gỡ; bật lại bot cũng gỡ", async () => {
    const { bot, conv } = await botConv('stop', 5);
    const res = await send(conv.id);
    expect(res.conversation.aiPausedUntil).toBe(AI_PAUSED_INDEFINITELY_ISO);
    expect(isAiPausedIndefinitely(res.conversation.aiPausedUntil)).toBe(true);

    // Nhân viên nhắn tiếp: vẫn dừng hẳn.
    await send(conv.id, 'Thêm');
    expect((await pausedUntil(conv.id))!.toISOString()).toBe(AI_PAUSED_INDEFINITELY_ISO);

    const resumed = await resumeConversationAi(t.db, t.admin, conv.id, ctx);
    expect(resumed.conversation.aiPausedUntil).toBeNull();
    expect(await pausedUntil(conv.id)).toBeNull();

    await send(conv.id, 'Lần nữa');
    expect((await pausedUntil(conv.id))!.toISOString()).toBe(AI_PAUSED_INDEFINITELY_ISO);
    const reEnabled = await setConversationChatbot(t.db, t.admin, conv.id, bot.id, ctx);
    expect(reEnabled.conversation.aiPausedUntil).toBeNull();
  });
});

describe('echo Business Suite theo agent_reply_mode', () => {
  const deps: PipelineDeps = {
    connectors: {},
    storage: createMemoryStorage(),
    cipher: fakeCipher,
    publisher: createRecordingPublisher(),
    ctx,
    logger: silentLogger,
    maxMediaBytes: 1_000_000,
    ownAppIds: { messenger: '999' },
  };

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

  const echo = (ch: ChannelAccount, psid: string, mid: string, sentAt = new Date()) =>
    inbound(ch, psid, mid, {
      direction: 'out',
      senderType: 'agent',
      text: 'Dạ shop gửi chị bảng giá',
      sentAt,
      raw: { message: { mid, is_echo: true, app_id: PAGE_INBOX_APP_ID } },
    });

  /** Kênh có bot mặc định + hội thoại tạo bằng một tin khách lúc `firstAt`. */
  async function setup(
    mode: AgentReplyMode,
    psid: string,
    firstAt: Date,
    agentPauseMinutes: number | null = null,
  ) {
    const bot = await createBot(mode, agentPauseMinutes);
    const ch = await createChannel(t.db, { defaultChatbotId: bot.id });
    const r = await processInboundMessage(
      t.db,
      deps,
      inbound(ch, psid, `${psid}-first`, { sentAt: firstAt }),
    );
    return { ch, convId: r.conversation!.id };
  }

  const echoRaw = async (mid: string) =>
    (await t.db.select().from(messages).where(eq(messages.externalMessageId, mid)))[0]!.raw as {
      aiPauseUntil?: string;
      automatedEcho?: boolean;
    };

  it("'continue' ⇒ echo không tạm dừng, không ghi mốc pause", async () => {
    const { ch, convId } = await setup('continue', 'psid-cont', new Date(Date.now() - 2 * MIN));
    await processInboundMessage(t.db, deps, echo(ch, 'psid-cont', 'mid-cont-e'));
    expect(await pausedUntil(convId)).toBeNull();
    expect(await echoRaw('mid-cont-e')).not.toHaveProperty('aiPauseUntil');
  });

  it("'pause' ⇒ số phút của bot, echo ghi mốc pause của nó", async () => {
    const { ch, convId } = await setup('pause', 'psid-pause', new Date(Date.now() - 2 * MIN), 7);
    const before = Date.now();
    await processInboundMessage(t.db, deps, echo(ch, 'psid-pause', 'mid-pause-e'));
    const paused = (await pausedUntil(convId))!;
    expect(paused.getTime()).toBeGreaterThanOrEqual(before + 7 * MIN - 1000);
    expect(paused.getTime()).toBeLessThanOrEqual(Date.now() + 7 * MIN + 1000);
    expect((await echoRaw('mid-pause-e')).aiPauseUntil).toBe(paused.toISOString());
  });

  it("'stop' ⇒ dừng hẳn, echo ghi mốc dừng hẳn", async () => {
    const { ch, convId } = await setup('stop', 'psid-stop', new Date(Date.now() - 2 * MIN));
    await processInboundMessage(t.db, deps, echo(ch, 'psid-stop', 'mid-stop-e'));
    expect((await pausedUntil(convId))!.toISOString()).toBe(AI_PAUSED_INDEFINITELY_ISO);
    expect((await echoRaw('mid-stop-e')).aiPauseUntil).toBe(AI_PAUSED_INDEFINITELY_ISO);
  });

  it("'stop' + echo xử lý TRƯỚC tin khách (tin tự động) ⇒ gỡ mốc dừng hẳn", async () => {
    const t0 = Date.now() - 2 * MIN;
    const { ch, convId } = await setup('stop', 'psid-stop-auto', new Date(t0 - 30 * MIN));
    await processInboundMessage(t.db, deps, echo(ch, 'psid-stop-auto', 'mid-sa-e', new Date(t0 + 2_000)));
    expect((await pausedUntil(convId))!.toISOString()).toBe(AI_PAUSED_INDEFINITELY_ISO);
    await processInboundMessage(
      t.db,
      deps,
      inbound(ch, 'psid-stop-auto', 'mid-sa-in', { sentAt: new Date(t0) }),
    );
    expect((await echoRaw('mid-sa-e')).automatedEcho).toBe(true);
    expect(await pausedUntil(convId)).toBeNull();
  });

  it("'stop' + echo tự động nhưng đã dừng sẵn do nhân viên ⇒ echo không sở hữu, giữ dừng hẳn", async () => {
    const t0 = Date.now() - 2 * MIN;
    const { ch, convId } = await setup('stop', 'psid-stop-own', new Date(t0 - 30 * MIN));
    await pauseAiAfterAgentMessage(t.db, convId, new Date(t0 - 10 * MIN));
    await processInboundMessage(t.db, deps, echo(ch, 'psid-stop-own', 'mid-so-e', new Date(t0 + 2_000)));
    expect(await echoRaw('mid-so-e')).not.toHaveProperty('aiPauseUntil');
    await processInboundMessage(
      t.db,
      deps,
      inbound(ch, 'psid-stop-own', 'mid-so-in', { sentAt: new Date(t0) }),
    );
    expect((await echoRaw('mid-so-e')).automatedEcho).toBe(true);
    expect((await pausedUntil(convId))!.toISOString()).toBe(AI_PAUSED_INDEFINITELY_ISO);
  });

  it("'stop' + nhân viên nhắn sau echo (cùng mốc dừng hẳn) ⇒ gỡ echo tự động KHÔNG gỡ dừng hẳn", async () => {
    const t0 = Date.now() - 2 * MIN;
    const { ch, convId } = await setup('stop', 'psid-stop-staff', new Date(t0 - 30 * MIN));
    await processInboundMessage(t.db, deps, echo(ch, 'psid-stop-staff', 'mid-ss-e', new Date(t0 + 2_000)));
    expect((await echoRaw('mid-ss-e')).aiPauseUntil).toBe(AI_PAUSED_INDEFINITELY_ISO);
    await t.db
      .update(conversations)
      .set({ lastCustomerMessageAt: new Date() })
      .where(eq(conversations.id, convId));
    await send(convId, 'Dạ em đây');
    await processInboundMessage(
      t.db,
      deps,
      inbound(ch, 'psid-stop-staff', 'mid-ss-in', { sentAt: new Date(t0) }),
    );
    expect((await echoRaw('mid-ss-e')).automatedEcho).toBe(true);
    expect((await pausedUntil(convId))!.toISOString()).toBe(AI_PAUSED_INDEFINITELY_ISO);
  });

  it('đồng bộ định kỳ: tin cũ không rút ngắn pause', async () => {
    const { ch, convId } = await setup('pause', 'psid-sync', new Date(Date.now() - 90 * MIN), 10);
    await processInboundMessage(t.db, deps, echo(ch, 'psid-sync', 'mid-sync-new'));
    const paused = (await pausedUntil(convId))!;
    await processInboundMessage(
      t.db,
      deps,
      echo(ch, 'psid-sync', 'mid-sync-old', new Date(Date.now() - 60 * MIN)),
      {
        source: 'sync-incremental',
      },
    );
    expect((await pausedUntil(convId))!.getTime()).toBe(paused.getTime());
    expect(await echoRaw('mid-sync-old')).not.toHaveProperty('aiPauseUntil');
  });
});
