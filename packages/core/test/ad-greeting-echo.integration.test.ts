// Test tích hợp echo lời chào quảng cáo Click-to-Messenger (2026-11-12): Meta gửi echo "<Tên> đã trả lời một quảng
// cáo." + lời chào của quảng cáo với sent_at TRƯỚC/BẰNG tin khách nhưng webhook tới SAU ⇒ không được coi là nhân viên
// (không pause, không cắt tin chưa xử lý, không hủy lượt bot). Kèm repair một lần cho hội thoại đã bị kẹt.
import { aiRuns, chatbots, conversations, messages, type ChannelAccount } from '@dezon/db';
import {
  AI_PAUSED_INDEFINITELY_ISO,
  type AgentReplyMode,
  type NormalizedInboundMessage,
} from '@dezon/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processAiReplyJob } from '../src/ai/runtime';
import { loadPendingMessages } from '../src/ai/turn-input';
import {
  AD_GREETING_ECHO_WINDOW_SEC,
  AD_GREETING_REPAIR_BEFORE,
  AD_GREETING_REPAIR_DAYS,
  repairAdGreetingEchoes,
} from '../src/pipeline/automation-echo';
import { processInboundMessage } from '../src/pipeline/inbound';
import type { PipelineDeps } from '../src/pipeline/types';
import {
  createAiKit,
  createRecordingPublisher,
  fakeCipher,
  llmReply,
  silentLogger,
  type AiTestKit,
} from './helpers/ai-fakes';
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
let kit: AiTestKit;
const ctx = makeCtx();
const SEC = 1000;
const MIN = 60 * SEC;
const BUSINESS_SUITE_APP_ID = 263902037430900;
let seq = 0;

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

beforeAll(async () => {
  t = await startTestDb();
});

afterAll(async () => {
  await t?.stop();
});

beforeEach(() => {
  kit = createAiKit(ctx);
});

/** Kênh có bot mặc định (hội thoại mới tự gắn bot, ai_mode auto). */
async function setupChannel(mode: AgentReplyMode = 'pause') {
  const [bot] = await t.db
    .insert(chatbots)
    .values({ name: `Bot ads ${++seq}`, agentReplyMode: mode, agentPauseMinutes: 30, replyDelaySec: 0 })
    .returning();
  const channel = await createChannel(t.db, { defaultChatbotId: bot!.id });
  return { bot: bot!, channel };
}

const customer = (
  ch: ChannelAccount,
  psid: string,
  mid: string,
  sentAt: Date,
  extra: Partial<NormalizedInboundMessage> = {},
): NormalizedInboundMessage => ({
  channelAccountId: ch.id,
  channelType: 'messenger',
  externalUserId: psid,
  externalMessageId: mid,
  direction: 'in',
  senderType: 'customer',
  text: 'Tôi muốn đăng kí CTV',
  attachments: [],
  sentAt,
  raw: { mid },
  ...extra,
});

/** raw của tin khách từ quảng cáo đúng như parse.ts giữ (event gốc: message.referral.source = ADS). */
const adEventRaw = (mid: string) => ({
  message: {
    mid,
    text: 'Tôi muốn đăng kí CTV',
    quick_reply: { payload: 'CTV' },
    referral: { source: 'ADS', type: 'OPEN_THREAD', ad_id: '120200000000' },
  },
  pageId: 'page-1',
});

/** Tin khách đầu tiên từ quảng cáo (quick reply mang referral ADS). */
const adCustomer = (ch: ChannelAccount, psid: string, mid: string, sentAt: Date) =>
  customer(ch, psid, mid, sentAt, {
    referral: { source: 'ADS', adId: '120200000000' },
    raw: adEventRaw(mid),
  });

/** Echo từ Business Suite (không phải app hệ thống). */
const echo = (ch: ChannelAccount, psid: string, mid: string, sentAt: Date, text: string) =>
  customer(ch, psid, mid, sentAt, {
    direction: 'out',
    senderType: 'agent',
    text,
    raw: { message: { mid, is_echo: true, app_id: BUSINESS_SUITE_APP_ID } },
  });

const NOTICE = 'Hiếu đã trả lời một quảng cáo.';
const GREETING = 'Chào Hiếu, bạn có muốn trở thành cộng tác viên của Dezon không?';

