// E2E tính năng Chatbot AI phía API: CRUD bot, chạy thử (LLM giả), model, bot/handoff trên hội thoại, cài đặt.
import {
  AI_KICK_JOB_NAME,
  aiKickJobId,
  type LlmClient,
  outboundJobId,
  type LlmRequest,
  type LlmResponse,
} from '@dezon/core';
import {
  aiRuns,
  appSettings,
  contactIdentities,
  contacts,
  conversations,
  createDb,
  type Db,
  handoffs,
  messages,
} from '@dezon/db';
import {
  type AiRunDto,
  type AiSettings,
  type BusinessHours,
  type ChannelAccountDto,
  type ChatbotDto,
  type ChatbotSummary,
  CHATBOT_DEFAULTS,
  CHATBOT_LIMITS,
  type ChatbotTestResult,
  type ConversationSummary,
  DEFAULT_BUSINESS_HOURS,
  HANDOFF_MESSAGE_CONTACT_PLACEHOLDER,
  type LarkSettingsDto,
  type LoginResponse,
  REALTIME_EVENTS,
  ROOM_ADMINS,
  ROOM_UNASSIGNED,
  userRoom,
} from '@dezon/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Queue } from 'bullmq';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.factory';
import { SlidingWindowLimiter } from '../src/common/rate-limiter';
import { AI_REPLY_QUEUE, OUTBOUND_QUEUE } from '../src/infra/queue/queue.constants';
import {
  CHATBOT_TEST_BODY_LIMIT_BYTES,
  CHATBOT_TEST_BODY_TOO_LARGE_MESSAGE,
} from '../src/modules/chatbots/chatbot-test.constants';
import { DELETE_EMIT_LIMIT } from '../src/modules/chatbots/chatbots.service';
import { RealtimeService } from '../src/modules/realtime/realtime.service';
import { type InboxSeed, seedInbox } from './inbox-seed';
import { ADMIN, AGENT, startInfra, type TestInfra } from './test-env';

const RANDOM_ID = '7f1c2a9e-3b4d-4c5e-8f60-112233445566';
const LARK_URL = 'https://open.larksuite.com/open-apis/bot/v2/hook/test-hook';
const LARK_SECRET = 'lark-bi-mat-123';
/** LARK_WEBHOOK_URL của env: chỉ dùng khi admin CHƯA TỪNG lưu cấu hình Lark. */
const ENV_LARK_URL = 'https://open.larksuite.com/open-apis/bot/v2/hook/env-hook';

const replyResponse = (messages: string[], confidence = 0.9): LlmResponse => ({
  functionCall: { name: 'reply', args: { messages, confidence } },
  text: null,
  usage: { inputTokens: 120, outputTokens: 30 },
  model: 'gemini-2.5-flash',
});

/** LLM giả: ghi lại request, trả lời theo `next`. */
const llmRequests: LlmRequest[] = [];
let nextLlmResponse: LlmResponse = replyResponse(['Dạ em chào anh/chị ạ']);
const fakeLlm: LlmClient = {
  generate: async (req) => {
    llmRequests.push(req);
    return nextLlmResponse;
  },
};

/** Liệt kê model giả (điều khiển được từng lần gọi). */
const geminiModels = vi.fn<() => Promise<string[]>>();

