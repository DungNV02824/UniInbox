// Test tích hợp "Nhật ký công trình" trong lượt AI thật (LLM giả): bot xác nhận tiếp nhận ⇒ ghi project_logs gắn tin
// khách (ảnh) + tin bot của lượt; tắt / no_reply / lỗi ⇒ không ghi.
import { chatbots, messages, projectLogs, type ChannelAccount, type Chatbot } from '@dezon/db';
import { DEFAULT_CAPTURE_CONFIG, DEFAULT_PROJECT_LOG_CONFIG, type CaptureConfig } from '@dezon/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LlmResponse } from '../src/ai/llm';
import { processAiReplyJob } from '../src/ai/runtime';
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

const LOG_ON: CaptureConfig = {
  ...DEFAULT_CAPTURE_CONFIG,
  projectLog: { ...DEFAULT_PROJECT_LOG_CONFIG, enabled: true },
};

const ENTRY = {
  dia_chi: '252 Nguyễn Thái Bình',
  nha_thau: 'TVL',
  sdt_nha_thau: '0937549534',
  ngay_chup: '09/11/2026',
};

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
    contactName: 'CTV Hùng',
    chatbotId: bot.id,
    aiMode: 'auto',
    lastCustomerMessageAt: new Date(),
  });
}

function llmCall(name: string, args: Record<string, unknown>): LlmResponse {
  return {
    functionCall: { name, args },
    text: null,
    usage: { inputTokens: 100, outputTokens: 20 },
    model: 'gemini-test',
  };
}

/** Tin chữ (cũ hơn) rồi tin ảnh Timemark — anchor phải là tin ảnh dù không phải tin đầu. */
async function addSubmission(conv: Awaited<ReturnType<typeof botConversation>>) {
  const textId = await addMessage(t.db, conv, {
    text: 'Em gửi bộ ảnh công trình ạ',
    sentAt: new Date(Date.now() - 2000),
  });
  const imageId = await addMessage(t.db, conv, {
    text: null,
    attachments: [{ type: 'image', storage_key: 'media/timemark.jpg', mime: 'image/jpeg' }],
    sentAt: new Date(Date.now() - 1000),
  });
  return { textId, imageId };
}

const logsOf = (conversationId: string) =>
  t.db.select().from(projectLogs).where(eq(projectLogs.conversationId, conversationId));

const botMessageIdsOf = async (conversationId: string) =>
  (
    await t.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.senderType, 'bot')))
      .orderBy(asc(messages.createdAt), asc(messages.id))
  ).map((m) => m.id);

const conversationUpdates = () => kit.publisher.events.filter((e) => e.event === 'conversation.updated');

beforeAll(async () => {
  t = await startTestDb();
  channel = await createChannel(t.db, { displayName: 'Fanpage CTV' });
});

afterAll(async () => {
  await t?.stop();
});

beforeEach(() => {
  kit = createAiKit(ctx);
});