const rawOf = async (mid: string) =>
  (await t.db.select().from(messages).where(eq(messages.externalMessageId, mid)))[0]!.raw as {
    automatedEcho?: boolean;
    aiPauseUntil?: string;
  } | null;

const convOf = async (id: string) =>
  (await t.db.select().from(conversations).where(eq(conversations.id, id)))[0]!;

const pendingIds = async (conversationId: string) =>
  (await loadPendingMessages(t.db, conversationId)).map((m) => m.id);

const messageId = async (mid: string) =>
  (await t.db.select().from(messages).where(eq(messages.externalMessageId, mid)))[0]!.id;

describe('echo lời chào quảng cáo đến SAU tin khách (sent_at sớm hơn)', () => {
  it('đánh dấu tự động, không pause, tin khách vẫn chờ, bot trả lời', async () => {
    const { channel } = await setupChannel('pause');
    const t0 = new Date(Date.now() - 10 * SEC);
    const r = await processInboundMessage(t.db, deps, adCustomer(channel, 'psid-a1', 'a1-in', t0));
    const convId = r.conversation!.id;
    expect((await convOf(convId)).windowSource).toBe('ads');

    // Meta: sent_at của echo TRƯỚC tin khách (vài trăm ms) nhưng webhook tới sau.
    const before = (ms: number) => new Date(t0.getTime() - ms);
    await processInboundMessage(t.db, deps, echo(channel, 'psid-a1', 'a1-notice', before(600), NOTICE));
    await processInboundMessage(t.db, deps, echo(channel, 'psid-a1', 'a1-greet', before(300), GREETING));

    expect((await rawOf('a1-notice'))?.automatedEcho).toBe(true);
    expect((await rawOf('a1-greet'))?.automatedEcho).toBe(true);
    expect(await rawOf('a1-greet')).not.toHaveProperty('aiPauseUntil');
    expect((await convOf(convId)).aiPausedUntil).toBeNull();
    expect(await pendingIds(convId)).toEqual([await messageId('a1-in')]);

    kit.llm.impl = async () => llmReply(['Dạ chào bạn, mình gửi thông tin CTV ạ']);
    const out = await processAiReplyJob(t.db, kit.deps, convId);
    expect(out).toMatchObject({ status: 'done', decision: 'reply' });
    expect(kit.scheduler.outbound).toHaveLength(1);
  });

  it('echo tới trong lúc lượt bot đang chạy (chống đua) ⇒ lượt KHÔNG bị hủy "Nhân viên vừa nhắn"', async () => {
    const { channel } = await setupChannel('stop');
    const t0 = new Date(Date.now() - 5 * SEC);
    const r = await processInboundMessage(t.db, deps, adCustomer(channel, 'psid-a2', 'a2-in', t0));
    const convId = r.conversation!.id;

    kit.llm.impl = async () => {
      // Webhook echo tới khi Gemini đang soạn (đúng như log production 10:38:14).
      const before = (ms: number) => new Date(t0.getTime() - ms);
      await processInboundMessage(t.db, deps, echo(channel, 'psid-a2', 'a2-notice', before(500), NOTICE));
      await processInboundMessage(t.db, deps, echo(channel, 'psid-a2', 'a2-greet', before(200), GREETING));
      return llmReply(['Dạ mình gửi bạn thông tin CTV ạ']);
    };
    const out = await processAiReplyJob(t.db, kit.deps, convId);
    expect(out).toMatchObject({ status: 'done', decision: 'reply' });
    expect((await convOf(convId)).aiPausedUntil).toBeNull();
    const runs = await t.db.select().from(aiRuns).where(eq(aiRuns.conversationId, convId));
    expect(runs.map((run) => run.error)).toEqual([null]);
  });

  it('echo gửi > 60 giây trước tin khách ở hội thoại quảng cáo ⇒ vẫn là nhân viên', async () => {
    const { channel } = await setupChannel('pause');
    const t0 = new Date(Date.now() - 5 * SEC);
    const r = await processInboundMessage(t.db, deps, adCustomer(channel, 'psid-a3', 'a3-in', t0));
    const convId = r.conversation!.id;
    const early = new Date(t0.getTime() - (AD_GREETING_ECHO_WINDOW_SEC + 30) * SEC);
    await processInboundMessage(t.db, deps, echo(channel, 'psid-a3', 'a3-staff', early, 'Dạ chị cần gì ạ'));
    expect(await rawOf('a3-staff')).not.toHaveProperty('automatedEcho');
    expect((await convOf(convId)).aiPausedUntil).not.toBeNull();
  });
});

