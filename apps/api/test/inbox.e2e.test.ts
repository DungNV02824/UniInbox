import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  INBOUND_JOB_NAME,
  type MediaStorage,
  type MessengerGraphApi,
  OUTBOUND_JOB_NAME,
  outboundJobId,
} from '@dezon/core';
import {
  type ChannelAccountDto,
  type ConversationSummary,
  type LoginResponse,
  type MessageCreatedPayload,
  type MessageDto,
  type Page,
  SOCKET_PATH,
  type UploadedMediaDto,
  type UserDirectoryEntry,
} from '@dezon/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Queue } from 'bullmq';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.factory';
import { loadAppConfig } from '../src/config';
import { INBOUND_QUEUE, OUTBOUND_QUEUE } from '../src/infra/queue/queue.constants';
import { type InboxSeed, PAGE_ID, seedInbox } from './inbox-seed';
import { ADMIN, AGENT, META, startInfra, type TestInfra } from './test-env';

// socket.io-client chỉ là dependency của web: nạp bản đã cài ở đó (không thêm dependency cho api).
interface Socket {
  on(event: string, listener: (...args: never[]) => void): Socket;
  once(event: string, listener: (...args: never[]) => void): Socket;
  close(): void;
}
const { io } = createRequire(join(__dirname, '../../web/package.json'))('socket.io-client') as {
  io: (url: string, options: Record<string, unknown>) => Socket;
};

const FIXTURE = readFileSync(join(__dirname, '__fixtures__', 'messenger-text-message.json'), 'utf8');
/** PNG 1x1 hợp lệ. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

/** MediaStorage trong bộ nhớ thay S3. */
function memoryStorage(): MediaStorage & { files: Map<string, { body: Buffer; contentType: string }> } {
  const files = new Map<string, { body: Buffer; contentType: string }>();
  const read = (key: string) => {
    const file = files.get(key);
    if (!file) throw new Error(`Không có ${key}`);
    return file.body;
  };
  return {
    files,
    put: async (key, body, contentType) => void files.set(key, { body, contentType }),
    get: async (key) => read(key),
    getStream: async () => {
      throw new Error('không dùng trong test');
    },
    delete: async (key) => void files.delete(key),
    signedUrl: async (key) => `https://s3.test/${key}?sig=test`,
    ping: async () => undefined,
  };
}

const fakeGraph: MessengerGraphApi = {
  getPage: async () => ({ id: '999888777666555', name: 'Trang thử nghiệm' }),
  subscribeApp: async () => undefined,
  unsubscribeApp: async () => undefined,
};

let infra: TestInfra;
let app: NestFastifyApplication;
let storage: ReturnType<typeof memoryStorage>;
let seed: InboxSeed;
let inbound: Queue;
let outbound: Queue;
let baseUrl: string;
let adminToken: string;
let agentToken: string;
const sockets: Socket[] = [];

beforeAll(async () => {
  infra = await startInfra();
  seed = await seedInbox(infra.databaseUrl);
  storage = memoryStorage();
  app = await createApp(undefined, { mediaStorage: storage, messengerGraph: fakeGraph });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  inbound = app.get(INBOUND_QUEUE);
  outbound = app.get(OUTBOUND_QUEUE);
  adminToken = await login(ADMIN.email, ADMIN.password);
  agentToken = await login(AGENT.email, AGENT.password);
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all([inbound.obliterate({ force: true }), outbound.obliterate({ force: true })]);
});

afterAll(async () => {
  await app?.close();
  await infra?.stop();
});

async function login(email: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return res.json<LoginResponse>().accessToken;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const sign = (body: string, secret = META.appSecret) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

const postWebhook = (body: string, signature?: string) =>
  app.inject({
    method: 'POST',
    url: '/webhooks/messenger',
    headers: {
      'content-type': 'application/json',
      ...(signature ? { 'x-hub-signature-256': signature } : {}),
    },
    payload: body,
  });

function connectSocket(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(baseUrl, {
      path: SOCKET_PATH,
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err: Error) => reject(err));
  });
}