describe('processAiReplyJob — Nhật ký công trình', () => {
  it('bot bật + reply có project_logs ⇒ một dòng: trường theo thứ tự cấu hình, tin khách + bot, anchor = tin ảnh', async () => {
    const bot = await createBot(LOG_ON);
    const conv = await botConversation(bot);
    const { textId, imageId } = await addSubmission(conv);
    kit.llm.impl = async () =>
      llmCall('reply', {
        messages: ['Dạ bên em tiếp nhận bộ ảnh chụp dự án tại địa chỉ 252 Nguyễn Thái Bình ạ'],
        confidence: 0.9,
        // Thứ tự khóa khác cấu hình + khóa lạ ⇒ lưu theo thứ tự cấu hình, bỏ khóa lạ.
        project_logs: [
          {
            ngay_chup: ENTRY.ngay_chup,
            sdt_nha_thau: ENTRY.sdt_nha_thau,
            la: 'x',
            nha_thau: ENTRY.nha_thau,
            dia_chi: ENTRY.dia_chi,
          },
        ],
      });

    const out = await processAiReplyJob(t.db, kit.deps, conv.id);
    expect(out).toMatchObject({ status: 'done', decision: 'reply' });
    // Prompt + tool của lượt có nhật ký.
    const req = kit.llm.calls[0]!;
    expect(req.systemInstruction).toContain('# Nhật ký công trình');
    expect(JSON.stringify(req.tools.find((x) => x.name === 'reply')!.parameters)).toContain('"project_logs"');

    const logs = await logsOf(conv.id);
    expect(logs).toHaveLength(1);
    const log = logs[0]!;
    expect(log.fields).toEqual([
      { key: 'dia_chi', label: 'Địa chỉ công trình', value: ENTRY.dia_chi },
      { key: 'nha_thau', label: 'Nhà thầu', value: ENTRY.nha_thau },
      { key: 'sdt_nha_thau', label: 'SĐT nhà thầu', value: ENTRY.sdt_nha_thau },
      { key: 'ngay_chup', label: 'Ngày chụp', value: ENTRY.ngay_chup },
    ]);
    const botIds = await botMessageIdsOf(conv.id);
    expect(botIds).toHaveLength(1);
    expect(log.messageIds).toEqual([textId, imageId, ...botIds]);
    expect(log.anchorMessageId).toBe(imageId);
    expect(log.chatbotId).toBe(bot.id);
    expect(log.aiRunId).toBe(out.aiRunId);
    expect(conversationUpdates().length).toBeGreaterThanOrEqual(1);
  });

  it('escalate có messages_to_customer + project_logs ⇒ ghi, tin bot là tin gửi lúc chuyển', async () => {
    const bot = await createBot(LOG_ON);
    const conv = await botConversation(bot);
    const { textId, imageId } = await addSubmission(conv);
    kit.llm.impl = async () =>
      llmCall('escalate', {
        reason_code: 'human_request',
        summary_for_agent: 'CTV gửi bộ ảnh công trình',
        messages_to_customer: ['Dạ em đã chuyển hồ sơ cho bộ phận duyệt ạ'],
        project_logs: [{ dia_chi: ENTRY.dia_chi }],
      });

    expect(await processAiReplyJob(t.db, kit.deps, conv.id)).toMatchObject({
      status: 'done',
      decision: 'escalate',
    });
    const logs = await logsOf(conv.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.fields).toEqual([{ key: 'dia_chi', label: 'Địa chỉ công trình', value: ENTRY.dia_chi }]);
    const botIds = await botMessageIdsOf(conv.id);
    expect(botIds).toHaveLength(1);
    expect(logs[0]!.messageIds).toEqual([textId, imageId, ...botIds]);
    expect(logs[0]!.anchorMessageId).toBe(imageId);
  });

  it('bot tắt nhật ký ⇒ tool/prompt không có, không ghi dù model điền', async () => {
    const bot = await createBot(DEFAULT_CAPTURE_CONFIG);
    const conv = await botConversation(bot);
    await addSubmission(conv);
    kit.llm.impl = async () =>
      llmCall('reply', { messages: ['Dạ em tiếp nhận ạ'], confidence: 0.9, project_logs: [ENTRY] });

    expect(await processAiReplyJob(t.db, kit.deps, conv.id)).toMatchObject({
      status: 'done',
      decision: 'reply',
    });
    expect(kit.llm.calls[0]!.systemInstruction).not.toContain('# Nhật ký công trình');
    expect(JSON.stringify(kit.llm.calls[0]!.tools)).not.toContain('project_logs');
    expect(await logsOf(conv.id)).toHaveLength(0);
    expect(conversationUpdates()).toHaveLength(0);
  });

  it('no_reply ⇒ không ghi', async () => {
    const bot = await createBot(LOG_ON);
    const conv = await botConversation(bot);
    await addSubmission(conv);
    kit.llm.impl = async () => llmCall('no_reply', { reason: 'chưa đủ', project_logs: [ENTRY] });

    expect(await processAiReplyJob(t.db, kit.deps, conv.id)).toMatchObject({
      status: 'done',
      decision: 'no_reply',
    });
    expect(await logsOf(conv.id)).toHaveLength(0);
  });

  it('lượt lỗi AI ⇒ không ghi', async () => {
    const bot = await createBot(LOG_ON);
    const conv = await botConversation(bot);
    await addSubmission(conv);
    kit.llm.impl = async () => llmCall('khong_co', { project_logs: [ENTRY] });

    expect(await processAiReplyJob(t.db, kit.deps, conv.id)).toMatchObject({
      status: 'done',
      decision: 'error',
    });
    expect(await logsOf(conv.id)).toHaveLength(0);
  });
});