/** fetch giả cho webhook Lark. */
let larkReply: { status: number; body: unknown } = { status: 200, body: { code: 0, msg: 'success' } };
const larkCalls: { url: string; body: Record<string, unknown> }[] = [];
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  larkCalls.push({
    url: String(input),
    body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
  });
  return new Response(JSON.stringify(larkReply.body), {
    status: larkReply.status,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

let infra: TestInfra;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;
let seed: InboxSeed;
let outbound: Queue;
let aiReply: Queue;
let realtime: RealtimeService;
let adminToken: string;
let agentToken: string;

beforeAll(async () => {
  infra = await startInfra();
  process.env.LARK_WEBHOOK_URL = ENV_LARK_URL;
  seed = await seedInbox(infra.databaseUrl);
  ({ db, close: closeDb } = createDb(infra.databaseUrl, { max: 2 }));
  app = await createApp(undefined, {
    mediaStorage: null,
    llm: fakeLlm,
    geminiModels,
    fetch: fakeFetch,
  });
  outbound = app.get(OUTBOUND_QUEUE);
  aiReply = app.get(AI_REPLY_QUEUE);
  realtime = app.get(RealtimeService);
  adminToken = await login(ADMIN.email, ADMIN.password);
  agentToken = await login(AGENT.email, AGENT.password);
});

afterEach(async () => {
  vi.restoreAllMocks();
  llmRequests.length = 0;
  larkCalls.length = 0;
  await outbound.obliterate({ force: true });
  await aiReply.obliterate({ force: true });
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  await infra?.stop();
});

async function login(email: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return res.json<LoginResponse>().accessToken;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
const call = (token: string | null, method: Method, url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
const asAdmin = (method: Method, url: string, payload?: unknown) => call(adminToken, method, url, payload);
const asAgent = (method: Method, url: string, payload?: unknown) => call(agentToken, method, url, payload);

async function createBot(payload: Record<string, unknown>): Promise<ChatbotDto> {
  const res = await asAdmin('POST', '/chatbots', payload);
  expect(res.statusCode).toBe(201);
  return res.json<ChatbotDto>();
}

/** Các lần phát conversation.updated (spy lên RealtimeService). */
function spyUpdates() {
  const spy = vi.spyOn(realtime, 'emit');
  return () =>
    spy.mock.calls
      .filter(([, event]) => event === REALTIME_EVENTS.conversationUpdated)
      .map(([rooms, , payload]) => ({
        rooms,
        conversation: (payload as { conversation: ConversationSummary }).conversation,
      }));
}

/** Job "kick" đánh thức chatbot của hội thoại (nếu API đã đẩy). */
const kickJob = (conversationId: string) => aiReply.getJob(aiKickJobId(conversationId));

/** Đưa hội thoại về trạng thái chờ người (như sau escalate): ai_mode off, giữ bot, một handoff mở. */
async function makePendingHuman(conversationId: string, chatbotId: string): Promise<void> {
  await db
    .update(conversations)
    .set({
      chatbotId,
      aiMode: 'off',
      status: 'pending_human',
      handoffReason: 'discount',
      handoffAt: new Date(),
    })
    .where(eq(conversations.id, conversationId));
  await db
    .insert(handoffs)
    .values({ conversationId, reasonCode: 'discount', summary: 'Khách xin giảm', createdBy: 'ai' });
}

const openHandoffsOf = (conversationId: string) =>
  db
    .select()
    .from(handoffs)
    .where(and(eq(handoffs.conversationId, conversationId), isNull(handoffs.resolvedAt)));

async function resetConversation(conversationId: string): Promise<void> {
  await db
    .update(conversations)
    .set({
      chatbotId: null,
      aiMode: 'off',
      status: 'open',
      aiPausedUntil: null,
      handoffReason: null,
      handoffAt: null,
    })
    .where(eq(conversations.id, conversationId));
}

describe('phân quyền', () => {
  const ADMIN_ONLY: [Method, string, unknown?][] = [
    ['GET', `/chatbots/${RANDOM_ID}`],
    ['GET', '/chatbots/models'],
    ['POST', '/chatbots', { name: 'Bot X' }],
    ['PATCH', `/chatbots/${RANDOM_ID}`, { name: 'Bot Y' }],
    ['DELETE', `/chatbots/${RANDOM_ID}`],
    ['POST', `/chatbots/${RANDOM_ID}/test`, { messages: [{ role: 'customer', text: 'Chào' }] }],
    [
      'POST',
      '/chatbots/test-draft',
      { draft: { name: 'Nháp' }, messages: [{ role: 'customer', text: 'Chào' }] },
    ],
    ['GET', `/conversations/${RANDOM_ID}/ai-runs`],
    ['GET', '/settings/business-hours'],
    ['PUT', '/settings/business-hours', DEFAULT_BUSINESS_HOURS],
    ['GET', '/settings/lark'],
    ['PUT', '/settings/lark', { webhookUrl: null }],
    ['POST', '/settings/lark/test'],
    ['GET', '/settings/ai'],
    ['PUT', '/settings/ai', { enabled: false }],
  ];

  it.each(ADMIN_ONLY)('agent gọi %s %s => 403', async (method, url, payload) => {
    expect((await asAgent(method, url, payload)).statusCode).toBe(403);
  });

  const STAFF: [Method, string, unknown?][] = [
    ['GET', '/chatbots'],
    ['PATCH', `/conversations/${RANDOM_ID}/chatbot`, { chatbotId: null }],
    ['POST', `/conversations/${RANDOM_ID}/ai/resume`],
    ['POST', `/conversations/${RANDOM_ID}/handoff/ack`],
    ['POST', `/conversations/${RANDOM_ID}/handoff/resolve`],
    ['POST', `/conversations/${RANDOM_ID}/handoff/reject`, { reason: 'Chưa đạt' }],
    ...ADMIN_ONLY,
  ];

  it.each(STAFF)('chưa đăng nhập gọi %s %s => 401', async (method, url, payload) => {
    expect((await call(null, method, url, payload)).statusCode).toBe(401);
  });
});

describe('CRUD chatbot', () => {
  it('tạo, trùng tên => 409, sửa, xem, agent chỉ thấy bot đang bật, xóa', async () => {
    const bot = await createBot({
      name: 'Tư vấn sofa',
      instructions: 'Xưng em, gọi anh/chị.',
      handoffKeywords: ['gặp quản lý'],
    });
    expect(bot).toMatchObject({
      name: 'Tư vấn sofa',
      isActive: true,
      temperature: 0.4,
      replyDelaySec: 10,
      escalateWhenUnsure: true,
    });

    const dup = await asAdmin('POST', '/chatbots', { name: 'Tư vấn sofa' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json<{ message: string }>().message).toBeTruthy();

    const invalid = await asAdmin('POST', '/chatbots', { name: '' });
    expect(invalid.statusCode).toBe(400);

    const hidden = await createBot({ name: 'Bot đang tắt', isActive: false });

    const adminList = (await asAdmin('GET', '/chatbots')).json<ChatbotSummary[]>();
    expect(adminList.map((b) => b.id)).toEqual(expect.arrayContaining([bot.id, hidden.id]));
    const agentList = await asAgent('GET', '/chatbots');
    expect(agentList.statusCode).toBe(200);
    const agentIds = agentList.json<ChatbotSummary[]>().map((b) => b.id);
    expect(agentIds).toContain(bot.id);
    expect(agentIds).not.toContain(hidden.id);

    const patched = await asAdmin('PATCH', `/chatbots/${bot.id}`, {
      description: 'Bot chính',
      temperature: 0.2,
      escalateWhenUnsure: false,
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<ChatbotDto>()).toMatchObject({
      description: 'Bot chính',
      temperature: 0.2,
      escalateWhenUnsure: false,
    });
    expect((await asAdmin('PATCH', `/chatbots/${bot.id}`, { escalateWhenUnsure: 'khong' })).statusCode).toBe(
      400,
    );

    const renameDup = await asAdmin('PATCH', `/chatbots/${hidden.id}`, { name: 'Tư vấn sofa' });
    expect(renameDup.statusCode).toBe(409);
    expect((await asAdmin('PATCH', `/chatbots/${bot.id}`, {})).statusCode).toBe(400);

    const detail = await asAdmin('GET', `/chatbots/${bot.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json<ChatbotDto>()).toMatchObject({ id: bot.id, handoffKeywords: ['gặp quản lý'] });

    expect((await asAdmin('GET', `/chatbots/${RANDOM_ID}`)).statusCode).toBe(404);
    expect((await asAdmin('GET', '/chatbots/khong-phai-uuid')).statusCode).toBe(400);

    const removed = await asAdmin('DELETE', `/chatbots/${hidden.id}`);
    expect(removed.statusCode).toBe(200);
    expect((await asAdmin('GET', `/chatbots/${hidden.id}`)).statusCode).toBe(404);
    expect((await asAdmin('DELETE', `/chatbots/${hidden.id}`)).statusCode).toBe(404);
  });

  it('responseSpeed: mặc định fast, tạo/sửa/đọc lại, giá trị lạ => 400', async () => {
    const plain = await createBot({ name: 'Bot tốc độ mặc định' });
    expect(plain.responseSpeed).toBe('fast');
    const slow = await createBot({ name: 'Bot suy nghĩ kỹ', responseSpeed: 'thorough' });
    expect(slow.responseSpeed).toBe('thorough');

    const patched = await asAdmin('PATCH', `/chatbots/${slow.id}`, { responseSpeed: 'balanced' });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<ChatbotDto>().responseSpeed).toBe('balanced');
    expect((await asAdmin('GET', `/chatbots/${slow.id}`)).json<ChatbotDto>().responseSpeed).toBe('balanced');

    expect((await asAdmin('PATCH', `/chatbots/${slow.id}`, { responseSpeed: 'turbo' })).statusCode).toBe(400);
    expect((await asAdmin('POST', '/chatbots', { name: 'Bot lạ', responseSpeed: 'turbo' })).statusCode).toBe(
      400,
    );
  });

  it('notifyKeywords / agentReplyMode / agentPauseMinutes / handoffReminderMin: mặc định, tạo, sửa, đọc lại', async () => {
    const plain = await createBot({ name: 'Bot cài đặt mặc định' });
    expect(plain).toMatchObject({
      notifyKeywords: [],
      agentReplyMode: CHATBOT_DEFAULTS.agentReplyMode,
      agentPauseMinutes: null,
      handoffReminderMin: CHATBOT_DEFAULTS.handoffReminderMin,
    });
    expect(plain.agentReplyMode).toBe('pause');
    expect(plain.handoffReminderMin).toBe(0);

    // Trim + bỏ trùng theo dạng không dấu (giữ bản viết đầu tiên) như handoffKeywords.
    const bot = await createBot({
      name: 'Bot báo nhân viên',
      handoffKeywords: ['gặp quản lý'],
      notifyKeywords: ['  bảo hành ', 'BAO HANH', 'đổi trả'],
      agentReplyMode: 'continue',
      agentPauseMinutes: 15,
      handoffReminderMin: 10,
    });
    expect(bot).toMatchObject({
      handoffKeywords: ['gặp quản lý'],
      notifyKeywords: ['bảo hành', 'đổi trả'],
      agentReplyMode: 'continue',
      agentPauseMinutes: 15,
      handoffReminderMin: 10,
    });

    const patched = await asAdmin('PATCH', `/chatbots/${bot.id}`, {
      notifyKeywords: ['giao hàng'],
      agentReplyMode: 'stop',
      agentPauseMinutes: null,
      handoffReminderMin: 0,
    });
    expect(patched.statusCode).toBe(200);
    const expected = {
      handoffKeywords: ['gặp quản lý'],
      notifyKeywords: ['giao hàng'],
      agentReplyMode: 'stop',
      agentPauseMinutes: null,
      handoffReminderMin: 0,
    };
    expect(patched.json<ChatbotDto>()).toMatchObject(expected);
    expect((await asAdmin('GET', `/chatbots/${bot.id}`)).json<ChatbotDto>()).toMatchObject(expected);

    // PATCH trường khác giữ nguyên các cài đặt mới.
    const other = await asAdmin('PATCH', `/chatbots/${bot.id}`, {
      agentPauseMinutes: CHATBOT_LIMITS.agentPauseMinutesMax,
    });
    expect(other.json<ChatbotDto>()).toMatchObject({ ...expected, agentPauseMinutes: 1440 });
  });

  it("aiHandoffMode: mặc định 'stop', tạo/sửa 'continue', đọc lại; giá trị lạ => 400", async () => {
    const plain = await createBot({ name: 'Bot khi AI chuyển mặc định' });
    expect(plain.aiHandoffMode).toBe(CHATBOT_DEFAULTS.aiHandoffMode);
    expect(plain.aiHandoffMode).toBe('stop');
    const bot = await createBot({ name: 'Bot vẫn trả lời', aiHandoffMode: 'continue' });
    expect(bot.aiHandoffMode).toBe('continue');
    const patched = await asAdmin('PATCH', `/chatbots/${plain.id}`, { aiHandoffMode: 'continue' });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<ChatbotDto>().aiHandoffMode).toBe('continue');
    expect((await asAdmin('GET', `/chatbots/${plain.id}`)).json<ChatbotDto>().aiHandoffMode).toBe('continue');
    // PATCH trường khác giữ nguyên.
    const other = await asAdmin('PATCH', `/chatbots/${plain.id}`, { handoffReminderMin: 5 });
    expect(other.json<ChatbotDto>()).toMatchObject({ aiHandoffMode: 'continue', handoffReminderMin: 5 });
    expect((await asAdmin('PATCH', `/chatbots/${plain.id}`, { aiHandoffMode: 'pause' })).statusCode).toBe(
      400,
    );
    expect((await asAdmin('POST', '/chatbots', { name: 'Bot mode lạ', aiHandoffMode: 'x' })).statusCode).toBe(
      400,
    );
    expect((await asAdmin('GET', `/chatbots/${plain.id}`)).json<ChatbotDto>().aiHandoffMode).toBe('continue');
  });

  it('cài đặt mới: giá trị ngoài khoảng / lạ => 400', async () => {
    const bot = await createBot({ name: 'Bot kiểm giới hạn' });
    const BAD: Record<string, unknown>[] = [
      { agentReplyMode: 'nghi' },
      { agentPauseMinutes: 0 },
      { agentPauseMinutes: CHATBOT_LIMITS.agentPauseMinutesMax + 1 },
      { agentPauseMinutes: 1.5 },
      { handoffReminderMin: -1 },
      { handoffReminderMin: CHATBOT_LIMITS.handoffReminderMinMax + 1 },
      { notifyKeywords: [''] },
      { notifyKeywords: ['x'.repeat(CHATBOT_LIMITS.keywordMax + 1)] },
      { handoffAckMessage: 'x'.repeat(CHATBOT_LIMITS.handoffMessageMax + 1) },
      { handoffResolveMessage: 123 },
    ];
    for (const payload of BAD) {
      const patched = await asAdmin('PATCH', `/chatbots/${bot.id}`, payload);
      expect(patched.statusCode, JSON.stringify(payload)).toBe(400);
      const created = await asAdmin('POST', '/chatbots', { name: 'Bot sai giới hạn', ...payload });
      expect(created.statusCode, JSON.stringify(payload)).toBe(400);
    }
    // Không có gì bị ghi.
    expect((await asAdmin('GET', `/chatbots/${bot.id}`)).json<ChatbotDto>()).toMatchObject({
      agentReplyMode: 'pause',
      agentPauseMinutes: null,
      handoffReminderMin: 0,
      notifyKeywords: [],
      handoffAckMessage: null,
      handoffResolveMessage: null,
    });
  });

  it('tin gửi khách khi bấm nút Cần người: mặc định null, tạo/sửa/đọc lại, trim, rỗng ⇒ null', async () => {
    const plain = await createBot({ name: 'Bot tin nút mặc định' });
    expect(plain).toMatchObject({ handoffAckMessage: null, handoffResolveMessage: null });

    const ack = `Dạ ${HANDOFF_MESSAGE_CONTACT_PLACEHOLDER} chờ em kiểm tra chút ạ`;
    const bot = await createBot({
      name: 'Bot tin nút',
      handoffAckMessage: `  ${ack}  `,
      handoffResolveMessage: '   ',
    });
    expect(bot).toMatchObject({ handoffAckMessage: ack, handoffResolveMessage: null });

    const patched = await asAdmin('PATCH', `/chatbots/${bot.id}`, {
      handoffResolveMessage: 'Dạ em đã xử lý xong ạ',
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<ChatbotDto>()).toMatchObject({
      handoffAckMessage: ack,
      handoffResolveMessage: 'Dạ em đã xử lý xong ạ',
    });

    const cleared = await asAdmin('PATCH', `/chatbots/${bot.id}`, {
      handoffAckMessage: '',
      handoffResolveMessage: null,
    });
    expect(cleared.statusCode).toBe(200);
    expect((await asAdmin('GET', `/chatbots/${bot.id}`)).json<ChatbotDto>()).toMatchObject({
      handoffAckMessage: null,
      handoffResolveMessage: null,
    });
  });

  it('từ khóa nằm ở cả hai danh sách (so không dấu) => 400; PATCH kiểm trên kết quả sau khi gộp', async () => {
    const overlap = await asAdmin('POST', '/chatbots', {
      name: 'Bot trùng từ khóa',
      handoffKeywords: ['Gặp quản lý'],
      notifyKeywords: ['bảo hành', 'GAP QUAN LY'],
    });
    expect(overlap.statusCode).toBe(400);
    expect(overlap.json<{ message: string }>().message).toBe(
      'Từ khóa "GAP QUAN LY" đang nằm ở cả hai danh sách',
    );

    const bot = await createBot({
      name: 'Bot gộp từ khóa',
      handoffKeywords: ['gặp quản lý'],
      notifyKeywords: ['bảo hành'],
    });

    // Chỉ gửi notifyKeywords: trùng với handoffKeywords đang lưu.
    const viaNotify = await asAdmin('PATCH', `/chatbots/${bot.id}`, { notifyKeywords: ['gap quan ly'] });
    expect(viaNotify.statusCode).toBe(400);
    expect(viaNotify.json<{ message: string }>().message).toContain('đang nằm ở cả hai danh sách');

    // Chỉ gửi handoffKeywords: trùng với notifyKeywords đang lưu.
    const viaHandoff = await asAdmin('PATCH', `/chatbots/${bot.id}`, { handoffKeywords: ['Bảo Hành'] });
    expect(viaHandoff.statusCode).toBe(400);
    expect(viaHandoff.json<{ message: string }>().message).toBe(
      'Từ khóa "bảo hành" đang nằm ở cả hai danh sách',
    );

    // Đổi chỗ cả hai danh sách trong cùng một PATCH: hợp lệ.
    const swapped = await asAdmin('PATCH', `/chatbots/${bot.id}`, {
      handoffKeywords: ['bảo hành'],
      notifyKeywords: ['gặp quản lý'],
    });
    expect(swapped.statusCode).toBe(200);
    expect(swapped.json<ChatbotDto>()).toMatchObject({
      handoffKeywords: ['bảo hành'],
      notifyKeywords: ['gặp quản lý'],
    });

    expect((await asAdmin('PATCH', `/chatbots/${RANDOM_ID}`, { notifyKeywords: ['a'] })).statusCode).toBe(
      404,
    );
  });
});

describe('chạy thử chatbot', () => {
  it('bot đã lưu: trả quyết định của LLM giả; draft ghi đè hướng dẫn; không ghi tin nào vào DB', async () => {
    const bot = await createBot({ name: 'Bot chạy thử', instructions: 'HUONG-DAN-DA-LUU' });
    nextLlmResponse = replyResponse(['Dạ sofa góc L giá từ 12 triệu ạ', 'Anh/chị cần kích thước nào ạ?']);

    const res = await asAdmin('POST', `/chatbots/${bot.id}/test`, {
      messages: [
        { role: 'customer', text: 'Chào shop' },
        { role: 'bot', text: 'Dạ em chào anh/chị' },
        { role: 'customer', text: 'Sofa góc giá bao nhiêu?' },
      ],
    });
    expect(res.statusCode).toBe(200);
    const result = res.json<ChatbotTestResult>();
    expect(result).toMatchObject({
      decision: 'reply',
      messages: ['Dạ sofa góc L giá từ 12 triệu ạ', 'Anh/chị cần kích thước nào ạ?'],
      model: 'gemini-2.5-flash',
    });
    expect(typeof result.latencyMs).toBe('number');
    expect(llmRequests).toHaveLength(1);
    expect(llmRequests[0]!.systemInstruction).toContain('HUONG-DAN-DA-LUU');
    expect(llmRequests[0]!.model).toBe('gemini-2.5-flash');

    const withDraft = await asAdmin('POST', `/chatbots/${bot.id}/test`, {
      messages: [{ role: 'customer', text: 'Chào shop' }],
      draft: { instructions: 'HUONG-DAN-NHAP', model: 'gemini-2.5-pro' },
    });
    expect(withDraft.statusCode).toBe(200);
    expect(llmRequests[1]!.systemInstruction).toContain('HUONG-DAN-NHAP');
    expect(llmRequests[1]!.model).toBe('gemini-2.5-pro');

    const runs = await db.select().from(aiRuns);
    expect(runs).toHaveLength(0);
  });

  it('responseSpeed => mức suy nghĩ gửi LLM: bot đã lưu, draft ghi đè, bot chưa lưu mặc định fast', async () => {
    nextLlmResponse = replyResponse(['Dạ']);
    const messages = [{ role: 'customer', text: 'Chào shop' }];
    const bot = await createBot({ name: 'Bot tốc độ chạy thử', responseSpeed: 'thorough' });

    expect((await asAdmin('POST', `/chatbots/${bot.id}/test`, { messages })).statusCode).toBe(200);
    expect(
      (await asAdmin('POST', `/chatbots/${bot.id}/test`, { messages, draft: { responseSpeed: 'balanced' } }))
        .statusCode,
    ).toBe(200);
    expect(
      (await asAdmin('POST', '/chatbots/test-draft', { draft: { name: 'Bot nháp tốc độ' }, messages }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await asAdmin('POST', '/chatbots/test-draft', {
          draft: { name: 'Bot nháp kỹ', responseSpeed: 'thorough' },
          messages,
        })
      ).statusCode,
    ).toBe(200);
    expect(llmRequests.map((r) => r.thinking)).toEqual(['high', 'low', 'minimal', 'high']);

    const bad = await asAdmin('POST', `/chatbots/${bot.id}/test`, {
      messages,
      draft: { responseSpeed: 'x' },
    });
    expect(bad.statusCode).toBe(400);
    expect(llmRequests).toHaveLength(4);
  });

  it('từ khóa chuyển người => escalate, không gọi LLM', async () => {
    const bot = await createBot({ name: 'Bot từ khóa', handoffKeywords: ['gặp quản lý'] });
    const res = await asAdmin('POST', `/chatbots/${bot.id}/test`, {
      messages: [{ role: 'customer', text: 'Cho tôi GAP QUAN LY ngay' }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<ChatbotTestResult>()).toMatchObject({
      decision: 'escalate',
      reasonCode: 'human_request',
    });
    expect(llmRequests).toHaveLength(0);
  });

  it('tin cuối không phải của khách => 400; bot không có => 404; body sai => 400', async () => {
    const bot = await createBot({ name: 'Bot kiểm body' });
    const lastIsBot = await asAdmin('POST', `/chatbots/${bot.id}/test`, {
      messages: [
        { role: 'customer', text: 'Chào' },
        { role: 'bot', text: 'Dạ' },
      ],
    });
    expect(lastIsBot.statusCode).toBe(400);
    const missing = await asAdmin('POST', `/chatbots/${RANDOM_ID}/test`, {
      messages: [{ role: 'customer', text: 'Chào' }],
    });
    expect(missing.statusCode).toBe(404);
    expect((await asAdmin('POST', `/chatbots/${bot.id}/test`, { messages: [] })).statusCode).toBe(400);
    expect(llmRequests).toHaveLength(0);
  });

  it('bot chưa lưu (test-draft): chạy với bản nháp', async () => {
    nextLlmResponse = {
      functionCall: {
        name: 'escalate',
        args: { reason_code: 'discount', summary_for_agent: 'Khách xin giảm giá' },
      },
      text: null,
      usage: { inputTokens: 50, outputTokens: 10 },
      model: 'gemini-2.5-flash',
    };
    const res = await asAdmin('POST', '/chatbots/test-draft', {
      draft: { name: 'Bot mới', instructions: 'HUONG-DAN-BOT-MOI' },
      messages: [{ role: 'customer', text: 'Giảm giá cho em 20% được không?' }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<ChatbotTestResult>()).toMatchObject({
      decision: 'escalate',
      reasonCode: 'discount',
      summary: 'Khách xin giảm giá',
    });
    expect(llmRequests[0]!.systemInstruction).toContain('HUONG-DAN-BOT-MOI');
    expect(
      (await asAdmin('POST', '/chatbots/test-draft', { messages: [{ role: 'customer', text: 'x' }] }))
        .statusCode,
    ).toBe(400);
  });

  it("Chat thử: escalate với bot aiHandoffMode 'continue' ⇒ botContinuesAfterHandoff; 'stop' / từ khóa ⇒ không có", async () => {
    const escalate = {
      functionCall: {
        name: 'escalate',
        args: {
          reason_code: 'other',
          summary_for_agent: 'CTV gửi 7 ảnh',
          messages_to_customer: ['Dạ em đã nhận đủ ảnh và chuyển cho bộ phận kiểm tra ạ.'],
        },
      },
      text: null,
      usage: { inputTokens: 5, outputTokens: 5 },
      model: 'gemini-2.5-flash',
    };
    const messages = [{ role: 'customer', text: 'Em gửi 7 ảnh công trình' }];
    nextLlmResponse = escalate;
    const cont = await asAdmin('POST', '/chatbots/test-draft', {
      draft: { name: 'Bot nháp vẫn trả lời', aiHandoffMode: 'continue' },
      messages,
    });
    expect(cont.statusCode).toBe(200);
    expect(cont.json<ChatbotTestResult>()).toMatchObject({
      decision: 'escalate',
      botContinuesAfterHandoff: true,
    });

    nextLlmResponse = escalate;
    const stop = await asAdmin('POST', '/chatbots/test-draft', {
      draft: { name: 'Bot nháp dừng' },
      messages,
    });
    expect(stop.json<ChatbotTestResult>().decision).toBe('escalate');
    expect(stop.json<ChatbotTestResult>()).not.toHaveProperty('botContinuesAfterHandoff');

    const saved = await createBot({
      name: 'Bot đã lưu vẫn trả lời',
      aiHandoffMode: 'continue',
      handoffKeywords: ['gặp nhân viên'],
    });
    nextLlmResponse = escalate;
    const savedRun = await asAdmin('POST', `/chatbots/${saved.id}/test`, { messages });
    expect(savedRun.json<ChatbotTestResult>()).toMatchObject({ botContinuesAfterHandoff: true });
    nextLlmResponse = escalate;
    const overridden = await asAdmin('POST', `/chatbots/${saved.id}/test`, {
      messages,
      draft: { aiHandoffMode: 'stop' },
    });
    expect(overridden.json<ChatbotTestResult>()).not.toHaveProperty('botContinuesAfterHandoff');
    // Từ khóa chuyển người luôn dừng bot.
    const keyword = await asAdmin('POST', `/chatbots/${saved.id}/test`, {
      messages: [{ role: 'customer', text: 'cho em gặp nhân viên' }],
    });
    expect(keyword.json<ChatbotTestResult>().decision).toBe('escalate');
    expect(keyword.json<ChatbotTestResult>()).not.toHaveProperty('botContinuesAfterHandoff');
  });

  it('escalateWhenUnsure: mặc định confidence thấp => escalate; draft false => vẫn reply', async () => {
    nextLlmResponse = replyResponse(['Chắc là có ạ'], 0.2);
    const messages = [{ role: 'customer', text: 'Có nghỉ lễ 2/9 không?' }];
    const unsure = await asAdmin('POST', '/chatbots/test-draft', {
      draft: { name: 'Bot mặc định' },
      messages,
    });
    expect(unsure.json<ChatbotTestResult>()).toMatchObject({
      decision: 'escalate',
      reasonCode: 'low_confidence',
    });

    const relaxed = await asAdmin('POST', '/chatbots/test-draft', {
      draft: { name: 'Bot thoải mái', escalateWhenUnsure: false },
      messages,
    });
    expect(relaxed.statusCode).toBe(200);
    expect(relaxed.json<ChatbotTestResult>()).toMatchObject({
      decision: 'reply',
      messages: ['Chắc là có ạ'],
    });
    expect(llmRequests[1]!.systemInstruction).toContain('không chuyển nhân viên chỉ vì không chắc');

    const saved = await createBot({ name: 'Bot đã lưu thoải mái', escalateWhenUnsure: false });
    expect(saved.escalateWhenUnsure).toBe(false);
    const savedRun = await asAdmin('POST', `/chatbots/${saved.id}/test`, { messages });
    expect(savedRun.json<ChatbotTestResult>()).toMatchObject({ decision: 'reply' });
    const overridden = await asAdmin('POST', `/chatbots/${saved.id}/test`, {
      messages,
      draft: { escalateWhenUnsure: true },
    });
    expect(overridden.json<ChatbotTestResult>()).toMatchObject({
      decision: 'escalate',
      reasonCode: 'low_confidence',
    });
  });
});

/** Ảnh giả: chữ ký định dạng (magic bytes) + `bytes` byte `fill` — LLM giả không giải mã ảnh. */
const SIGNATURES = {
  'image/jpeg': [0xff, 0xd8, 0xff, 0xe0],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/gif': [...Buffer.from('GIF89a')],
  'image/webp': [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')],
} as const;
type ImageMime = keyof typeof SIGNATURES;
function fakeImage(mime: ImageMime, fill: number, bytes = 64): string {
  const buf = Buffer.alloc(bytes, fill);
  Buffer.from(SIGNATURES[mime]).copy(buf);
  return buf.toString('base64');
}

/** Các part ảnh inline của một request LLM (theo thứ tự trong prompt). */
const inlineImagesOf = (req: LlmRequest) =>
  req.contents.flatMap((c) => c.parts).flatMap((p) => ('inlineImage' in p ? [p.inlineImage] : []));
const promptTextOf = (req: LlmRequest) =>
  req.contents
    .flatMap((c) => c.parts)
    .flatMap((p) => ('text' in p ? [p.text] : []))
    .join('\n');

const validationMessages = (res: { json: <T>() => T }) =>
  (res.json<{ errors?: { message: string }[] }>().errors ?? []).map((e) => e.message);

describe('chạy thử kèm ảnh', () => {
  beforeEach(() => {
    nextLlmResponse = replyResponse(['Dạ em nhận ảnh ạ']);
    // Giới hạn 20 lượt/phút/admin đã có unit test; file này chạy thử nhiều hơn thế trong một phút.
    vi.spyOn(SlidingWindowLimiter.prototype, 'take').mockReturnValue(true);
  });

  it('ảnh của các tin khách cuối tới LLM dạng inline theo thứ tự (mime theo byte đầu); ảnh lịch sử không gửi', async () => {
    const bot = await createBot({ name: 'Bot nhận ảnh thi công' });
    const old = fakeImage('image/jpeg', 1);
    const first = fakeImage('image/png', 2);
    const second = fakeImage('image/jpeg', 3); // trình duyệt khai báo nhầm image/png
    const third = fakeImage('image/webp', 4);
    const res = await asAdmin('POST', `/chatbots/${bot.id}/test`, {
      messages: [
        { role: 'customer', text: 'Công trình cũ', images: [{ mimeType: 'image/jpeg', data: old }] },
        { role: 'bot', text: 'Dạ em đã nhận' },
        {
          role: 'customer',
          text: '',
          images: [
            { mimeType: 'image/png', data: first },
            { mimeType: 'image/png', data: second },
          ],
        },
        { role: 'customer', text: 'Còn 1 ảnh nữa', images: [{ mimeType: 'image/webp', data: third }] },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<ChatbotTestResult>()).toMatchObject({ decision: 'reply' });
    expect(llmRequests).toHaveLength(1);
    const req = llmRequests[0]!;
    expect(inlineImagesOf(req)).toEqual([
      { mime: 'image/png', data: first },
      { mime: 'image/jpeg', data: second },
      { mime: 'image/webp', data: third },
    ]);
    const text = promptTextOf(req);
    // Dòng lịch sử vẫn ghi số ảnh như chạy thật; tin chỉ có ảnh không bị coi là tin trống.
    expect(text).toContain('[gửi 1 ảnh/tệp]');
    expect(text).toContain('[gửi 2 ảnh/tệp]');
    expect(text).not.toContain('[tin trống]');
    // Nhãn từng ảnh do core đánh ("Ảnh k/N").
    expect(text).toContain('Ảnh 1/3');
    expect(text).toContain('Ảnh 3/3');
    expect(JSON.stringify(req.contents)).not.toContain(old);
  });

  it(`test-draft: nhận đủ ${CHATBOT_LIMITS.testImagesMax} ảnh trong một lượt, tất cả tới LLM`, async () => {
    const images = Array.from({ length: CHATBOT_LIMITS.testImagesMax }, (_, i) => ({
      mimeType: 'image/jpeg',
      data: fakeImage('image/jpeg', 10 + i),
    }));
    const res = await asAdmin('POST', '/chatbots/test-draft', {
      draft: { name: 'Bot nháp nhận ảnh' },
      messages: [{ role: 'customer', text: 'Gửi anh/chị ảnh công trình', images }],
    });
    expect(res.statusCode).toBe(200);
    expect(inlineImagesOf(llmRequests[0]!).map((i) => i.data)).toEqual(images.map((i) => i.data));
  });

  it('ảnh sai => 400 tiếng Việt, không gọi LLM', async () => {
    const bot = await createBot({ name: 'Bot kiểm ảnh' });
    const url = `/chatbots/${bot.id}/test`;
    const png = fakeImage('image/png', 5);
    const withImages = (images: unknown[]) => ({
      messages: [{ role: 'customer', text: 'Ảnh đây', images }],
    });

    const onBot = await asAdmin('POST', url, {
      messages: [
        { role: 'bot', text: 'Mẫu', images: [{ mimeType: 'image/png', data: png }] },
        { role: 'customer', text: 'Chào' },
      ],
    });
    expect(onBot.statusCode).toBe(400);
    expect(validationMessages(onBot)).toContain('Chỉ tin của khách mới được gửi kèm ảnh');

    const tooMany = await asAdmin('POST', url, {
      messages: [
        { role: 'customer', text: 'a', images: Array(6).fill({ mimeType: 'image/png', data: png }) },
        { role: 'bot', text: 'Dạ' },
        { role: 'customer', text: 'b', images: Array(5).fill({ mimeType: 'image/png', data: png }) },
      ],
    });
    expect(tooMany.statusCode).toBe(400);
    expect(validationMessages(tooMany).join(' ')).toContain(`Tối đa ${CHATBOT_LIMITS.testImagesMax} ảnh`);

    const tooBig = fakeImage('image/png', 6, CHATBOT_LIMITS.testImageMaxBytes + 1);
    const cases: { images: unknown[]; message: string }[] = [
      { images: [{ mimeType: 'image/bmp', data: png }], message: 'JPEG, PNG hoặc WebP' },
      { images: [{ mimeType: 'image/gif', data: png }], message: 'JPEG, PNG hoặc WebP' },
      { images: [{ mimeType: 'image/png', data: 'không phải base64!' }], message: 'base64' },
      { images: [{ mimeType: 'image/png', data: `data:image/png;base64,${png}` }], message: 'base64' },
      { images: [{ mimeType: 'image/png', data: tooBig }], message: '4 MB' },
    ];
    for (const c of cases) {
      const res = await asAdmin('POST', url, withImages(c.images));
      expect(res.statusCode).toBe(400);
      expect(validationMessages(res).join(' ')).toContain(c.message);
    }

    // base64 hợp lệ nhưng không phải ảnh (mime khai báo đúng danh sách) ⇒ 400 ở bước nhận dạng byte đầu.
    const notImage = await asAdmin(
      'POST',
      url,
      withImages([
        { mimeType: 'image/png', data: png },
        { mimeType: 'image/jpeg', data: Buffer.from('xin chào, đây là chữ').toString('base64') },
      ]),
    );
    expect(notImage.statusCode).toBe(400);
    expect(notImage.json<{ message: string }>().message).toBe(
      'Ảnh thứ 2 không phải ảnh JPEG, PNG hoặc WebP hợp lệ',
    );
    // Byte GIF (dù khai báo JPEG) ⇒ 400 nói rõ chưa hỗ trợ GIF.
    const gif = await asAdmin(
      'POST',
      url,
      withImages([{ mimeType: 'image/jpeg', data: fakeImage('image/gif', 1) }]),
    );
    expect(gif.statusCode).toBe(400);
    expect(gif.json<{ message: string }>().message).toBe(
      'Ảnh thứ 1 là ảnh GIF — chưa hỗ trợ, vui lòng gửi ảnh JPEG, PNG hoặc WebP',
    );
    expect(llmRequests).toHaveLength(0);
  });

  it('body: route chạy thử nhận vài MB ảnh; vượt giới hạn => 413 tiếng Việt; route khác vẫn 1 MB', async () => {
    const bot = await createBot({ name: 'Bot ảnh lớn' });
    const bigImages = [1, 2].map((fill) => ({
      mimeType: 'image/jpeg',
      data: fakeImage('image/jpeg', fill, 3 * 1024 * 1024),
    }));
    const messages = [{ role: 'customer', text: 'Hai ảnh nét', images: bigImages }];
    const saved = await asAdmin('POST', `/chatbots/${bot.id}/test`, { messages });
    expect(saved.statusCode).toBe(200);
    const draft = await asAdmin('POST', '/chatbots/test-draft', {
      draft: { name: 'Bot nháp ảnh lớn' },
      messages,
    });
    expect(draft.statusCode).toBe(200);
    expect(llmRequests.map((r) => inlineImagesOf(r).length)).toEqual([2, 2]);

    const padding = 'x'.repeat(CHATBOT_TEST_BODY_LIMIT_BYTES + 1);
    const tooLargeBodies: [string, Record<string, unknown>][] = [
      [`/chatbots/${bot.id}/test`, {}],
      ['/chatbots/test-draft', { draft: { name: 'Bot nháp' } }],
    ];
    for (const [url, extra] of tooLargeBodies) {
      const tooLarge = await asAdmin('POST', url, {
        ...extra,
        messages: [{ role: 'customer', text: 'x' }],
        padding,
      });
      expect(tooLarge.statusCode).toBe(413);
      expect(tooLarge.json<{ message: string }>().message).toBe(CHATBOT_TEST_BODY_TOO_LARGE_MESSAGE);
    }

    const otherRoute = await asAdmin('POST', '/chatbots', {
      name: 'Bot quá lớn',
      knowledge: 'x'.repeat(2 * 1024 * 1024),
    });
    expect(otherRoute.statusCode).toBe(413);
    expect(otherRoute.json<{ message: string }>().message).toBe('Dữ liệu gửi lên quá lớn');
    expect(llmRequests).toHaveLength(2);
  });
});

describe('chạy thử: tin người nhắn thật sự nhận (messages) và lịch sử ảnh', () => {
  const QUOTE = 'Dạ với 5 ảnh công trình thì mức thù lao dự kiến là 50.000đ ạ.';
  const HANDOFF = 'Dạ em chuyển nhân viên hỗ trợ ạ.';
  const escalateResponse = (messages_to_customer?: string[]): LlmResponse => ({
    functionCall: {
      name: 'escalate',
      args: {
        reason_code: 'other',
        summary_for_agent: 'CTV gửi đủ 5 ảnh',
        ...(messages_to_customer ? { messages_to_customer } : {}),
      },
    },
    text: null,
    usage: { inputTokens: 100, outputTokens: 10 },
    model: 'gemini-2.5-flash',
  });
  const messages = [{ role: 'customer', text: 'Em gửi đủ 5 ảnh công trình A rồi' }];

  beforeEach(() => {
    vi.spyOn(SlidingWindowLimiter.prototype, 'take').mockReturnValue(true);
  });

  it('escalate có messages_to_customer ⇒ messages = các tin đó (không kèm handoffMessage)', async () => {
    const bot = await createBot({ name: 'Bot CTV báo giá', handoffMessage: HANDOFF });
    nextLlmResponse = escalateResponse([QUOTE, 'Em đã chuyển hồ sơ cho bộ phận duyệt ạ.']);
    const res = await asAdmin('POST', `/chatbots/${bot.id}/test`, { messages });
    expect(res.statusCode).toBe(200);
    expect(res.json<ChatbotTestResult>()).toMatchObject({
      decision: 'escalate',
      reasonCode: 'other',
      summary: 'CTV gửi đủ 5 ảnh',
      messages: [QUOTE, 'Em đã chuyển hồ sơ cho bộ phận duyệt ạ.'],
    });
    expect(res.json<Record<string, unknown>>()).not.toHaveProperty('customerMessages');
  });

  it('escalate không có messages_to_customer ⇒ handoffMessage (đã lưu hoặc bản nháp), không có ⇒ []', async () => {
    const bot = await createBot({ name: 'Bot CTV giữ chỗ', handoffMessage: HANDOFF });
    nextLlmResponse = escalateResponse();
    const saved = await asAdmin('POST', `/chatbots/${bot.id}/test`, { messages });
    expect(saved.json<ChatbotTestResult>()).toMatchObject({ decision: 'escalate', messages: [HANDOFF] });
    const draft = await asAdmin('POST', `/chatbots/${bot.id}/test`, {
      messages,
      draft: { handoffMessage: 'Dạ chờ em chút ạ' },
    });
    expect(draft.json<ChatbotTestResult>().messages).toEqual(['Dạ chờ em chút ạ']);
    const silent = await asAdmin('POST', `/chatbots/${bot.id}/test`, {
      messages,
      draft: { handoffMessage: null },
    });
    expect(silent.json<ChatbotTestResult>().messages).toEqual([]);
    // Từ khóa chuyển người (không gọi LLM) cũng gửi handoffMessage.
    const kw = await asAdmin('POST', '/chatbots/test-draft', {
      draft: { name: 'Bot từ khóa giữ chỗ', handoffKeywords: ['gặp quản lý'], handoffMessage: HANDOFF },
      messages: [{ role: 'customer', text: 'gặp quản lý' }],
    });
    expect(kw.json<ChatbotTestResult>()).toMatchObject({ decision: 'escalate', messages: [HANDOFF] });
  });

  it('reply tự nói "đã chuyển" ⇒ escalate, messages = bong bóng đó; no_reply ⇒ []', async () => {
    const bot = await createBot({ name: 'Bot CTV tự nói', handoffMessage: HANDOFF });
    const claim = 'Dạ em đã chuyển hồ sơ cho bộ phận duyệt rồi ạ.';
    nextLlmResponse = replyResponse([claim]);
    const res = await asAdmin('POST', `/chatbots/${bot.id}/test`, { messages });
    expect(res.json<ChatbotTestResult>()).toMatchObject({
      decision: 'escalate',
      reasonCode: 'other',
      messages: [claim],
    });
    // Gọi lại model đúng một lần trước khi tự chuyển.
    expect(llmRequests).toHaveLength(2);
    nextLlmResponse = {
      functionCall: { name: 'no_reply', args: { reason: 'Khách chỉ cảm ơn' } },
      text: null,
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'gemini-2.5-flash',
    };
    const none = await asAdmin('POST', `/chatbots/${bot.id}/test`, {
      messages: [{ role: 'customer', text: 'ok' }],
    });
    expect(none.json<ChatbotTestResult>()).toMatchObject({ decision: 'no_reply', messages: [] });
  });

  it('tin khách lượt cũ chỉ có imageCount (text rỗng) ⇒ dòng lịch sử "[gửi N ảnh/tệp]", không phải tin trống', async () => {
    const bot = await createBot({ name: 'Bot lịch sử ảnh' });
    nextLlmResponse = replyResponse(['Dạ em nhận rồi ạ']);
    const res = await asAdmin('POST', `/chatbots/${bot.id}/test`, {
      messages: [
        { role: 'customer', text: '', imageCount: 5 },
        { role: 'customer', text: 'Công trình A', imageCount: 2 },
        { role: 'bot', text: 'Dạ anh/chị cho em xin tên nhà thầu ạ' },
        { role: 'customer', text: 'Nhà thầu B' },
      ],
    });
    expect(res.statusCode).toBe(200);
    const text = promptTextOf(llmRequests[0]!);
    expect(text).toContain('[Khách] [gửi 5 ảnh/tệp]');
    expect(text).toContain('[Khách] <customer_message>Công trình A</customer_message> [gửi 2 ảnh/tệp]');
    expect(text).not.toContain('[tin trống]');
    expect(inlineImagesOf(llmRequests[0]!)).toHaveLength(0);
  });
});

describe('GET /chatbots/models', () => {
  it('lỗi liệt kê => chỉ GEMINI_MODEL (không cache lỗi); thành công => cache 1 giờ, luôn có model mặc định', async () => {
    geminiModels.mockRejectedValueOnce(new Error('mạng lỗi'));
    const fallback = await asAdmin('GET', '/chatbots/models');
    expect(fallback.statusCode).toBe(200);
    expect(fallback.json()).toEqual({ defaultModel: 'gemini-2.5-flash', models: ['gemini-2.5-flash'] });

    geminiModels.mockResolvedValueOnce(['gemini-2.5-pro', 'gemini-2.0-flash']);
    const listed = await asAdmin('GET', '/chatbots/models');
    expect(listed.json()).toEqual({
      defaultModel: 'gemini-2.5-flash',
      models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    });
    await asAdmin('GET', '/chatbots/models');
    expect(geminiModels).toHaveBeenCalledTimes(2);
  });
});

describe('chatbot trên hội thoại', () => {
  it('bật/tắt bot: trả summary mới và phát conversation.updated; bot tắt => 400; không xem được => 403', async () => {
    const bot = await createBot({ name: 'Bot hội thoại' });
    const inactive = await createBot({ name: 'Bot nghỉ', isActive: false });
    const updates = spyUpdates();

    const on = await asAgent('PATCH', `/conversations/${seed.unassignedConversationId}/chatbot`, {
      chatbotId: bot.id,
    });
    expect(on.statusCode).toBe(200);
    expect(on.json<ConversationSummary>()).toMatchObject({
      id: seed.unassignedConversationId,
      aiMode: 'auto',
      chatbot: { id: bot.id, name: 'Bot hội thoại' },
      aiPausedUntil: null,
    });
    expect(updates()).toHaveLength(1);
    expect(updates()[0]!.conversation.chatbot?.id).toBe(bot.id);
    expect(updates()[0]!.rooms).toEqual(expect.arrayContaining([ROOM_ADMINS, ROOM_UNASSIGNED]));

    const off = await asAgent('PATCH', `/conversations/${seed.unassignedConversationId}/chatbot`, {
      chatbotId: null,
    });
    expect(off.statusCode).toBe(200);
    expect(off.json<ConversationSummary>()).toMatchObject({ aiMode: 'off', chatbot: null });
    expect(updates()).toHaveLength(2);

    const inactiveRes = await asAdmin('PATCH', `/conversations/${seed.unassignedConversationId}/chatbot`, {
      chatbotId: inactive.id,
    });
    expect(inactiveRes.statusCode).toBe(400);

    const forbidden = await asAgent('PATCH', `/conversations/${seed.adminConversationId}/chatbot`, {
      chatbotId: bot.id,
    });
    expect(forbidden.statusCode).toBe(403);
    const badBody = await asAgent('PATCH', `/conversations/${seed.unassignedConversationId}/chatbot`, {
      chatbotId: 'abc',
    });
    expect(badBody.statusCode).toBe(400);
  });

  it('nhân viên gửi tin vào hội thoại có bot => AI tạm dừng, realtime mang summary mới; "Tiếp tục AI" xóa tạm dừng', async () => {
    const bot = await createBot({ name: 'Bot tạm dừng' });
    const conversationId = seed.agentConversationId;
    expect(
      (await asAgent('PATCH', `/conversations/${conversationId}/chatbot`, { chatbotId: bot.id })).statusCode,
    ).toBe(200);

    const updates = spyUpdates();
    const sent = await asAgent('POST', `/conversations/${conversationId}/messages`, {
      clientId: 'c7b3d1f0-0000-4000-8000-000000000001',
      text: 'Dạ để em tư vấn trực tiếp ạ',
    });
    expect(sent.statusCode).toBe(201);
    const pushed = updates().at(-1)!.conversation;
    expect(pushed.aiPausedUntil).toBeTruthy();
    expect(Date.parse(pushed.aiPausedUntil!)).toBeGreaterThan(Date.now() + 25 * 60_000);

    const resumed = await asAgent('POST', `/conversations/${conversationId}/ai/resume`);
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json<ConversationSummary>()).toMatchObject({ aiPausedUntil: null, aiMode: 'auto' });
    expect(updates().at(-1)!.conversation.aiPausedUntil).toBeNull();

    await asAgent('PATCH', `/conversations/${conversationId}/chatbot`, { chatbotId: null });
  });

  it('handoff: "Nhận xử lý" gán người + ghi người nhận; "trả lại cho AI" mở lại hội thoại, ai_mode auto', async () => {
    const bot = await createBot({ name: 'Bot handoff' });
    const conversationId = seed.unassignedConversationId;
    await db
      .update(conversations)
      .set({
        chatbotId: bot.id,
        aiMode: 'off',
        status: 'pending_human',
        handoffReason: 'discount',
        handoffAt: new Date(),
      })
      .where(eq(conversations.id, conversationId));
    await db
      .insert(handoffs)
      .values({ conversationId, reasonCode: 'discount', summary: 'Khách xin giảm 20%', createdBy: 'ai' });

    const noHandoff = await asAgent('POST', `/conversations/${seed.agentConversationId}/handoff/ack`);
    expect(noHandoff.statusCode).toBe(400);

    const updates = spyUpdates();
    const ack = await asAgent('POST', `/conversations/${conversationId}/handoff/ack`);
    expect(ack.statusCode).toBe(200);
    const acked = ack.json<ConversationSummary>();
    expect(acked.assignedUser?.id).toBe(seed.agentId);
    expect(acked.handoff).toMatchObject({ reasonCode: 'discount', summary: 'Khách xin giảm 20%' });
    expect(acked.handoff?.acknowledgedBy?.id).toBe(seed.agentId);
    // Đổi người phụ trách: phát cả phòng cũ (chưa phân công) lẫn phòng của người nhận.
    expect(updates()[0]!.rooms).toEqual(
      expect.arrayContaining([ROOM_ADMINS, ROOM_UNASSIGNED, userRoom(seed.agentId)]),
    );

    const resolved = await asAgent('POST', `/conversations/${conversationId}/handoff/resolve`);
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json<ConversationSummary>()).toMatchObject({
      status: 'open',
      aiMode: 'auto',
      handoff: null,
      aiPausedUntil: null,
      chatbot: { id: bot.id },
    });
    expect(updates()).toHaveLength(2);
    // Bot không bật "Gửi Lark khi bấm nút" ⇒ không gửi Lark.
    expect(larkCalls).toHaveLength(0);

    // Trả lại trạng thái ban đầu cho các test khác.
    await db
      .update(conversations)
      .set({ chatbotId: null, aiMode: 'off', assignedUserId: null })
      .where(eq(conversations.id, conversationId));
  });

  it('nút tùy chỉnh "Nghiệm thu" / "Đã chuyển tiền" + Lark: mỗi lần bấm đổi trạng thái gửi đúng một thẻ', async () => {
    const bot = await createBot({
      name: 'Bot nghiệm thu',
      handoffAckLabel: '  Nghiệm thu ',
      handoffResolveLabel: 'Đã chuyển tiền',
      handoffActionLark: true,
    });
    expect(bot).toMatchObject({
      handoffAckLabel: 'Nghiệm thu',
      handoffResolveLabel: 'Đã chuyển tiền',
      handoffActionLark: true,
    });
    const listed = (await asAgent('GET', '/chatbots')).json<ChatbotSummary[]>().find((b) => b.id === bot.id);
    expect(listed).toMatchObject({ handoffAckLabel: 'Nghiệm thu', handoffResolveLabel: 'Đã chuyển tiền' });

    const conversationId = seed.unassignedConversationId;
    await makePendingHuman(conversationId, bot.id);
    await db.insert(handoffs).values({
      conversationId,
      reasonCode: 'other',
      summary: 'Công trình 33 Trần Quang Diệu: 7 ảnh hợp lệ. Thù lao 35.000đ',
      createdBy: 'ai',
    });
    larkCalls.length = 0;

    const ackRes = await asAgent('POST', `/conversations/${conversationId}/handoff/ack`);
    expect(ackRes.statusCode).toBe(200);
    // Tên nút đi kèm hội thoại (banner không phụ thuộc danh sách bot).
    expect(ackRes.json<ConversationSummary>().chatbot).toEqual({
      id: bot.id,
      name: 'Bot nghiệm thu',
      handoffAckLabel: 'Nghiệm thu',
      handoffResolveLabel: 'Đã chuyển tiền',
    });
    expect(larkCalls).toHaveLength(1);
    expect(larkCalls[0]!.url).toBe(ENV_LARK_URL);
    const ackCard = JSON.stringify(larkCalls[0]!.body);
    expect(ackCard).toContain('✅ Nghiệm thu');
    expect(ackCard).toContain('Công trình 33 Trần Quang Diệu');
    expect(ackCard).toContain(`/inbox/${conversationId}`);

    // Bấm lại "Nghiệm thu" (đã nhận rồi) ⇒ không gửi trùng.
    expect((await asAgent('POST', `/conversations/${conversationId}/handoff/ack`)).statusCode).toBe(200);
    expect(larkCalls).toHaveLength(1);

    expect((await asAgent('POST', `/conversations/${conversationId}/handoff/resolve`)).statusCode).toBe(200);
    expect(larkCalls).toHaveLength(2);
    expect(JSON.stringify(larkCalls[1]!.body)).toContain('☑️ Đã chuyển tiền');

    // Bấm lại "Đã chuyển tiền" ⇒ không có gì để đóng, không gửi.
    expect((await asAgent('POST', `/conversations/${conversationId}/handoff/resolve`)).statusCode).toBe(200);
    expect(larkCalls).toHaveLength(2);

    // Lark lỗi ⇒ nút vẫn chạy (chỉ log).
    await makePendingHuman(conversationId, bot.id);
    await db
      .insert(handoffs)
      .values({ conversationId, reasonCode: 'other', summary: 'Công trình khác', createdBy: 'ai' });
    larkReply = { status: 500, body: { code: 1, msg: 'lỗi' } };
    expect((await asAgent('POST', `/conversations/${conversationId}/handoff/ack`)).statusCode).toBe(200);
    expect((await asAgent('POST', `/conversations/${conversationId}/handoff/resolve`)).statusCode).toBe(200);
    larkReply = { status: 200, body: { code: 0, msg: 'success' } };

    await aiReply.obliterate({ force: true });
    await resetConversation(conversationId);
    await db.update(conversations).set({ assignedUserId: null }).where(eq(conversations.id, conversationId));
  });

  it('"Không đạt": AI (bot đang gắn) soạn tin gửi thẳng; handoff giữ nguyên; Lark ❌ kèm lý do; lỗi 400', async () => {
    const bot = await createBot({
      name: 'Bot Vua Thầu',
      instructions: 'HUONG-DAN-VUA-THAU',
      handoffActionLark: true,
    });
    const conversationId = seed.unassignedConversationId;
    await makePendingHuman(conversationId, bot.id);
    larkCalls.length = 0;

    // Thiếu lý do ⇒ 400 (Zod); hội thoại không có handoff mở ⇒ 400 tiếng Việt. Không gọi AI.
    const blank = await asAgent('POST', `/conversations/${conversationId}/handoff/reject`, { reason: '   ' });
    expect(blank.statusCode).toBe(400);
    const noHandoff = await asAgent('POST', `/conversations/${seed.agentConversationId}/handoff/reject`, {
      reason: 'Chưa đạt',
    });
    expect(noHandoff.statusCode).toBe(400);
    expect(noHandoff.json<{ message: string }>().message).toBe(
      'Hội thoại không có yêu cầu chuyển người nào đang mở',
    );
    expect(llmRequests).toHaveLength(0);

    nextLlmResponse = replyResponse(
      ['Dạ em cảm ơn anh ạ', 'Lần này công trình chưa đạt vì mới làm móng ạ'],
      0.1,
    );
    const updates = spyUpdates();
    const res = await asAgent('POST', `/conversations/${conversationId}/handoff/reject`, {
      reason: ' Mới làm móng, chưa lên tầng ',
    });
    nextLlmResponse = replyResponse(['Dạ em chào anh/chị ạ']);
    expect(res.statusCode).toBe(200);
    expect(res.json<ConversationSummary>()).toMatchObject({
      status: 'pending_human',
      aiMode: 'off',
      handoff: { reasonCode: 'discount', acknowledgedBy: null },
    });
    expect(updates()).toHaveLength(1);
    expect(llmRequests).toHaveLength(1);
    expect(llmRequests[0]!.systemInstruction).toContain('HUONG-DAN-VUA-THAU');
    expect(llmRequests[0]!.tools.map((t) => t.name)).toEqual(['reply']);
    expect(await openHandoffsOf(conversationId)).toHaveLength(1);

    const sent = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.status, 'queued')));
    expect(sent.map((m) => [m.senderType, m.text])).toEqual([
      ['bot', 'Dạ em cảm ơn anh ạ'],
      ['bot', 'Lần này công trình chưa đạt vì mới làm móng ạ'],
    ]);
    for (const m of sent) expect(await outbound.getJob(outboundJobId(m.id))).toBeTruthy();
    const [note] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.senderType, 'system')))
      .orderBy(desc(messages.sentAt))
      .limit(1);
    expect(note!.text).toBe(`Nhân viên ${AGENT.name} đánh dấu Không đạt: Mới làm móng, chưa lên tầng`);

    expect(larkCalls).toHaveLength(1);
    const card = JSON.stringify(larkCalls[0]!.body);
    expect(card).toContain('❌ Không đạt');
    expect(card).toContain('Mới làm móng, chưa lên tầng');

    // Trả lại trạng thái ban đầu (tin cuối của khách) cho các test "kick" phía sau.
    await db.delete(messages).where(inArray(messages.id, [...sent.map((m) => m.id), note!.id]));
    await db
      .update(handoffs)
      .set({ resolvedAt: new Date() })
      .where(eq(handoffs.conversationId, conversationId));
    await resetConversation(conversationId);
  });

  it('nhật ký AI (admin) trả các lần chạy mới nhất', async () => {
    await db.insert(aiRuns).values({
      conversationId: seed.adminConversationId,
      model: 'gemini-2.5-flash',
      decision: 'no_reply',
      inputTokens: 10,
      outputTokens: 2,
      latencyMs: 900,
    });
    const res = await asAdmin('GET', `/conversations/${seed.adminConversationId}/ai-runs`);
    expect(res.statusCode).toBe(200);
    const runs = res.json<AiRunDto[]>();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ decision: 'no_reply', model: 'gemini-2.5-flash', latencyMs: 900 });
    await db.delete(aiRuns);
  });

  it('xóa bot đang gắn => gỡ khỏi hội thoại, phát conversation.updated', async () => {
    const bot = await createBot({ name: 'Bot sẽ xóa' });
    await asAdmin('PATCH', `/conversations/${seed.adminConversationId}/chatbot`, { chatbotId: bot.id });
    const updates = spyUpdates();

    const res = await asAdmin('DELETE', `/chatbots/${bot.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ detachedConversations: 1 });
    const pushed = updates().find((u) => u.conversation.id === seed.adminConversationId);
    expect(pushed?.conversation).toMatchObject({ chatbot: null, aiMode: 'off' });
  });

  it('bật bot khi tin cuối là của khách ⇒ đẩy job "kick"; tin cuối của nhân viên ⇒ không', async () => {
    const bot = await createBot({ name: 'Bot đánh thức' });
    const waiting = seed.unassignedConversationId;
    const on = await asAgent('PATCH', `/conversations/${waiting}/chatbot`, { chatbotId: bot.id });
    expect(on.statusCode).toBe(200);
    const job = await kickJob(waiting);
    expect(job?.name).toBe(AI_KICK_JOB_NAME);
    expect(job?.data).toEqual({ conversationId: waiting });
    expect(job?.opts.removeOnComplete).toBe(true);

    // Tắt bot: không đẩy gì thêm.
    await aiReply.obliterate({ force: true });
    await asAgent('PATCH', `/conversations/${waiting}/chatbot`, { chatbotId: null });
    expect(await kickJob(waiting)).toBeUndefined();

    // Nhân viên đã trả lời sau tin khách ⇒ không đánh thức.
    const answered = seed.agentConversationId;
    const [agentMsg] = await db
      .insert(messages)
      .values({
        conversationId: answered,
        channelAccountId: seed.channelId,
        senderType: 'agent',
        senderUserId: seed.agentId,
        text: 'Dạ em chào chị',
        status: 'sent',
        sentAt: new Date(),
      })
      .returning({ id: messages.id });
    const on2 = await asAgent('PATCH', `/conversations/${answered}/chatbot`, { chatbotId: bot.id });
    expect(on2.statusCode).toBe(200);
    expect(await kickJob(answered)).toBeUndefined();

    await db.delete(messages).where(eq(messages.id, agentMsg!.id));
    await resetConversation(waiting);
    await resetConversation(answered);
  });

  it('"trả lại cho AI" và "Tiếp tục AI" khi khách đang chờ ⇒ đẩy job "kick"', async () => {
    const bot = await createBot({ name: 'Bot trả lại' });
    const conversationId = seed.unassignedConversationId;
    await makePendingHuman(conversationId, bot.id);
    expect((await asAgent('POST', `/conversations/${conversationId}/handoff/resolve`)).statusCode).toBe(200);
    expect((await kickJob(conversationId))?.name).toBe(AI_KICK_JOB_NAME);

    await aiReply.obliterate({ force: true });
    await db
      .update(conversations)
      .set({ aiPausedUntil: new Date(Date.now() + 20 * 60_000) })
      .where(eq(conversations.id, conversationId));
    expect((await asAgent('POST', `/conversations/${conversationId}/ai/resume`)).statusCode).toBe(200);
    expect((await kickJob(conversationId))?.name).toBe(AI_KICK_JOB_NAME);
    await resetConversation(conversationId);
  });

  it('bật bot khi đang chờ người ⇒ đóng handoff, mở lại hội thoại, đánh thức bot', async () => {
    const bot = await createBot({ name: 'Bot khi chờ người' });
    const conversationId = seed.unassignedConversationId;
    await makePendingHuman(conversationId, bot.id);
    const res = await asAgent('PATCH', `/conversations/${conversationId}/chatbot`, { chatbotId: bot.id });
    expect(res.statusCode).toBe(200);
    expect(res.json<ConversationSummary>()).toMatchObject({
      status: 'open',
      aiMode: 'auto',
      handoff: null,
      chatbot: { id: bot.id },
    });
    expect(await openHandoffsOf(conversationId)).toHaveLength(0);
    expect((await kickJob(conversationId))?.name).toBe(AI_KICK_JOB_NAME);
    await resetConversation(conversationId);
  });

  it('"Xong" (PATCH status resolved) khi đang chờ người ⇒ đóng handoff, ai_mode vẫn off', async () => {
    const bot = await createBot({ name: 'Bot xong' });
    const conversationId = seed.unassignedConversationId;
    await makePendingHuman(conversationId, bot.id);
    const res = await asAgent('PATCH', `/conversations/${conversationId}`, { status: 'resolved' });
    expect(res.statusCode).toBe(200);
    expect(res.json<ConversationSummary>()).toMatchObject({
      status: 'resolved',
      aiMode: 'off',
      handoff: null,
      chatbot: { id: bot.id },
    });
    expect(await openHandoffsOf(conversationId)).toHaveLength(0);
    expect(await kickJob(conversationId)).toBeUndefined();
    await resetConversation(conversationId);
  });

  it(`xóa bot gắn rất nhiều hội thoại ⇒ chỉ phát realtime cho ${DELETE_EMIT_LIMIT} hội thoại mới nhất`, async () => {
    const bot = await createBot({ name: 'Bot rất nhiều hội thoại' });
    const total = DELETE_EMIT_LIMIT + 5;
    const people = await db
      .insert(contacts)
      .values(Array.from({ length: total }, (_, i) => ({ displayName: `Khách ${i}` })))
      .returning({ id: contacts.id });
    const identities = await db
      .insert(contactIdentities)
      .values(
        people.map((p, i) => ({
          contactId: p.id,
          channelAccountId: seed.channelId,
          externalUserId: `bulk-${i}`,
        })),
      )
      .returning({ id: contactIdentities.id, contactId: contactIdentities.contactId });
    const base = Date.now() - 24 * 3600_000;
    const created = await db
      .insert(conversations)
      .values(
        identities.map((ident, i) => ({
          contactId: ident.contactId,
          channelAccountId: seed.channelId,
          contactIdentityId: ident.id,
          chatbotId: bot.id,
          aiMode: 'auto' as const,
          lastMessageAt: new Date(base + i * 60_000),
        })),
      )
      .returning({ id: conversations.id });
    const updates = spyUpdates();

    const res = await asAdmin('DELETE', `/chatbots/${bot.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ detachedConversations: total });
    const pushedIds = new Set(updates().map((u) => u.conversation.id));
    expect(pushedIds.size).toBe(DELETE_EMIT_LIMIT);
    // Mới nhất trước: 5 hội thoại cũ nhất (tạo đầu tiên) không được phát.
    expect(created.slice(0, 5).some((c) => pushedIds.has(c.id))).toBe(false);
    expect(created.slice(5).every((c) => pushedIds.has(c.id))).toBe(true);

    const ids = created.map((c) => c.id);
    await db.delete(conversations).where(inArray(conversations.id, ids));
  });

  it('PATCH /channels/:id nhận defaultChatbotId', async () => {
    const bot = await createBot({ name: 'Bot mặc định kênh' });
    const set = await asAdmin('PATCH', `/channels/${seed.channelId}`, { defaultChatbotId: bot.id });
    expect(set.statusCode).toBe(200);
    expect(set.json<ChannelAccountDto>().defaultChatbotId).toBe(bot.id);
    const unset = await asAdmin('PATCH', `/channels/${seed.channelId}`, { defaultChatbotId: null });
    expect(unset.json<ChannelAccountDto>().defaultChatbotId).toBeNull();
  });
});

describe('cài đặt', () => {
  it('giờ làm việc: mặc định, lưu, đọc lại; dữ liệu sai => 400', async () => {
    const initial = await asAdmin('GET', '/settings/business-hours');
    expect(initial.statusCode).toBe(200);
    expect(initial.json<BusinessHours>()).toEqual(DEFAULT_BUSINESS_HOURS);

    const custom: BusinessHours = {
      timezone: 'Asia/Ho_Chi_Minh',
      days: {
        ...DEFAULT_BUSINESS_HOURS.days,
        sat: [
          { start: '08:00', end: '12:00' },
          { start: '13:30', end: '17:00' },
        ],
        sun: [],
      },
    };
    expect((await asAdmin('PUT', '/settings/business-hours', custom)).json()).toEqual(custom);
    expect((await asAdmin('GET', '/settings/business-hours')).json()).toEqual(custom);

    const bad = await asAdmin('PUT', '/settings/business-hours', {
      ...custom,
      days: { ...custom.days, mon: [{ start: '18:00', end: '08:00' }] },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('Lark gửi thử khi CHƯA TỪNG lưu cấu hình ⇒ dùng webhook của env', async () => {
    larkReply = { status: 200, body: { code: 0, msg: 'success' } };
    const res = await asAdmin('POST', '/settings/lark/test');
    expect(res.statusCode).toBe(200);
    expect(larkCalls.map((c) => c.url)).toEqual([ENV_LARK_URL]);
  });

  it('Lark: secret không bao giờ trả ra (chỉ hasSecret), lưu mã hóa; bỏ secret = giữ, null = xóa', async () => {
    expect((await asAdmin('GET', '/settings/lark')).json()).toEqual({ webhookUrl: null, hasSecret: false });

    const saved = await asAdmin('PUT', '/settings/lark', { webhookUrl: LARK_URL, secret: LARK_SECRET });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<LarkSettingsDto>()).toEqual({ webhookUrl: LARK_URL, hasSecret: true });
    expect(saved.body).not.toContain(LARK_SECRET);

    const read = await asAdmin('GET', '/settings/lark');
    expect(read.json()).toEqual({ webhookUrl: LARK_URL, hasSecret: true });
    expect(read.body).not.toContain(LARK_SECRET);
    const [row] = await db.select().from(appSettings).where(eq(appSettings.key, 'lark'));
    expect(JSON.stringify(row?.value)).not.toContain(LARK_SECRET);

    const kept = await asAdmin('PUT', '/settings/lark', { webhookUrl: LARK_URL });
    expect(kept.json<LarkSettingsDto>().hasSecret).toBe(true);

    expect(
      (await asAdmin('PUT', '/settings/lark', { webhookUrl: 'http://khong-https.vn/hook' })).statusCode,
    ).toBe(400);
  });

  it('Lark gửi thử: dùng fetch giả, có chữ ký khi có secret; Lark từ chối => 502; chưa cấu hình => 400', async () => {
    await asAdmin('PUT', '/settings/lark', { webhookUrl: LARK_URL, secret: LARK_SECRET });
    larkReply = { status: 200, body: { code: 0, msg: 'success' } };
    const ok = await asAdmin('POST', '/settings/lark/test');
    expect(ok.statusCode).toBe(200);
    expect(larkCalls).toHaveLength(1);
    expect(larkCalls[0]!.url).toBe(LARK_URL);
    expect(larkCalls[0]!.body).toMatchObject({ msg_type: 'interactive' });
    expect(larkCalls[0]!.body.sign).toEqual(expect.any(String));
    expect(larkCalls[0]!.body.timestamp).toBeDefined();
    expect(JSON.stringify(larkCalls[0]!.body)).not.toContain(LARK_SECRET);

    larkReply = {
      status: 200,
      body: { code: 19021, msg: 'sign match fail or timestamp is not within one hour' },
    };
    const rejected = await asAdmin('POST', '/settings/lark/test');
    expect(rejected.statusCode).toBe(502);
    expect(rejected.body).not.toContain(LARK_SECRET);

    // Admin đã lưu webhook rỗng ⇒ Lark tắt (giống worker), KHÔNG quay về webhook của env.
    await asAdmin('PUT', '/settings/lark', { webhookUrl: null, secret: null });
    expect((await asAdmin('GET', '/settings/lark')).json()).toEqual({ webhookUrl: null, hasSecret: false });
    larkCalls.length = 0;
    const notConfigured = await asAdmin('POST', '/settings/lark/test');
    expect(notConfigured.statusCode).toBe(400);
    expect(larkCalls).toHaveLength(0);
    larkReply = { status: 200, body: { code: 0 } };
  });

  it('công tắc AI tổng: mặc định bật, tắt rồi đọc lại', async () => {
    expect((await asAdmin('GET', '/settings/ai')).json()).toEqual({ enabled: true });
    expect((await asAdmin('PUT', '/settings/ai', { enabled: false })).json()).toEqual({ enabled: false });
    expect((await asAdmin('GET', '/settings/ai')).json<AiSettings>()).toEqual({ enabled: false });
    expect((await asAdmin('PUT', '/settings/ai', { enabled: 'có' })).statusCode).toBe(400);
    await asAdmin('PUT', '/settings/ai', { enabled: true });
  });
});