function nextEvent<T>(socket: Socket, event: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Không nhận được ${event}`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function multipart(filename: string, contentType: string, data: Buffer, field = 'file') {
  const boundary = '----dezon-test-boundary';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([head, data, Buffer.from(`\r\n--${boundary}--\r\n`)]),
  };
}

describe('webhook Messenger', () => {
  it('GET: verify token đúng => 200 trả challenge dạng text; sai => 403', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: `/webhooks/messenger?hub.mode=subscribe&hub.verify_token=${META.verifyToken}&hub.challenge=1158201444`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('1158201444');
    expect(ok.headers['content-type']).toContain('text/plain');

    const wrong = await app.inject({
      method: 'GET',
      url: '/webhooks/messenger?hub.mode=subscribe&hub.verify_token=sai&hub.challenge=1158201444',
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.body).not.toContain('1158201444');
  });

  it('POST: thiếu hoặc sai chữ ký => 401 và không đẩy job', async () => {
    expect((await postWebhook(FIXTURE)).statusCode).toBe(401);
    expect((await postWebhook(FIXTURE, sign(FIXTURE, 'secret-khac'))).statusCode).toBe(401);
    // Chữ ký của body khác (bị sửa trên đường truyền).
    expect((await postWebhook(FIXTURE, sign(FIXTURE.replace('sofa', 'ghế')))).statusCode).toBe(401);
    expect(await inbound.count()).toBe(0);
  });

  it('POST: chữ ký đúng => 200 EVENT_RECEIVED < 1 giây, có đúng 1 job inbound (không cần worker)', async () => {
    const started = performance.now();
    const res = await postWebhook(FIXTURE, sign(FIXTURE));
    const elapsed = performance.now() - started;
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('EVENT_RECEIVED');
    expect(elapsed).toBeLessThan(1000);

    const jobs = await inbound.getJobs(['waiting']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.name).toBe(INBOUND_JOB_NAME);
    expect(jobs[0]!.data).toMatchObject({ channelType: 'messenger', payload: JSON.parse(FIXTURE) });
    expect(Date.parse(jobs[0]!.data.receivedAt)).not.toBeNaN();
    expect(jobs[0]!.opts).toMatchObject({ attempts: 5, backoff: { type: 'exponential', delay: 2000 } });
  });

  it('POST: object khác "page" => 200 nhưng bỏ qua', async () => {
    const body = JSON.stringify({ object: 'instagram', entry: [] });
    const res = await postWebhook(body, sign(body));
    expect(res.statusCode).toBe(200);
    expect(await inbound.count()).toBe(0);
  });

  it('POST: Redis lỗi khi đẩy job => 500 để Meta gửi lại', async () => {
    const spy = vi.spyOn(inbound, 'add').mockRejectedValueOnce(new Error('Connection is closed.'));
    try {
      const res = await postWebhook(FIXTURE, sign(FIXTURE));
      expect(res.statusCode).toBe(500);
    } finally {
      spy.mockRestore();
    }
  });

  it('webhook không cần JWT nhưng route khác vẫn cần', async () => {
    const res = await app.inject({ method: 'GET', url: '/conversations' });
    expect(res.statusCode).toBe(401);
  });

  it('body webhook được tới 5MB (route khác giữ 1MB); quá 5MB => 413', async () => {
    const padding = 'x'.repeat(2 * 1024 * 1024);
    const large = JSON.stringify({ object: 'page', entry: [], padding });
    const ok = await postWebhook(large, sign(large));
    expect(ok.statusCode).toBe(200);
    expect(await inbound.count()).toBe(1);

    const tooLarge = JSON.stringify({ object: 'page', entry: [], padding: padding.repeat(3) });
    expect((await postWebhook(tooLarge, sign(tooLarge))).statusCode).toBe(413);

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: ADMIN.email, password: padding }),
    });
    expect(login.statusCode).toBe(413);
  });

  it('chưa cấu hình Meta => webhook trả 503, app vẫn chạy', async () => {
    const noMeta = await createApp({
      ...loadAppConfig(),
      META_APP_SECRET: undefined,
      META_VERIFY_TOKEN: undefined,
    });
    try {
      const get = await noMeta.inject({
        method: 'GET',
        url: '/webhooks/messenger?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1',
      });
      expect(get.statusCode).toBe(503);
      expect(get.json()).toMatchObject({ message: expect.stringContaining('Chưa cấu hình Meta App') });
      const post = await noMeta.inject({
        method: 'POST',
        url: '/webhooks/messenger',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(FIXTURE) },
        payload: FIXTURE,
      });
      expect(post.statusCode).toBe(503);
    } finally {
      await noMeta.close();
    }
  });
});

describe('kênh và nhân viên', () => {
  it('agent không kết nối được Fanpage (403); admin kết nối được', async () => {
    const payload = { pageAccessToken: 'EAAB'.padEnd(40, 'x'), color: '#16a34a' };
    const denied = await app.inject({
      method: 'POST',
      url: '/channels/messenger',
      headers: bearer(agentToken),
      payload,
    });
    expect(denied.statusCode).toBe(403);

    const ok = await app.inject({
      method: 'POST',
      url: '/channels/messenger',
      headers: bearer(adminToken),
      payload,
    });
    expect(ok.statusCode).toBe(201);
    const channel = ok.json<ChannelAccountDto>();
    expect(channel).toMatchObject({ type: 'messenger', externalId: '999888777666555', status: 'connected' });
    expect(ok.body).not.toContain('EAAB');
  });

  it('GET /channels: mọi nhân viên xem được, không lộ credentials', async () => {
    const res = await app.inject({ method: 'GET', url: '/channels', headers: bearer(agentToken) });
    expect(res.statusCode).toBe(200);
    const list = res.json<ChannelAccountDto[]>();
    expect(list.map((c) => c.externalId)).toContain(PAGE_ID);
    expect(res.body).not.toMatch(/credentials|accessToken/i);
  });

  it('PATCH /channels/:id: id sai định dạng => 400; agent => 403', async () => {
    const bad = await app.inject({
      method: 'PATCH',
      url: '/channels/khong-phai-uuid',
      headers: bearer(adminToken),
      payload: { color: '#000000' },
    });
    expect(bad.statusCode).toBe(400);
    const denied = await app.inject({
      method: 'PATCH',
      url: `/channels/${seed.channelId}`,
      headers: bearer(agentToken),
      payload: { color: '#000000' },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('GET /users/directory: nhân viên đang hoạt động, không có email', async () => {
    const res = await app.inject({ method: 'GET', url: '/users/directory', headers: bearer(agentToken) });
    expect(res.statusCode).toBe(200);
    const list = res.json<UserDirectoryEntry[]>();
    expect(list.map((u) => u.name).sort()).toEqual([ADMIN.name, AGENT.name].sort());
    for (const entry of list) expect(Object.keys(entry).sort()).toEqual(['id', 'name', 'role']);
  });
});

describe('hội thoại', () => {
  it('GET /conversations theo quyền: admin thấy tất cả, agent thấy của mình + chưa phân công', async () => {
    const asAdmin = await app.inject({ method: 'GET', url: '/conversations', headers: bearer(adminToken) });
    expect(asAdmin.statusCode).toBe(200);
    const adminItems = asAdmin.json<Page<ConversationSummary>>().items;
    // contact.tags luôn có (mảng, [] khi khách chưa có tag).
    for (const c of adminItems) expect(c.contact.tags).toEqual([]);
    const adminIds = adminItems.map((c) => c.id);
    expect(adminIds).toEqual(
      expect.arrayContaining([
        seed.adminConversationId,
        seed.agentConversationId,
        seed.unassignedConversationId,
      ]),
    );

    const asAgent = await app.inject({ method: 'GET', url: '/conversations', headers: bearer(agentToken) });
    const agentIds = asAgent.json<Page<ConversationSummary>>().items.map((c) => c.id);
    expect(agentIds.sort()).toEqual([seed.agentConversationId, seed.unassignedConversationId].sort());
  });

  it('query sai => 400; id sai => 400; không tồn tại => 404; không có quyền => 403', async () => {
    const badQuery = await app.inject({
      method: 'GET',
      url: '/conversations?limit=1000',
      headers: bearer(adminToken),
    });
    expect(badQuery.statusCode).toBe(400);
    const badId = await app.inject({ method: 'GET', url: '/conversations/123', headers: bearer(adminToken) });
    expect(badId.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'GET',
      url: '/conversations/00000000-0000-4000-8000-000000000000',
      headers: bearer(adminToken),
    });
    expect(missing.statusCode).toBe(404);
    const forbidden = await app.inject({
      method: 'GET',
      url: `/conversations/${seed.adminConversationId}`,
      headers: bearer(agentToken),
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('GET /conversations/:id/messages => trang tin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/conversations/${seed.unassignedConversationId}/messages`,
      headers: bearer(agentToken),
    });
    expect(res.statusCode).toBe(200);
    const page = res.json<Page<MessageDto>>();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ senderType: 'customer', text: 'Xin chào, tôi là Chị Hoa' });
  });

  it('POST message => 201, có job outbound; socket admin nhận message.created, agent khác phòng thì không', async () => {
    const adminSocket = await connectSocket(adminToken);
    const agentSocket = await connectSocket(agentToken);
    const agentEvents: unknown[] = [];
    agentSocket.on('message.created', (payload: unknown) => agentEvents.push(payload));
    const created = nextEvent<MessageCreatedPayload>(adminSocket, 'message.created');

    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${seed.adminConversationId}/messages`,
      headers: bearer(adminToken),
      payload: { text: 'Dạ mẫu này còn hàng ạ', clientId: 'tmp-1' },
    });
    expect(res.statusCode).toBe(201);
    const { messages } = res.json<{ messages: MessageDto[] }>();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      senderType: 'agent',
      status: 'queued',
      text: 'Dạ mẫu này còn hàng ạ',
    });

    const event = await created;
    expect(event.message.id).toBe(messages[0]!.id);
    expect(event.conversation.id).toBe(seed.adminConversationId);

    const job = await outbound.getJob(outboundJobId(messages[0]!.id));
    expect(job?.name).toBe(OUTBOUND_JOB_NAME);
    expect(job?.data).toEqual({ messageId: messages[0]!.id });
    expect(job?.opts.attempts).toBe(3);

    await new Promise((r) => setTimeout(r, 300));
    expect(agentEvents).toHaveLength(0);
  });

  it('POST lại cùng clientId => trả tin cũ, không tạo tin/sự kiện mới, đẩy lại job còn thiếu', async () => {
    const send = () =>
      app.inject({
        method: 'POST',
        url: `/conversations/${seed.adminConversationId}/messages`,
        headers: bearer(adminToken),
        payload: { text: 'Gửi lại không được trùng', clientId: 'tmp-dup' },
      });
    const first = await send();
    expect(first.statusCode).toBe(201);
    const [original] = first.json<{ messages: MessageDto[] }>().messages;
    // Giả lập lần trước đẩy job lỗi (API trả 503 nhưng tin đã lưu queued).
    await outbound.obliterate({ force: true });

    const adminSocket = await connectSocket(adminToken);
    const events: unknown[] = [];
    adminSocket.on('message.created', (payload: unknown) => events.push(payload));
    const again = await send();
    expect(again.statusCode).toBe(201);
    const { messages } = again.json<{ messages: MessageDto[] }>();
    expect(messages.map((m) => m.id)).toEqual([original!.id]);
    expect(messages[0]).toMatchObject({ clientId: 'tmp-dup', status: 'queued' });
    expect((await outbound.getJob(outboundJobId(original!.id)))?.data).toEqual({ messageId: original!.id });
    expect(await outbound.count()).toBe(1);

    const list = await app.inject({
      method: 'GET',
      url: `/conversations/${seed.adminConversationId}/messages`,
      headers: bearer(adminToken),
    });
    const texts = list.json<Page<MessageDto>>().items.map((m) => m.text);
    expect(texts.filter((t) => t === 'Gửi lại không được trùng')).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(events).toHaveLength(0);
  });

  it('agent gửi vào hội thoại của admin => 403; body rỗng => 400', async () => {
    const forbidden = await app.inject({
      method: 'POST',
      url: `/conversations/${seed.adminConversationId}/messages`,
      headers: bearer(agentToken),
      payload: { text: 'xin chào' },
    });
    expect(forbidden.statusCode).toBe(403);
    const empty = await app.inject({
      method: 'POST',
      url: `/conversations/${seed.unassignedConversationId}/messages`,
      headers: bearer(agentToken),
      payload: { text: '   ' },
    });
    expect(empty.statusCode).toBe(400);
    expect(await outbound.count()).toBe(0);
  });

  it('PATCH (agent nhận hội thoại) => phát conversation.updated cho agent', async () => {
    const agentSocket = await connectSocket(agentToken);
    const updated = nextEvent<{ conversation: ConversationSummary }>(agentSocket, 'conversation.updated');
    const res = await app.inject({
      method: 'PATCH',
      url: `/conversations/${seed.unassignedConversationId}`,
      headers: bearer(agentToken),
      payload: { assignedUserId: seed.agentId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<ConversationSummary>().assignedUser?.id).toBe(seed.agentId);
    expect((await updated).conversation.id).toBe(seed.unassignedConversationId);
  });

  it('PATCH /contacts/:id đổi tên => phát conversation.updated có contact mới (kèm tags)', async () => {
    const agentSocket = await connectSocket(agentToken);
    const updated = nextEvent<{ conversation: ConversationSummary }>(agentSocket, 'conversation.updated');
    const detail = await app.inject({
      method: 'GET',
      url: `/conversations/${seed.agentConversationId}`,
      headers: bearer(agentToken),
    });
    const contactId = detail.json<ConversationSummary>().contact.id;
    const res = await app.inject({
      method: 'PATCH',
      url: `/contacts/${contactId}`,
      headers: bearer(agentToken),
      payload: { displayName: 'Khách đổi tên' },
    });
    expect(res.statusCode).toBe(200);
    const { conversation } = await updated;
    expect(conversation.id).toBe(seed.agentConversationId);
    expect(conversation.contact).toMatchObject({ id: contactId, displayName: 'Khách đổi tên', tags: [] });
  });

  it('POST /conversations/:id/read => unreadCount = 0', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${seed.agentConversationId}/read`,
      headers: bearer(agentToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<ConversationSummary>().unreadCount).toBe(0);
  });
});

