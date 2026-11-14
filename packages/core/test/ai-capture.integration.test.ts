// Test tích hợp "Thu thập thông tin" của bot: lượt AI thật (LLM giả) ghi SĐT / Nhu cầu vào hồ sơ khách, gắn nhãn.
import { chatbots, contacts, contactTags, type ChannelAccount, type Chatbot } from '@dezon/db';
import { DEFAULT_CAPTURE_CONFIG, type CaptureConfig } from '@dezon/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LlmResponse } from '../src/ai/llm';
import { processAiReplyJob, turnCapturedInfo } from '../src/ai/runtime';
import { loadSummary } from '../src/inbox/read-model';
import { createAiKit, type AiTestKit } from './helpers/ai-fakes';
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

const CAPTURE_ON: CaptureConfig = { ...DEFAULT_CAPTURE_CONFIG, enabled: true };

async function createBot(capture: CaptureConfig | null): Promise<Chatbot> {
  const [bot] = await t.db
    .insert(chatbots)
    .values({ name: `Bot ${Math.random().toString(36).slice(2, 8)}`, capture })
    .returning();
  return bot!;
}

async function botConversation(bot: Chatbot) {
  return createConversation(t.db, {
    channel,
    contactName: 'Anh Nam',
    chatbotId: bot.id,
    aiMode: 'auto',
    lastCustomerMessageAt: new Date(),
  });
}

const contactOf = async (contactId: string) =>
  (await t.db.select().from(contacts).where(eq(contacts.id, contactId)))[0]!;

function llmCall(name: string, args: Record<string, unknown>): LlmResponse {
  return {
    functionCall: { name, args },
    text: null,
    usage: { inputTokens: 100, outputTokens: 20 },
    model: 'gemini-test',
  };
}

const conversationUpdates = () => kit.publisher.events.filter((e) => e.event === 'conversation.updated');

beforeAll(async () => {
  t = await startTestDb();
  channel = await createChannel(t.db, { displayName: 'Fanpage Xây Dựng' });
  await t.db.insert(contactTags).values({ name: 'Tiềm năng', color: 'green' });
});

afterAll(async () => {
  await t?.stop();
});

beforeEach(() => {
  kit = createAiKit(ctx);
});

describe('processAiReplyJob — Thu thập thông tin', () => {
  it('bot bật: SĐT (chuẩn hóa) + Nhu cầu vào hồ sơ, source ai, gắn "Tiềm năng", phát conversation.updated', async () => {
    const bot = await createBot(CAPTURE_ON);
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'Em muốn xây nhà 2 tầng, sđt 0912 345 678', sentAt: new Date() });
    kit.llm.impl = async () =>
      llmCall('reply', {
        messages: ['Dạ em ghi nhận ạ'],
        confidence: 0.9,
        captured: { phone: '0912 345 678', need: 'Xây nhà 2 tầng', la: 'bỏ' },
      });

    expect(await processAiReplyJob(t.db, kit.deps, conv.id)).toMatchObject({
      status: 'done',
      decision: 'reply',
    });
    // Tool của lượt có `captured`; prompt có mục "Thu thập thông tin".
    const req = kit.llm.calls[0]!;
    expect(req.systemInstruction).toContain('# Thu thập thông tin');
    expect(JSON.stringify(req.tools.find((x) => x.name === 'reply')!.parameters)).toContain('"captured"');

    const c = await contactOf(conv.contactId);
    expect(c.phone).toBe('0912345678');
    expect(c.phoneSource).toBe('ai');
    expect(c.profileFields.need).toMatchObject({ value: 'Xây nhà 2 tầng', source: 'ai', label: 'Nhu cầu' });
    expect(Object.keys(c.profileFields)).toEqual(['need']);
    expect(c.tags).toContain('Tiềm năng');
    expect(conversationUpdates().length).toBeGreaterThanOrEqual(1);
  });

  it('bot tắt (capture null) ⇒ không ghi gì, kể cả SĐT trong tin khách', async () => {
    const bot = await createBot(null);
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'Số em 0912345678', sentAt: new Date() });
    kit.llm.impl = async () =>
      llmCall('reply', { messages: ['Dạ'], confidence: 0.9, captured: { phone: '0912345678', need: 'x' } });

    expect(await processAiReplyJob(t.db, kit.deps, conv.id)).toMatchObject({
      status: 'done',
      decision: 'reply',
    });
    expect(kit.llm.calls[0]!.systemInstruction).not.toContain('# Thu thập thông tin');
    const c = await contactOf(conv.contactId);
    expect(c.phone).toBeNull();
    expect(c.phoneSource).toBeNull();
    expect(c.profileFields).toEqual({});
    expect(c.tags).toEqual([]);
    expect(conversationUpdates()).toHaveLength(0);
  });

  it('Nhu cầu nhân viên đã sửa (source user) không bị ghi đè; SĐT vẫn ghi', async () => {
    const bot = await createBot(CAPTURE_ON);
    const conv = await botConversation(bot);
    const staffNeed = {
      label: 'Nhu cầu',
      value: 'Sửa mái tôn',
      source: 'user' as const,
      updatedAt: '2026-11-01T00:00:00Z',
    };
    await t.db
      .update(contacts)
      .set({ profileFields: { need: staffNeed } })
      .where(eq(contacts.id, conv.contactId));
    await addMessage(t.db, conv, { text: 'Gọi em số 0987654321 nhé', sentAt: new Date() });
    kit.llm.impl = async () =>
      llmCall('escalate', {
        reason_code: 'human_request',
        summary_for_agent: 'Khách cần tư vấn',
        captured: { phone: '0987654321', need: 'Xây nhà mới' },
      });

    expect(await processAiReplyJob(t.db, kit.deps, conv.id)).toMatchObject({
      status: 'done',
      decision: 'escalate',
    });
    const c = await contactOf(conv.contactId);
    expect(c.profileFields.need).toEqual(staffNeed);
    expect(c.phone).toBe('0987654321');
    expect(c.phoneSource).toBe('ai');
  });

  it('model không điền captured ⇒ lấy SĐT CUỐI trong tin khách của lượt (regex), không gắn nhãn', async () => {
    const bot = await createBot(CAPTURE_ON);
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'Số cũ 0912.111.222', sentAt: new Date(Date.now() - 2000) });
    await addMessage(t.db, conv, {
      text: 'À nhầm, số em là +84 987 654 321',
      sentAt: new Date(Date.now() - 1000),
    });
    kit.llm.impl = async () => llmCall('no_reply', { reason: 'đã đủ' });

    expect(await processAiReplyJob(t.db, kit.deps, conv.id)).toMatchObject({
      status: 'done',
      decision: 'no_reply',
    });
    const c = await contactOf(conv.contactId);
    expect(c.phone).toBe('0987654321');
    expect(c.phoneSource).toBe('ai');
    expect(c.profileFields).toEqual({});
    // SĐT đoán (regex) ⇒ không tự gắn nhãn.
    expect(c.tags).not.toContain('Tiềm năng');
  });

  it('model điền captured mà bỏ phone (số của người khác) ⇒ không lấy SĐT trong tin', async () => {
    const bot = await createBot(CAPTURE_ON);
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, {
      text: 'Shipper gọi em số 0987654321 mà em không nghe được, em cần sơn nhà',
      sentAt: new Date(),
    });
    kit.llm.impl = async () =>
      llmCall('reply', { messages: ['Dạ'], confidence: 0.9, captured: { need: 'Sơn nhà' } });

    expect(await processAiReplyJob(t.db, kit.deps, conv.id)).toMatchObject({
      status: 'done',
      decision: 'reply',
    });
    const c = await contactOf(conv.contactId);
    expect(c.phone).toBeNull();
    expect(c.profileFields.need).toMatchObject({ value: 'Sơn nhà', source: 'ai' });
    expect(c.tags).toEqual([]);
  });

  it('lượt lỗi AI ⇒ không thu thập', async () => {
    const bot = await createBot(CAPTURE_ON);
    const conv = await botConversation(bot);
    await addMessage(t.db, conv, { text: 'Số em 0912345678', sentAt: new Date() });
    kit.llm.impl = async () => llmCall('khong_co', {});

    expect(await processAiReplyJob(t.db, kit.deps, conv.id)).toMatchObject({
      status: 'done',
      decision: 'error',
    });
    expect((await contactOf(conv.contactId)).phone).toBeNull();
  });
});