describe('echo lời chào quảng cáo được lưu TRƯỚC tin khách', () => {
  it('tin khách (referral ADS) đến sau ⇒ đánh dấu lại echo, gỡ "dừng hẳn", bot trả lời', async () => {
    const { channel } = await setupChannel('stop');
    const t0 = new Date(Date.now() - 10 * SEC);
    const first = await processInboundMessage(
      t.db,
      deps,
      echo(channel, 'psid-b1', 'b1-greet', new Date(t0.getTime() - 2 * SEC), GREETING),
    );
    const convId = first.conversation!.id;
    expect(await rawOf('b1-greet')).not.toHaveProperty('automatedEcho');
    expect((await convOf(convId)).aiPausedUntil?.toISOString()).toBe(AI_PAUSED_INDEFINITELY_ISO);

    await processInboundMessage(t.db, deps, adCustomer(channel, 'psid-b1', 'b1-in', t0));
    expect((await rawOf('b1-greet'))?.automatedEcho).toBe(true);
    const conv = await convOf(convId);
    expect(conv.windowSource).toBe('ads');
    expect(conv.aiPausedUntil).toBeNull();
    expect(await pendingIds(convId)).toEqual([await messageId('b1-in')]);
    expect(await processAiReplyJob(t.db, kit.deps, convId)).toMatchObject({
      status: 'done',
      decision: 'reply',
    });
  });

  it('hội thoại cũ (organic, referral không kèm tin) nhưng có echo "… đã trả lời một quảng cáo." ⇒ tự động', async () => {
    const { channel } = await setupChannel('pause');
    const old = await processInboundMessage(
      t.db,
      deps,
      customer(channel, 'psid-b2', 'b2-old', new Date(Date.now() - 3 * 60 * MIN)),
    );
    const convId = old.conversation!.id;
    const t0 = new Date(Date.now() - 10 * SEC);
    await processInboundMessage(t.db, deps, echo(channel, 'psid-b2', 'b2-notice', t0, NOTICE));
    await processInboundMessage(t.db, deps, echo(channel, 'psid-b2', 'b2-greet', t0, GREETING));
    expect((await convOf(convId)).aiPausedUntil).not.toBeNull();
    await processInboundMessage(t.db, deps, customer(channel, 'psid-b2', 'b2-in', t0));
    expect((await convOf(convId)).windowSource).toBe('organic');
    expect((await rawOf('b2-notice'))?.automatedEcho).toBe(true);
    expect((await rawOf('b2-greet'))?.automatedEcho).toBe(true);
    expect((await convOf(convId)).aiPausedUntil).toBeNull();
    expect(await pendingIds(convId)).toContain(await messageId('b2-in'));
  });

  it('echo và tin khách xử lý song song ⇒ vẫn phân loại đúng (khóa theo hội thoại)', async () => {
    const { channel } = await setupChannel('stop');
    for (let i = 0; i < 5; i++) {
      // Hội thoại có sẵn (tin cũ 3 giờ trước) để hai job không đua tạo hội thoại.
      const psid = `psid-b3-${i}`;
      const old = await processInboundMessage(
        t.db,
        deps,
        customer(channel, psid, `b3-old-${i}`, new Date(Date.now() - 3 * 60 * MIN)),
      );
      const convId = old.conversation!.id;
      const at = new Date(Date.now() - 10 * SEC);
      await Promise.all([
        processInboundMessage(t.db, deps, adCustomer(channel, psid, `b3-in-${i}`, at)),
        processInboundMessage(
          t.db,
          deps,
          echo(channel, psid, `b3-greet-${i}`, new Date(at.getTime() - 300), GREETING),
        ),
      ]);
      expect((await rawOf(`b3-greet-${i}`))?.automatedEcho).toBe(true);
      expect((await convOf(convId)).aiPausedUntil).toBeNull();
    }
  });

  it('echo thông báo "… đã trả lời một quảng cáo." tới SAU CÙNG ⇒ đánh dấu lại lời chào, gỡ pause, hẹn lại bot', async () => {
    const { channel } = await setupChannel('stop');
    const scheduled: string[] = [];
    const hooked: PipelineDeps = {
      ...deps,
      onCustomerMessageStored: async ({ conversationId }) => {
        scheduled.push(conversationId);
      },
    };
    // Khách đã có hội thoại cũ ⇒ Meta gửi referral bằng messaging_referrals đứng riêng: tin khách KHÔNG mang referral.
    const old = await processInboundMessage(
      t.db,
      hooked,
      customer(channel, 'psid-b4', 'b4-old', new Date(Date.now() - 3 * 60 * MIN)),
    );
    const convId = old.conversation!.id;
    const t0 = new Date(Date.now() - 10 * SEC);
    await processInboundMessage(t.db, hooked, customer(channel, 'psid-b4', 'b4-in', t0));
    await processInboundMessage(
      t.db,
      hooked,
      echo(channel, 'psid-b4', 'b4-greet', new Date(t0.getTime() - 400), GREETING),
    );
    // Chưa có thông báo ⇒ lời chào tạm bị coi là nhân viên.
    expect(await rawOf('b4-greet')).not.toHaveProperty('automatedEcho');
    expect((await convOf(convId)).aiPausedUntil?.toISOString()).toBe(AI_PAUSED_INDEFINITELY_ISO);
    scheduled.length = 0;

    await processInboundMessage(
      t.db,
      hooked,
      echo(channel, 'psid-b4', 'b4-notice', new Date(t0.getTime() - 600), NOTICE),
    );
    expect((await rawOf('b4-notice'))?.automatedEcho).toBe(true);
    expect((await rawOf('b4-greet'))?.automatedEcho).toBe(true);
    expect((await convOf(convId)).aiPausedUntil).toBeNull();
    expect(await pendingIds(convId)).toContain(await messageId('b4-in'));
    expect(scheduled).toEqual([convId]);
  });
});