describe('Socket.IO', () => {
  it('token sai hoặc thiếu => bị từ chối kết nối', async () => {
    await expect(connectSocket('rac.rac.rac')).rejects.toThrow('unauthorized');
    await expect(connectSocket('')).rejects.toThrow('unauthorized');
  });

  it('CORS chỉ cho APP_URL', async () => {
    const res = await fetch(`${baseUrl}${SOCKET_PATH}/?EIO=4&transport=polling`, {
      headers: { origin: 'http://localhost:3100' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3100');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });
});

describe('upload media', () => {
  it('ảnh hợp lệ => 201, lưu vào uploads/ và trả URL ký', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/media/uploads',
      headers: { ...bearer(agentToken), ...multipart('anh.png', 'image/png', PNG_1X1).headers },
      payload: multipart('anh.png', 'image/png', PNG_1X1).payload,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<UploadedMediaDto>();
    expect(body.storageKey).toMatch(/^uploads\//);
    expect(body).toMatchObject({ type: 'image', width: 1, height: 1 });
    expect(body.url).toContain(body.storageKey);
    expect(storage.files.has(body.storageKey)).toBe(true);
  });

  it('mime không cho phép hoặc nội dung giả => 415', async () => {
    const exe = multipart('virus.exe', 'application/x-msdownload', Buffer.from('MZ\x90\x00'));
    const res = await app.inject({
      method: 'POST',
      url: '/media/uploads',
      headers: { ...bearer(agentToken), ...exe.headers },
      payload: exe.payload,
    });
    expect(res.statusCode).toBe(415);

    const fake = multipart('anh.png', 'image/png', Buffer.from('khong phai anh'));
    const fakeRes = await app.inject({
      method: 'POST',
      url: '/media/uploads',
      headers: { ...bearer(agentToken), ...fake.headers },
      payload: fake.payload,
    });
    expect(fakeRes.statusCode).toBe(415);
  });

  it('tệp vượt MEDIA_MAX_UPLOAD_MB => 413; chưa đăng nhập => 401', async () => {
    const big = multipart('lon.png', 'image/png', Buffer.alloc(10 * 1024 * 1024 + 10, 1));
    const res = await app.inject({
      method: 'POST',
      url: '/media/uploads',
      headers: { ...bearer(agentToken), ...big.headers },
      payload: big.payload,
    });
    expect(res.statusCode).toBe(413);

    const anon = multipart('anh.png', 'image/png', PNG_1X1);
    const unauth = await app.inject({ method: 'POST', url: '/media/uploads', ...anon });
    expect(unauth.statusCode).toBe(401);
  });

  it('chưa cấu hình S3 => app vẫn chạy, upload trả 503', async () => {
    const noS3 = await createApp(undefined, { mediaStorage: null });
    try {
      const file = multipart('anh.png', 'image/png', PNG_1X1);
      const res = await noS3.inject({
        method: 'POST',
        url: '/media/uploads',
        headers: { ...bearer(agentToken), ...file.headers },
        payload: file.payload,
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await noS3.close();
    }
  });
});