describe('loadSummary — chatbot.captureFields', () => {
  it('bot bật thu thập ⇒ kèm trường đang bật (key, label, theo thứ tự); tắt / chưa cấu hình ⇒ không kèm', async () => {
    const custom = await createBot({
      ...CAPTURE_ON,
      fields: [
        ...CAPTURE_ON.fields.map((f) => (f.key === 'need' ? { ...f, enabled: false } : f)),
        { key: 'khu_vuc', label: 'Khu vực', hint: 'Quận/huyện', enabled: true },
      ],
    });
    const on = await loadSummary(t.db, (await botConversation(custom)).id, ctx);
    expect(on!.chatbot).toEqual({
      id: custom.id,
      name: custom.name,
      captureFields: [
        { key: 'phone', label: 'SĐT' },
        { key: 'khu_vuc', label: 'Khu vực' },
      ],
    });

    const off = await createBot({ ...CAPTURE_ON, enabled: false });
    expect((await loadSummary(t.db, (await botConversation(off)).id, ctx))!.chatbot).toEqual({
      id: off.id,
      name: off.name,
    });
    const legacy = await createBot(null);
    expect((await loadSummary(t.db, (await botConversation(legacy)).id, ctx))!.chatbot).toEqual({
      id: legacy.id,
      name: legacy.name,
    });
  });
});

describe('turnCapturedInfo', () => {
  it('SĐT model hợp lệ thắng; sai ⇒ dự phòng regex; trường phone tắt ⇒ không lấy SĐT', () => {
    expect(turnCapturedInfo(CAPTURE_ON, { phone: '0912345678' }, ['0987654321'])).toEqual({
      phone: '0912345678',
      fields: {},
    });
    expect(turnCapturedInfo(CAPTURE_ON, { phone: 'không rõ', need: 'Sơn' }, ['0987654321'])).toEqual({
      phone: '0987654321',
      phoneGuessed: true,
      fields: { need: 'Sơn' },
    });
    // Model điền captured mà bỏ phone ⇒ không dự phòng.
    expect(turnCapturedInfo(CAPTURE_ON, { need: 'Sơn' }, ['0987654321'])).toEqual({
      phone: null,
      fields: { need: 'Sơn' },
    });
    const phoneOff: CaptureConfig = {
      ...CAPTURE_ON,
      fields: CAPTURE_ON.fields.map((f) => (f.key === 'phone' ? { ...f, enabled: false } : f)),
    };
    expect(turnCapturedInfo(phoneOff, { phone: '0912345678' }, ['0987654321'])).toBeNull();
    expect(turnCapturedInfo(DEFAULT_CAPTURE_CONFIG, { need: 'x' }, ['0987654321'])).toBeNull();
    expect(turnCapturedInfo(CAPTURE_ON, undefined, [null, 'chào shop'])).toBeNull();
  });
});