describe('hội thoại không phải quảng cáo: giữ nguyên', () => {
  it('echo nhân viên thật gửi trước tin khách (lưu sau) ⇒ vẫn pause, tin khách coi như nhân viên đã lo', async () => {
    const { channel } = await setupChannel('pause');
    const t0 = new Date(Date.now() - 10 * SEC);
    const r = await processInboundMessage(t.db, deps, customer(channel, 'psid-c1', 'c1-in', t0));
    const convId = r.conversation!.id;
    expect((await convOf(convId)).windowSource).toBe('organic');
    await processInboundMessage(
      t.db,
      deps,
      echo(channel, 'psid-c1', 'c1-staff', new Date(t0.getTime() - 5 * SEC), 'Dạ shop gửi bảng giá ạ'),
    );
    expect(await rawOf('c1-staff')).not.toHaveProperty('automatedEcho');
    expect((await convOf(convId)).aiPausedUntil).not.toBeNull();
    expect(await pendingIds(convId)).toEqual([]);
  });

  it('hội thoại quảng cáo (window_source ads), "dừng hẳn": nhân viên nhắn từ Business Suite, khách trả lời 30 giây sau (không referral) ⇒ bot vẫn dừng', async () => {
    const { channel } = await setupChannel('stop');
    // Khách vào từ quảng cáo từ trước ⇒ hội thoại giữ window_source 'ads'.
    const entry = await processInboundMessage(
      t.db,
      deps,
      adCustomer(channel, 'psid-c3', 'c3-entry', new Date(Date.now() - 2 * 60 * MIN)),
    );
    const convId = entry.conversation!.id;
    expect((await convOf(convId)).windowSource).toBe('ads');
    const staffAt = new Date(Date.now() - 60 * SEC);
    await processInboundMessage(
      t.db,
      deps,
      echo(channel, 'psid-c3', 'c3-staff', staffAt, 'Dạ em gửi chị hồ sơ CTV ạ'),
    );
    expect((await convOf(convId)).aiPausedUntil?.toISOString()).toBe(AI_PAUSED_INDEFINITELY_ISO);

    await processInboundMessage(
      t.db,
      deps,
      customer(channel, 'psid-c3', 'c3-in', new Date(staffAt.getTime() + 30 * SEC), { text: 'ok cảm ơn' }),
    );
    expect(await rawOf('c3-staff')).not.toHaveProperty('automatedEcho');
    expect((await convOf(convId)).aiPausedUntil?.toISOString()).toBe(AI_PAUSED_INDEFINITELY_ISO);
    expect(await pendingIds(convId)).not.toContain(await messageId('c3-entry'));
  });

  it('hội thoại quảng cáo: tin khách (không referral) lưu TRƯỚC, echo nhân viên gửi 30 giây trước đó tới sau ⇒ vẫn là nhân viên', async () => {
    const { channel } = await setupChannel('stop');
    const entry = await processInboundMessage(
      t.db,
      deps,
      adCustomer(channel, 'psid-c4', 'c4-entry', new Date(Date.now() - 2 * 60 * MIN)),
    );
    const convId = entry.conversation!.id;
    const staffAt = new Date(Date.now() - 60 * SEC);
    await processInboundMessage(
      t.db,
      deps,
      customer(channel, 'psid-c4', 'c4-in', new Date(staffAt.getTime() + 30 * SEC), { text: 'ok cảm ơn' }),
    );
    await processInboundMessage(
      t.db,
      deps,
      echo(channel, 'psid-c4', 'c4-staff', staffAt, 'Dạ em gửi chị hồ sơ CTV ạ'),
    );
    expect(await rawOf('c4-staff')).not.toHaveProperty('automatedEcho');
    expect((await convOf(convId)).aiPausedUntil?.toISOString()).toBe(AI_PAUSED_INDEFINITELY_ISO);
  });

  it('echo lưu trước, tin khách (không referral) sau ⇒ không đánh dấu lại', async () => {
    const { channel } = await setupChannel('pause');
    const old = await processInboundMessage(
      t.db,
      deps,
      customer(channel, 'psid-c2', 'c2-old', new Date(Date.now() - 3 * 60 * MIN)),
    );
    const convId = old.conversation!.id;
    const t0 = new Date(Date.now() - 10 * SEC);
    await processInboundMessage(
      t.db,
      deps,
      echo(channel, 'psid-c2', 'c2-staff', new Date(t0.getTime() - 3 * SEC), 'Dạ shop đây ạ'),
    );
    await processInboundMessage(t.db, deps, customer(channel, 'psid-c2', 'c2-in', t0));
    expect(await rawOf('c2-staff')).not.toHaveProperty('automatedEcho');
    expect((await convOf(convId)).aiPausedUntil).not.toBeNull();
  });
});

describe('repairAdGreetingEchoes (sửa một lần hội thoại đã kẹt)', () => {
  /** Trạng thái kẹt như production trước bản sửa: echo lưu SAU tin khách, bị coi là nhân viên, đặt "dừng hẳn". */
  async function stuck(
    windowSource: 'ads' | 'organic',
    echoOffsetSec: number,
    text = GREETING,
    fromAds = windowSource === 'ads',
  ) {
    const { bot, channel } = await setupChannel('stop');
    const conv = await createConversation(t.db, {
      channel,
      chatbotId: bot.id,
      aiMode: 'auto',
      windowSource,
      lastCustomerMessageAt: new Date(),
      aiPausedUntil: new Date(AI_PAUSED_INDEFINITELY_ISO),
    });
    const t0 = new Date(Date.now() - 30 * MIN);
    const customerId = await addMessage(t.db, conv, {
      text: 'Tôi muốn đăng kí CTV',
      sentAt: t0,
      raw: fromAds ? adEventRaw('stuck-in') : { message: { mid: 'stuck-in' } },
    });
    const echoId = await addMessage(t.db, conv, {
      senderType: 'agent',
      status: 'sent',
      text,
      sentAt: new Date(t0.getTime() - echoOffsetSec * SEC),
      raw: {
        message: { is_echo: true, app_id: BUSINESS_SUITE_APP_ID },
        aiPauseUntil: AI_PAUSED_INDEFINITELY_ISO,
      },
    });
    return { conv, customerId, echoId };
  }
  /** Mốc cố định của bản sửa ở tương lai gần (test không phụ thuộc ngày chạy). */
  const before = () => new Date(Date.now() + MIN);
  const rawById = async (id: string) =>
    (await t.db.select().from(messages).where(eq(messages.id, id)))[0]!.raw as { automatedEcho?: boolean };

  it('chỉ sửa hội thoại quảng cáo, gỡ pause echo đặt, idempotent, không gửi/lên lịch gì', async () => {
    const ads = await stuck('ads', 0);
    const organic = await stuck('organic', 0);
    const tooEarly = await stuck('ads', AD_GREETING_ECHO_WINDOW_SEC + 30);
    const notice = await stuck('organic', 1, NOTICE);
    expect(await pendingIds(ads.conv.id)).toEqual([]);

    const first = await repairAdGreetingEchoes(t.db, { before: before() });
    expect(first.echoes).toBeGreaterThanOrEqual(2);
    expect((await rawById(ads.echoId)).automatedEcho).toBe(true);
    expect((await rawById(notice.echoId)).automatedEcho).toBe(true);
    expect((await rawById(organic.echoId)).automatedEcho).toBeUndefined();
    expect((await rawById(tooEarly.echoId)).automatedEcho).toBeUndefined();

    expect((await convOf(ads.conv.id)).aiPausedUntil).toBeNull();
    expect((await convOf(notice.conv.id)).aiPausedUntil).toBeNull();
    expect((await convOf(organic.conv.id)).aiPausedUntil?.toISOString()).toBe(AI_PAUSED_INDEFINITELY_ISO);
    expect((await convOf(tooEarly.conv.id)).aiPausedUntil?.toISOString()).toBe(AI_PAUSED_INDEFINITELY_ISO);
    expect(await pendingIds(ads.conv.id)).toEqual([ads.customerId]);
    expect(await pendingIds(organic.conv.id)).toEqual([]);

    expect(await repairAdGreetingEchoes(t.db, { before: before() })).toEqual({
      echoes: 0,
      conversations: 0,
      pausesReleased: 0,
    });
    expect(kit.scheduler.replies).toEqual([]);
    expect(kit.scheduler.outbound).toEqual([]);
  });

  it('nhân viên thật nhắn sau echo ⇒ đánh dấu echo nhưng giữ "dừng hẳn"', async () => {
    const s = await stuck('ads', 0);
    await addMessage(t.db, s.conv, {
      senderType: 'agent',
      status: 'sent',
      text: 'Dạ em là nhân viên ạ',
      sentAt: new Date(Date.now() - 20 * MIN),
      senderUserId: t.agent.id,
    });
    await repairAdGreetingEchoes(t.db, { before: before() });
    expect((await rawById(s.echoId)).automatedEcho).toBe(true);
    expect((await convOf(s.conv.id)).aiPausedUntil?.toISOString()).toBe(AI_PAUSED_INDEFINITELY_ISO);
  });

  it('echo cũ hơn `days` ngày ⇒ không đụng', async () => {
    const s = await stuck('ads', 0);
    const now = new Date(Date.now() + 30 * 24 * 60 * MIN);
    const result = await repairAdGreetingEchoes(t.db, { now, before: new Date(now.getTime() + MIN) });
    expect(result.echoes).toBe(0);
    expect((await rawById(s.echoId)).automatedEcho).toBeUndefined();
  });

  it('hội thoại organic sau này thành ads: echo nhân viên thật (khách trả lời không referral) ⇒ repair không đụng, giữ "dừng hẳn"', async () => {
    const s = await stuck('ads', 30, 'Dạ em gửi chị hồ sơ CTV ạ', false);
    await repairAdGreetingEchoes(t.db, { before: before() });
    expect((await rawById(s.echoId)).automatedEcho).toBeUndefined();
    expect((await convOf(s.conv.id)).aiPausedUntil?.toISOString()).toBe(AI_PAUSED_INDEFINITELY_ISO);
    expect(await pendingIds(s.conv.id)).toEqual([]);
  });

  it('echo gửi từ mốc `before` (sau bản sửa) ⇒ không đụng; mặc định quá mốc cố định + `days` ⇒ không làm gì', async () => {
    const s = await stuck('ads', 0);
    const echoAt = (await t.db.select().from(messages).where(eq(messages.id, s.echoId)))[0]!.sentAt;
    expect(await repairAdGreetingEchoes(t.db, { before: echoAt })).toMatchObject({ echoes: 0 });
    expect((await rawById(s.echoId)).automatedEcho).toBeUndefined();
    const late = new Date(
      AD_GREETING_REPAIR_BEFORE.getTime() + (AD_GREETING_REPAIR_DAYS + 1) * 24 * 60 * MIN,
    );
    expect(await repairAdGreetingEchoes(t.db, { now: late })).toEqual({
      echoes: 0,
      conversations: 0,
      pausesReleased: 0,
    });
  });
});
