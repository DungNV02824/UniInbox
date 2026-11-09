// Kiểm thử nghiệm thu Giai đoạn 1A end-to-end với mock Graph API (không cần Facebook App thật).
// Điều kiện: mock-graph (cổng 4900) + api + worker đang chạy với
//   META_GRAPH_BASE_URL=http://localhost:4900 META_APP_ID=dev-app-id META_APP_SECRET=dev-app-secret
//   META_VERIFY_TOKEN=dev-verify-token
// Chạy:
//   pnpm --filter @dezon/worker exec tsx ../../scripts/e2e-1a.ts            (toàn bộ)
//   pnpm --filter @dezon/worker exec tsx ../../scripts/e2e-1a.ts --webhook-only   (j: thử khi worker tắt)
// Xem docs/TESTING-1A.md.
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import type { LoginResponse } from '../packages/shared/src/auth';
import type {
  ChannelAccountDto,
  ConversationDetail,
  ConversationSummary,
  MessageDto,
  Page,
} from '../packages/shared/src/inbox';
import type {
  ConversationUpdatedPayload,
  MessageCreatedPayload,
  MessageUpdatedPayload,
} from '../packages/shared/src/realtime';

const USAGE = `Kiểm thử nghiệm thu 1A (mock Graph). Cần mock-graph + api + worker đang chạy (docs/TESTING-1A.md).

Cách dùng:
  pnpm --filter @dezon/worker exec tsx ../../scripts/e2e-1a.ts [--api <url>] [--mock <url>]
      [--sync-wait <giây>] [--no-sync] [--webhook-only [--wait <giây>]]

  --api <url>      URL API (mặc định E2E_API_URL hoặc http://localhost:4000)
  --mock <url>     URL mock-graph (mặc định E2E_MOCK_URL hoặc http://localhost:4900)
  --sync-wait <s>  Thời gian chờ tối đa cho mỗi bước đồng bộ (mặc định 30; worker nên chạy với
                   MESSENGER_SYNC_INTERVAL_SEC=5 để bước đồng bộ định kỳ nhanh)
  --no-sync        Bỏ qua các bước đồng bộ hội thoại (s1..s4)

  --webhook-only   Chỉ POST 1 webhook, đo thời gian phản hồi, rồi chờ worker xử lý (mặc định 60s).
                   Dùng để thử "worker tắt vẫn trả 200": tắt worker -> chạy lệnh này -> bật lại worker.
  --wait <giây>    Thời gian chờ xử lý ở chế độ --webhook-only (mặc định 60)

Biến môi trường (tuỳ chọn): E2E_API_URL (http://localhost:4000), E2E_MOCK_URL (http://localhost:4900),
  META_APP_ID (dev-app-id), META_APP_SECRET (dev-app-secret), META_VERIFY_TOKEN (dev-verify-token),
  META_GRAPH_VERSION (v26.0), DATABASE_URL (đọc từ .env nếu không đặt),
  E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD (admin@dezon.vn / Dezon@2026), E2E_AGENT_EMAIL/E2E_AGENT_PASSWORD
  (sale@dezon.vn / Sale@2026).`;

// ---------- Cấu hình ----------

function findRepoRoot(start: string): string {
  let dir = start;
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Không tìm thấy thư mục gốc repo (pnpm-workspace.yaml)');
    dir = parent;
  }
  return dir;
}

const ROOT = findRepoRoot(process.cwd());
const FILE_ENV: Record<string, string | undefined> = existsSync(join(ROOT, '.env'))
  ? parseEnv(readFileSync(join(ROOT, '.env'), 'utf8'))
  : {};

const env = (key: string, fallback: string) => process.env[key] || fallback;

const CFG = {
  api: env('E2E_API_URL', 'http://localhost:4000').replace(/\/+$/, ''),
  mock: env('E2E_MOCK_URL', 'http://localhost:4900').replace(/\/+$/, ''),
  appId: env('META_APP_ID', 'dev-app-id'),
  appSecret: env('META_APP_SECRET', 'dev-app-secret'),
  verifyToken: env('META_VERIFY_TOKEN', 'dev-verify-token'),
  graphVersion: env('META_GRAPH_VERSION', 'v26.0'),
  databaseUrl: process.env.DATABASE_URL || FILE_ENV.DATABASE_URL || '',
  admin: {
    email: env('E2E_ADMIN_EMAIL', 'admin@dezon.vn'),
    password: env('E2E_ADMIN_PASSWORD', 'Dezon@2026'),
  },
  agent: { email: env('E2E_AGENT_EMAIL', 'sale@dezon.vn'), password: env('E2E_AGENT_PASSWORD', 'Sale@2026') },
};

/** Token Page của mock (API yêu cầu >= 20 ký tự). */
const TOKEN_A = 'PAGE_TOKEN_A_DEZON_DESIGN_MOCK';
const TOKEN_B = 'PAGE_TOKEN_B_DEZON_SHOP_MOCK';
const USER_TOKEN_LONG = 'USER_TOKEN_DEZON_ADMIN_MOCK';
const EXPIRED_TOKEN_LONG = 'EXPIRED_PAGE_TOKEN_DEZON_MOCK';
const BUSINESS_SUITE_APP_ID = 263902037430900;
const SEND_METADATA = 'dezon-inbox';
const COLOR_A = '#e11d48';
const COLOR_B = '#2563eb';

const RUN = Date.now().toString(36);
let psidSeq = 0;
/** PSID mới, dạng số như Meta. */
const newPsid = () => `${Date.now()}${String(++psidSeq).padStart(3, '0')}`;
let midSeq = 0;
const newMid = () => `m_e2e_${RUN}_${++midSeq}`;

// ---------- Thư viện nạp từ workspace (không thêm dependency) ----------

interface IoSocket {
  connected: boolean;
  on(event: string, listener: (arg: never) => void): IoSocket;
  once(event: string, listener: (arg: never) => void): IoSocket;
  close(): void;
}
type IoFactory = (url: string, options: Record<string, unknown>) => IoSocket;

interface PgClient {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null }>;
  end(): Promise<void>;
}
type PgClientCtor = new (config: { connectionString: string }) => PgClient;

const requireFrom = (pkgJson: string) => createRequire(join(ROOT, pkgJson));
const loadIo = () => (requireFrom('apps/web/package.json')('socket.io-client') as { io: IoFactory }).io;
const loadPg = () => (requireFrom('packages/db/package.json')('pg') as { Client: PgClientCtor }).Client;

// ---------- Kết quả ----------

class SkipError extends Error {}
const skip = (reason: string): never => {
  throw new SkipError(reason);
};

interface Result {
  id: string;
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  ms: number;
  detail: string;
}
const results: Result[] = [];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function check(id: string, name: string, fn: () => Promise<string | void>): Promise<boolean> {
  const started = Date.now();
  let status: Result['status'] = 'PASS';
  let detail = '';
  try {
    detail = (await fn()) ?? '';
  } catch (err) {
    status = err instanceof SkipError ? 'SKIP' : 'FAIL';
    detail = err instanceof Error ? err.message : String(err);
  }
  const ms = Date.now() - started;
  results.push({ id, name, status, ms, detail });
  const time = `(${ms}ms)`.padStart(9);
  console.log(`${status.padEnd(4)} ${id.padEnd(3)} ${name.padEnd(58)} ${time}${detail ? `  ${detail}` : ''}`);
  return status === 'PASS';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- HTTP ----------

interface ApiRes<T> {
  status: number;
  body: T;
  ms: number;
}

async function http<T>(url: string, init: RequestInit = {}): Promise<ApiRes<T>> {
  const started = Date.now();
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, body: body as T, ms: Date.now() - started };
}

function api<T>(method: string, path: string, token?: string, body?: unknown): Promise<ApiRes<T>> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return http<T>(`${CFG.api}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const errMsg = (res: ApiRes<unknown>) => {
  const b = res.body as { message?: unknown } | undefined;
  return `HTTP ${res.status}${b && typeof b === 'object' && typeof b.message === 'string' ? `: ${b.message}` : ''}`;
};

// ---------- Webhook ----------

/** Escape ký tự ngoài ASCII như Meta (chữ ký tính trên đúng bytes gửi đi). */
function metaJson(payload: unknown): string {
  return JSON.stringify(payload).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

async function postWebhook(payload: unknown, secret = CFG.appSecret): Promise<ApiRes<string>> {
  const body = metaJson(payload);
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  return http<string>(`${CFG.api}/webhooks/messenger`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body,
  });
}

const envelope = (pageId: string, events: unknown[]) => ({
  object: 'page',
  entry: [{ id: pageId, time: Date.now(), messaging: events }],
});

const customerEvent = (pageId: string, psid: string, extra: Record<string, unknown>) => ({
  sender: { id: psid },
  recipient: { id: pageId },
  timestamp: Date.now(),
  ...extra,
});

function customerText(pageId: string, psid: string, text: string, mid = newMid()) {
  return envelope(pageId, [customerEvent(pageId, psid, { message: { mid, text } })]);
}

function echoText(
  pageId: string,
  psid: string,
  appId: string | number,
  mid: string,
  text: string,
  metadata?: string,
) {
  const message: Record<string, unknown> = { mid, is_echo: true, app_id: appId, text };
  if (metadata) message.metadata = metadata;
  return envelope(pageId, [
    { sender: { id: pageId }, recipient: { id: psid }, timestamp: Date.now(), message },
  ]);
}

async function expectWebhook200(payload: unknown): Promise<number> {
  const res = await postWebhook(payload);
  assert(res.status === 200, `webhook trả ${res.status} (${String(res.body).slice(0, 120)})`);
  return res.ms;
}

// ---------- Socket ----------

interface LoggedEvent {
  event: string;
  payload: unknown;
  at: number;
}

class SocketLog {
  readonly events: LoggedEvent[] = [];
  private waiters: Array<{
    event: string;
    pred: (p: unknown) => boolean;
    resolve: (e: LoggedEvent) => void;
  }> = [];
  constructor(
    readonly label: string,
    readonly socket: IoSocket,
  ) {
    for (const event of ['message.created', 'message.updated', 'conversation.updated']) {
      socket.on(event, (payload: never) => this.push({ event, payload, at: Date.now() }));
    }
  }

  private push(e: LoggedEvent): void {
    this.events.push(e);
    this.waiters = this.waiters.filter((w) => {
      if (w.event !== e.event || !w.pred(e.payload)) return true;
      w.resolve(e);
      return false;
    });
  }

  /** Mốc để chỉ xét sự kiện đến sau thời điểm này. */
  mark(): number {
    return this.events.length;
  }

  count<T>(event: string, pred: (p: T) => boolean, since = 0): number {
    return this.events.slice(since).filter((e) => e.event === event && pred(e.payload as T)).length;
  }

  waitFor<T>(event: string, pred: (p: T) => boolean, timeoutMs: number, since = 0): Promise<T> {
    const found = this.events.slice(since).find((e) => e.event === event && pred(e.payload as T));
    if (found) return Promise.resolve(found.payload as T);
    return new Promise<T>((resolve, reject) => {
      const waiter = {
        event,
        pred: (p: unknown) => pred(p as T),
        resolve: (e: LoggedEvent) => {
          clearTimeout(timer);
          resolve(e.payload as T);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`${this.label}: không nhận ${event} trong ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  close(): void {
    this.socket.close();
  }
}

function connectSocket(label: string, token: string): Promise<SocketLog> {
  const io = loadIo();
  const socket = io(CFG.api, {
    path: '/socket.io',
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
    timeout: 5_000,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`${label}: socket không kết nối được trong 5s`));
    }, 5_000);
    const log = new SocketLog(label, socket);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(log);
    });
    socket.once('connect_error', (err: never) => {
      clearTimeout(timer);
      socket.close();
      reject(new Error(`${label}: connect_error ${(err as Error).message}`));
    });
  });
}

// ---------- Mock ----------

interface MockCall {
  method: string;
  path: string;
  version: string | null;
  pageId?: string;
  status: number;
  body?: Record<string, unknown>;
  response?: Record<string, unknown>;
}

async function mockCalls(path: string, method?: string): Promise<MockCall[]> {
  const q = new URLSearchParams({ path, ...(method ? { method } : {}) });
  const res = await http<{ calls: MockCall[] }>(`${CFG.mock}/__calls?${q}`);
  return res.body.calls;
}

async function mockGraphGet<T>(path: string, token: string): Promise<T> {
  const res = await http<T>(`${CFG.mock}/${CFG.graphVersion}/${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert(res.status === 200, `mock ${path} trả ${res.status}`);
  return res.body;
}

// ---------- Trạng thái dùng chung giữa các bước ----------

interface Session {
  token: string;
  user: LoginResponse['user'];
}

const S: {
  admin?: Session;
  agent?: Session;
  pageA?: { id: string; name: string };
  pageB?: { id: string; name: string };
  chA?: ChannelAccountDto;
  chB?: ChannelAccountDto;
  adminSock?: SocketLog;
  agentSock?: SocketLog;
  psidA?: string;
  convA?: ConversationSummary;
  psidB?: string;
  convB?: ConversationSummary;
  reply?: { message: MessageDto; mid: string; text: string };
  syncWaitMs: number;
} = { syncWaitMs: 30_000 };

const need = <T>(value: T | undefined, what: string): T => value ?? skip(`thiếu ${what} từ bước trước`);

async function login(email: string, password: string): Promise<Session> {
  const res = await api<LoginResponse>('POST', '/auth/login', undefined, { email, password });
  assert(res.status === 200, `đăng nhập ${email}: ${errMsg(res)}`);
  return { token: res.body.accessToken, user: res.body.user };
}

async function messagesOf(token: string, conversationId: string): Promise<MessageDto[]> {
  const res = await api<Page<MessageDto>>(
    'GET',
    `/conversations/${conversationId}/messages?limit=100`,
    token,
  );
  assert(res.status === 200, `GET messages: ${errMsg(res)}`);
  return res.body.items;
}

async function listConversations(token: string): Promise<ConversationSummary[]> {
  const res = await api<Page<ConversationSummary>>('GET', '/conversations?limit=100', token);
  assert(res.status === 200, `GET /conversations: ${errMsg(res)}`);
  return res.body.items;
}

// ---------- Các bước ----------

async function stepLogin(): Promise<string> {
  S.admin = await login(CFG.admin.email, CFG.admin.password);
  S.agent = await login(CFG.agent.email, CFG.agent.password);
  assert(S.admin.user.role === 'admin', `vai trò admin = ${S.admin.user.role}`);
  assert(S.agent.user.role === 'agent', `vai trò agent = ${S.agent.user.role}`);
  return `admin=${S.admin.user.email} agent=${S.agent.user.email}`;
}

async function connectPage(token: string, pageToken: string, color: string): Promise<ChannelAccountDto> {
  const res = await api<ChannelAccountDto>('POST', '/channels/messenger', token, {
    pageAccessToken: pageToken,
    color,
  });
  assert(res.status === 201, `POST /channels/messenger: ${errMsg(res)}`);
  let ch = res.body;
  if (ch.color.toLowerCase() !== color) {
    const patched = await api<ChannelAccountDto>('PATCH', `/channels/${ch.id}`, token, { color });
    assert(patched.status === 200, `PATCH màu: ${errMsg(patched)}`);
    ch = patched.body;
  }
  return ch;
}

async function stepChannels(): Promise<string> {
  const admin = need(S.admin, 'phiên admin');
  S.pageA = await mockGraphGet<{ id: string; name: string }>('me?fields=id,name,category', TOKEN_A);
  S.pageB = await mockGraphGet<{ id: string; name: string }>('me?fields=id,name,category', TOKEN_B);
  const a = await connectPage(admin.token, TOKEN_A, COLOR_A);
  const b = await connectPage(admin.token, TOKEN_B, COLOR_B);
  assert(a.externalId === S.pageA.id, `kênh A externalId=${a.externalId}`);
  assert(b.externalId === S.pageB.id, `kênh B externalId=${b.externalId}`);

  const list = await api<ChannelAccountDto[]>('GET', '/channels', admin.token);
  assert(list.status === 200, `GET /channels: ${errMsg(list)}`);
  const chA = list.body.find((c) => c.type === 'messenger' && c.externalId === S.pageA?.id);
  const chB = list.body.find((c) => c.type === 'messenger' && c.externalId === S.pageB?.id);
  assert(chA && chB, 'GET /channels thiếu kênh A hoặc B');
  assert(
    chA.status === 'connected' && chB.status === 'connected',
    `trạng thái A=${chA.status} B=${chB.status}`,
  );
  assert(chA.color.toLowerCase() === COLOR_A && chB.color.toLowerCase() === COLOR_B, 'màu kênh không đúng');
  S.chA = chA;
  S.chB = chB;

  const subs = await mockCalls('/subscribed_apps', 'POST');
  const subscribed = new Set(subs.filter((c) => c.status === 200).map((c) => c.pageId));
  assert(
    subscribed.has(chA.externalId) && subscribed.has(chB.externalId),
    'mock không thấy POST subscribed_apps cho cả 2 Page',
  );
  return `A="${chA.displayName}" ${chA.color}, B="${chB.displayName}" ${chB.color}`;
}

async function stepSockets(): Promise<string> {
  const admin = need(S.admin, 'phiên admin');
  const agent = need(S.agent, 'phiên agent');
  S.adminSock = await connectSocket('admin', admin.token);
  S.agentSock = await connectSocket('agent', agent.token);
  return 'admin + agent đã kết nối';
}

/** Gửi tin text của khách mới tới page, kiểm cả 2 socket nhận message.created trong 3s và nhãn hội thoại. */
async function inboundToPage(ch: ChannelAccountDto, pageToken: string, label: string) {
  const adminSock = need(S.adminSock, 'socket admin');
  const agentSock = need(S.agentSock, 'socket agent');
  const admin = need(S.admin, 'phiên admin');
  const psid = newPsid();
  const text = `E2E ${RUN} ${label}: Chào shop, mình cần tư vấn thiết kế phòng khách`;
  const since = [adminSock.mark(), agentSock.mark()] as const;
  const started = Date.now();
  await expectWebhook200(customerText(ch.externalId, psid, text));
  const match = (p: MessageCreatedPayload) => p.message.text === text;
  const [onAdmin, onAgent] = await Promise.all([
    adminSock.waitFor<MessageCreatedPayload>('message.created', match, 3_000, since[0]),
    agentSock.waitFor<MessageCreatedPayload>('message.created', match, 3_000, since[1]),
  ]);
  const latency = Date.now() - started;
  const conv = onAdmin.conversation;
  assert(onAgent.conversation.id === conv.id, 'admin và agent nhận khác hội thoại');
  assert(onAdmin.message.senderType === 'customer', `senderType=${onAdmin.message.senderType}`);
  assert(conv.channel.id === ch.id, `channel.id=${conv.channel.id} (mong đợi ${ch.id})`);
  assert(conv.channel.displayName === ch.displayName, `channel.displayName="${conv.channel.displayName}"`);
  assert(conv.channel.color.toLowerCase() === ch.color.toLowerCase(), `channel.color=${conv.channel.color}`);

  const profile = await mockGraphGet<{ name: string }>(`${psid}?fields=name`, pageToken);
  assert(
    conv.contact.displayName === profile.name,
    `contact="${conv.contact.displayName}" (mock: "${profile.name}")`,
  );
  let avatarNote = 'avatar trong payload';
  if (!conv.contact.avatarUrl) {
    const detail = await api<ConversationDetail>('GET', `/conversations/${conv.id}`, admin.token);
    assert(detail.status === 200, `GET conversation: ${errMsg(detail)}`);
    assert(detail.body.contact.avatarUrl, 'contact.avatarUrl null (cả payload realtime lẫn REST)');
    avatarNote = 'avatar chỉ có qua REST (payload realtime null)';
  }
  const profileCalls = await mockCalls(`/${psid}`, 'GET');
  assert(
    profileCalls.some((c) => c.pageId === ch.externalId),
    'mock không thấy gọi User Profile bằng token của đúng Page',
  );
  return { psid, conv, detail: `${latency}ms, khách "${conv.contact.displayName}", ${avatarNote}` };
}

async function stepInboundA(): Promise<string> {
  const r = await inboundToPage(need(S.chA, 'kênh A'), TOKEN_A, 'A');
  S.psidA = r.psid;
  S.convA = r.conv;
  return r.detail;
}

async function stepInboundB(): Promise<string> {
  const r = await inboundToPage(need(S.chB, 'kênh B'), TOKEN_B, 'B');
  S.psidB = r.psid;
  S.convB = r.conv;
  const a = need(S.convA, 'hội thoại A');
  assert(a.channel.id !== r.conv.channel.id, 'hai hội thoại cùng kênh');
  assert(a.channel.color !== r.conv.channel.color, 'hai nhãn cùng màu');
  assert(a.channel.displayName !== r.conv.channel.displayName, 'hai nhãn cùng tên');
  return `${r.detail}; nhãn A≠B`;
}

async function stepDuplicate(): Promise<string> {
  const ch = need(S.chA, 'kênh A');
  const psid = need(S.psidA, 'PSID A');
  const conv = need(S.convA, 'hội thoại A');
  const sock = need(S.adminSock, 'socket admin');
  const admin = need(S.admin, 'phiên admin');
  const text = `E2E ${RUN} tin trùng mid`;
  const payload = customerText(ch.externalId, psid, text, newMid());
  const since = sock.mark();
  await expectWebhook200(payload);
  await expectWebhook200(payload);
  await sock.waitFor<MessageCreatedPayload>('message.created', (p) => p.message.text === text, 3_000, since);
  await sleep(1_500);
  const count = (await messagesOf(admin.token, conv.id)).filter((m) => m.text === text).length;
  const events = sock.count<MessageCreatedPayload>('message.created', (p) => p.message.text === text, since);
  assert(count === 1, `có ${count} tin trong DB (mong đợi 1)`);
  assert(events === 1, `nhận ${events} sự kiện message.created (mong đợi 1)`);
  return '1 tin, 1 sự kiện';
}

async function stepImage(): Promise<string> {
  const ch = need(S.chA, 'kênh A');
  const psid = need(S.psidA, 'PSID A');
  const conv = need(S.convA, 'hội thoại A');
  const sock = need(S.adminSock, 'socket admin');
  const sourceUrl = `${CFG.mock}/avatar/e2e-${RUN}.png`;
  const since = sock.mark();
  const payload = envelope(ch.externalId, [
    customerEvent(ch.externalId, psid, {
      message: { mid: newMid(), attachments: [{ type: 'image', payload: { url: sourceUrl } }] },
    }),
  ]);
  await expectWebhook200(payload);
  const created = await sock.waitFor<MessageCreatedPayload>(
    'message.created',
    (p) => p.message.conversationId === conv.id && p.message.attachments.length > 0,
    8_000,
    since,
  );
  const att = created.message.attachments[0];
  assert(att, 'không có attachment');
  assert(att.type === 'image', `attachment.type=${att.type}`);
  assert(att.url, 'attachment.url null (chưa lưu được về S3)');
  assert(!att.url.startsWith(CFG.mock), 'attachment.url trỏ về URL gốc (mock) chứ không phải S3');
  const res = await fetch(att.url, { signal: AbortSignal.timeout(10_000) });
  const type = res.headers.get('content-type') ?? '';
  const size = (await res.arrayBuffer()).byteLength;
  assert(res.status === 200, `GET URL ký trả ${res.status}`);
  assert(type.startsWith('image/'), `content-type=${type}`);
  const host = new URL(att.url).host;
  return `S3 ${host}, ${type}, ${size} byte${att.width ? `, ${att.width}x${att.height}` : ''}`;
}

async function stepReply(): Promise<string> {
  const conv = need(S.convA, 'hội thoại A');
  const ch = need(S.chA, 'kênh A');
  const psid = need(S.psidA, 'PSID A');
  const admin = need(S.admin, 'phiên admin');
  const sock = need(S.adminSock, 'socket admin');
  const text = `E2E ${RUN} Dạ shop chào anh/chị, em gửi báo giá ạ`;
  const since = sock.mark();
  const res = await api<{ messages: MessageDto[] }>(
    'POST',
    `/conversations/${conv.id}/messages`,
    admin.token,
    {
      text,
      clientId: `e2e-${RUN}`,
    },
  );
  assert(res.status === 201, `POST messages: ${errMsg(res)}`);
  const msg = res.body.messages[0];
  assert(msg, 'API không trả tin vừa tạo');
  const started = Date.now();
  const updated = await sock.waitFor<MessageUpdatedPayload>(
    'message.updated',
    (p) => p.message.id === msg.id && p.message.status !== 'queued',
    5_000,
    since,
  );
  assert(
    updated.message.status === 'sent',
    `status=${updated.message.status} ${updated.message.error ?? ''}`,
  );
  const sentIn = Date.now() - started;

  const calls = await mockCalls('/messages', 'POST');
  const call = calls.find((c) => (c.body?.message as { text?: unknown } | undefined)?.text === text);
  assert(call, 'mock không thấy Send API call với nội dung trả lời');
  assert(call.version === CFG.graphVersion, `version=${call.version}`);
  assert(call.pageId === ch.externalId, `page=${call.pageId}`);
  assert((call.body?.recipient as { id?: unknown } | undefined)?.id === psid, 'recipient sai');
  assert(call.body?.messaging_type === 'RESPONSE', `messaging_type=${String(call.body?.messaging_type)}`);
  const mid = call.response?.message_id;
  assert(typeof mid === 'string', 'mock không trả message_id');
  S.reply = { message: updated.message, mid, text };
  return `sent sau ${sentIn}ms, ${call.method} ${call.path} RESPONSE, mid=${mid}`;
}

async function stepBusinessSuiteEcho(): Promise<string> {
  const ch = need(S.chA, 'kênh A');
  const psid = need(S.psidA, 'PSID A');
  const conv = need(S.convA, 'hội thoại A');
  const sock = need(S.adminSock, 'socket admin');
  const admin = need(S.admin, 'phiên admin');
  const text = `E2E ${RUN} trả lời từ Meta Business Suite`;
  const payload = echoText(ch.externalId, psid, BUSINESS_SUITE_APP_ID, newMid(), text);
  const since = sock.mark();
  await expectWebhook200(payload);
  await expectWebhook200(payload);
  const created = await sock.waitFor<MessageCreatedPayload>(
    'message.created',
    (p) => p.message.text === text,
    3_000,
    since,
  );
  assert(created.message.senderType === 'agent', `senderType=${created.message.senderType}`);
  assert(created.message.senderLabel === 'Meta Business Suite', `senderLabel=${created.message.senderLabel}`);
  await sleep(1_500);
  const count = (await messagesOf(admin.token, conv.id)).filter((m) => m.text === text).length;
  assert(count === 1, `có ${count} tin (mong đợi 1)`);
  return 'agent / "Meta Business Suite", không trùng';
}

async function stepOwnEcho(): Promise<string> {
  const ch = need(S.chA, 'kênh A');
  const psid = need(S.psidA, 'PSID A');
  const conv = need(S.convA, 'hội thoại A');
  const admin = need(S.admin, 'phiên admin');
  const reply = need(S.reply, 'tin trả lời ở bước g');
  await expectWebhook200(echoText(ch.externalId, psid, CFG.appId, reply.mid, reply.text, SEND_METADATA));
  await sleep(2_000);
  const same = (await messagesOf(admin.token, conv.id)).filter((m) => m.text === reply.text);
  assert(same.length === 1, `có ${same.length} tin cùng nội dung (mong đợi 1)`);
  assert(same[0]?.id === reply.message.id, 'tin còn lại không phải tin gốc');
  return `echo app_id=${CFG.appId} mid=${reply.mid} không tạo tin mới`;
}

async function stepDeliveryRead(): Promise<string> {
  const ch = need(S.chA, 'kênh A');
  const psid = need(S.psidA, 'PSID A');
  const sock = need(S.adminSock, 'socket admin');
  const reply = need(S.reply, 'tin trả lời ở bước g');
  let since = sock.mark();
  await expectWebhook200(
    envelope(ch.externalId, [
      customerEvent(ch.externalId, psid, { delivery: { mids: [reply.mid], watermark: Date.now() } }),
    ]),
  );
  await sock.waitFor<MessageUpdatedPayload>(
    'message.updated',
    (p) => p.message.id === reply.message.id && p.message.status === 'delivered',
    3_000,
    since,
  );
  since = sock.mark();
  await sleep(50);
  await expectWebhook200(
    envelope(ch.externalId, [customerEvent(ch.externalId, psid, { read: { watermark: Date.now() } })]),
  );
  await sock.waitFor<MessageUpdatedPayload>(
    'message.updated',
    (p) => p.message.id === reply.message.id && p.message.status === 'seen',
    3_000,
    since,
  );
  return 'delivered -> seen';
}

async function stepOutsideWindow(): Promise<string> {
  const conv = need(S.convB, 'hội thoại B');
  const admin = need(S.admin, 'phiên admin');
  if (!CFG.databaseUrl) skip('thiếu DATABASE_URL');
  const Client = loadPg();
  const pg = new Client({ connectionString: CFG.databaseUrl });
  await pg.connect();
  try {
    const r = await pg.query(
      `UPDATE conversations SET last_customer_message_at = now() - interval '25 hours' WHERE id = $1`,
      [conv.id],
    );
    assert(r.rowCount === 1, `UPDATE ảnh hưởng ${r.rowCount} dòng`);
  } finally {
    await pg.end();
  }
  const res = await api<{ message?: string }>('POST', `/conversations/${conv.id}/messages`, admin.token, {
    text: `E2E ${RUN} tin ngoài cửa sổ`,
  });
  assert(res.status === 422, `POST messages trả ${errMsg(res)} (mong đợi 422)`);
  const reason = res.body?.message;
  assert(typeof reason === 'string' && reason.length > 0, '422 không có lý do');
  const detail = await api<ConversationDetail>('GET', `/conversations/${conv.id}`, admin.token);
  assert(detail.status === 200, `GET conversation: ${errMsg(detail)}`);
  assert(detail.body.sendWindow.allowed === false, 'sendWindow.allowed vẫn true');
  return `422 "${reason}"`;
}

async function stepWebhookLatency(): Promise<string> {
  const ch = need(S.chA, 'kênh A');
  const sock = need(S.adminSock, 'socket admin');
  const psid = newPsid();
  const times: number[] = [];
  let lastText = '';
  const since = sock.mark();
  for (let i = 1; i <= 5; i++) {
    lastText = `E2E ${RUN} đo độ trễ webhook #${i}`;
    times.push(await expectWebhook200(customerText(ch.externalId, psid, lastText)));
  }
  const max = Math.max(...times);
  assert(max < 1_000, `webhook chậm nhất ${max}ms (>= 1000ms)`);
  const text = lastText;
  await sock.waitFor<MessageCreatedPayload>('message.created', (p) => p.message.text === text, 10_000, since);
  return `5 lần: ${times.join('/')}ms (max ${max}ms); worker đã xử lý`;
}

async function stepRbac(): Promise<string> {
  const admin = need(S.admin, 'phiên admin');
  const agent = need(S.agent, 'phiên agent');
  const conv = need(S.convA, 'hội thoại A');
  const agentSock = need(S.agentSock, 'socket agent');

  const denied = await api('POST', '/channels/messenger', agent.token, { pageAccessToken: TOKEN_A });
  assert(denied.status === 403, `agent POST /channels/messenger trả ${denied.status} (mong đợi 403)`);

  const before = await listConversations(agent.token);
  assert(
    before.some((c) => c.id === conv.id),
    'agent không thấy hội thoại chưa phân công',
  );

  const since = agentSock.mark();
  const patched = await api<ConversationSummary>('PATCH', `/conversations/${conv.id}`, admin.token, {
    assignedUserId: admin.user.id,
  });
  assert(patched.status === 200, `PATCH phân công: ${errMsg(patched)}`);
  assert(patched.body.assignedUser?.id === admin.user.id, 'assignedUser không phải admin');
  await agentSock.waitFor<ConversationUpdatedPayload>(
    'conversation.updated',
    (p) => p.conversation.id === conv.id,
    3_000,
    since,
  );
  const after = await listConversations(agent.token);
  assert(!after.some((c) => c.id === conv.id), 'agent vẫn thấy hội thoại đã phân công cho admin');
  const direct = await api('GET', `/conversations/${conv.id}`, agent.token);
  assert(
    direct.status === 403 || direct.status === 404,
    `agent GET hội thoại của admin trả ${direct.status}`,
  );
  return `403 kết nối kênh; thấy rồi mất sau phân công; nhận conversation.updated; GET trực tiếp ${direct.status}`;
}

// ---------- Kiểm tra bổ sung ----------

async function extraWebhookSecurity(): Promise<string> {
  const ch = need(S.chA, 'kênh A');
  const bad = await postWebhook(customerText(ch.externalId, newPsid(), 'chữ ký sai'), 'wrong-secret');
  assert(bad.status === 401 || bad.status === 403, `chữ ký sai trả ${bad.status}`);
  const q = (token: string) =>
    new URLSearchParams({
      'hub.mode': 'subscribe',
      'hub.verify_token': token,
      'hub.challenge': '1158201444',
    });
  const ok = await http<string>(`${CFG.api}/webhooks/messenger?${q(CFG.verifyToken)}`);
  assert(
    ok.status === 200 && String(ok.body) === '1158201444',
    `verify đúng token trả ${ok.status} "${String(ok.body)}"`,
  );
  const wrong = await http<string>(`${CFG.api}/webhooks/messenger?${q('sai-token')}`);
  assert(wrong.status === 403, `verify sai token trả ${wrong.status}`);
  return `chữ ký sai ${bad.status}; hub.challenge OK; verify sai 403`;
}

async function extraBadTokens(): Promise<string> {
  const admin = need(S.admin, 'phiên admin');
  const user = await api<{ message?: string }>('POST', '/channels/messenger', admin.token, {
    pageAccessToken: USER_TOKEN_LONG,
  });
  assert(user.status === 400, `token người dùng trả ${errMsg(user)} (mong đợi 400)`);
  assert(/Fanpage|Page/i.test(user.body?.message ?? ''), `thông báo: ${user.body?.message}`);
  const expired = await api<{ message?: string }>('POST', '/channels/messenger', admin.token, {
    pageAccessToken: EXPIRED_TOKEN_LONG,
  });
  assert(expired.status === 400, `token hết hạn trả ${errMsg(expired)} (mong đợi 400)`);
  return `user token: "${user.body?.message}"; hết hạn: "${expired.body?.message}"`;
}

/** Khách có PSID đặc biệt nhắn tới page A rồi admin trả lời; chờ trạng thái cuối của tin. */
async function replyToSpecialPsid(psid: string, timeoutMs: number): Promise<MessageDto> {
  const ch = need(S.chA, 'kênh A');
  const admin = need(S.admin, 'phiên admin');
  const sock = need(S.adminSock, 'socket admin');
  const text = `E2E ${RUN} khách ${psid} hỏi giá`;
  let since = sock.mark();
  await expectWebhook200(customerText(ch.externalId, psid, text));
  const created = await sock.waitFor<MessageCreatedPayload>(
    'message.created',
    (p) => p.message.text === text,
    3_000,
    since,
  );
  since = sock.mark();
  const res = await api<{ messages: MessageDto[] }>(
    'POST',
    `/conversations/${created.conversation.id}/messages`,
    admin.token,
    { text: `E2E ${RUN} trả lời ${psid}` },
  );
  assert(res.status === 201, `POST messages: ${errMsg(res)}`);
  const id = res.body.messages[0]?.id;
  assert(id, 'API không trả tin vừa tạo');
  const done = await sock.waitFor<MessageUpdatedPayload>(
    'message.updated',
    (p) => p.message.id === id && (p.message.status === 'sent' || p.message.status === 'failed'),
    timeoutMs,
    since,
  );
  return done.message;
}

async function extraSendOutsideWindowError(): Promise<string> {
  const msg = await replyToSpecialPsid('PSID_OUTSIDE', 8_000);
  assert(msg.status === 'failed', `status=${msg.status} (mong đợi failed)`);
  assert(msg.error, 'tin failed nhưng không có error');
  return `failed: "${msg.error}"`;
}

async function extraSendRateLimitRetry(): Promise<string> {
  const msg = await replyToSpecialPsid('PSID_RATE', 30_000);
  assert(msg.status === 'sent', `status=${msg.status} ${msg.error ?? ''}`);
  const calls = (await mockCalls('/messages', 'POST')).filter(
    (c) => (c.body?.recipient as { id?: unknown } | undefined)?.id === 'PSID_RATE',
  );
  assert(calls.length >= 2, `mock chỉ thấy ${calls.length} lần gửi`);
  return `613 lần đầu -> thử lại -> sent (${calls.length} lần gọi)`;
}

/**
 * Facebook Login qua dialog giả của mock. Nếu API chưa cho cấu hình host dialog (authorizeUrl vẫn là
 * facebook.com) thì runner tự đổi host sang mock — vẫn kiểm được callback, đổi token, /me/accounts, kết nối.
 */
async function extraFacebookLogin(): Promise<string> {
  const admin = need(S.admin, 'phiên admin');
  const pageA = need(S.pageA, 'Page A');
  const start = await api<{ authorizeUrl?: string }>('POST', '/channels/messenger/oauth/start', admin.token);
  if (start.status === 404) skip('API chưa có /channels/messenger/oauth/start');
  assert(start.status === 200 && start.body.authorizeUrl, `oauth/start: ${errMsg(start)}`);
  const authorize = new URL(start.body.authorizeUrl);
  assert(
    authorize.pathname === `/${CFG.graphVersion}/dialog/oauth`,
    `đường dẫn dialog ${authorize.pathname}`,
  );
  assert(authorize.searchParams.get('client_id') === CFG.appId, 'client_id sai');
  const redirectUri = authorize.searchParams.get('redirect_uri') ?? '';
  assert(redirectUri.endsWith('/channels/messenger/oauth/callback'), `redirect_uri=${redirectUri}`);
  const hostNote =
    authorize.origin === CFG.mock ? 'dialog = mock' : `dialog host ${authorize.host} (runner đổi sang mock)`;

  const dialog = await fetch(`${CFG.mock}${authorize.pathname}${authorize.search}`, { redirect: 'manual' });
  const callbackUrl = dialog.headers.get('location');
  assert(dialog.status === 302 && callbackUrl, `dialog mock trả ${dialog.status}`);
  const callback = await fetch(callbackUrl, { redirect: 'manual' });
  const back = callback.headers.get('location');
  assert(callback.status === 302 && back, `callback trả ${callback.status}`);
  const backUrl = new URL(back);
  const fbError = backUrl.searchParams.get('fbError');
  assert(!fbError, `callback chuyển về fbError=${fbError}`);
  const sessionId = backUrl.searchParams.get('fbSession');
  assert(sessionId, `callback không có fbSession (${backUrl.pathname})`);

  type SessionPage = { id: string; name: string; canMessage: boolean };
  const session = await api<{ pages: SessionPage[] }>(
    'GET',
    `/channels/messenger/oauth/sessions/${sessionId}`,
    admin.token,
  );
  assert(session.status === 200, `GET phiên: ${errMsg(session)}`);
  const page = session.body.pages.find((p) => p.id === pageA.id);
  assert(page && page.canMessage, 'phiên không có Page A (canMessage)');
  const connect = await api<{ results: Array<{ pageId: string; ok: boolean; error?: string }> }>(
    'POST',
    `/channels/messenger/oauth/sessions/${sessionId}/connect`,
    admin.token,
    { pageIds: [pageA.id] },
  );
  assert(connect.status === 200, `connect: ${errMsg(connect)}`);
  const result = connect.body.results.find((r) => r.pageId === pageA.id);
  assert(result?.ok, `kết nối Page A lỗi: ${result?.error ?? 'không có kết quả'}`);

  const tokenCalls = await mockCalls('/oauth/access_token', 'GET');
  assert(
    tokenCalls.filter((c) => c.status === 200).length >= 2,
    'mock không thấy đổi code + fb_exchange_token',
  );
  const accounts = await mockCalls('/me/accounts', 'GET');
  assert(
    accounts.some((c) => c.status === 200),
    'mock không thấy GET /me/accounts thành công',
  );
  // Sau khi kết nối lại, đặt lại màu A cho các lần chạy sau.
  const chA = need(S.chA, 'kênh A');
  await api('PATCH', `/channels/${chA.id}`, admin.token, { color: COLOR_A });
  return `${hostNote}; ${session.body.pages.length} Trang trong phiên; kết nối Page A OK`;
}

// ---------- Đồng bộ hội thoại (Conversations API) ----------

/** Hội thoại mẫu của mock: PSID_SYNC_<3 số cuối page>_n và số tin mỗi hội thoại (scripts/mock-graph.ts). */
const MOCK_THREADS = [
  { n: 1, messages: 3 },
  { n: 2, messages: 2 },
  { n: 3, messages: 2 },
] as const;
const syncPsid = (pageId: string, n: number) => `PSID_SYNC_${pageId.slice(-3)}_${n}`;

async function pollUntil<T>(timeoutMs: number, what: string, fn: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`hết ${Math.round(timeoutMs / 1000)}s: ${what}`);
    await sleep(1_000);
  }
}

/** Thêm tin vào thread của mock mà KHÔNG gửi webhook (giả lập webhook bị lỡ). */
async function inboxMessage(body: Record<string, unknown>): Promise<string> {
  const res = await http<{ id: string }>(`${CFG.mock}/__inbox/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert(res.status === 200, `mock /__inbox/message trả ${res.status}`);
  return res.body.id;
}

/** s1: kết nối Page => job đồng bộ lịch sử nhập 3 hội thoại mẫu mỗi Page, đúng tên khách, không tăng unread. */
async function syncBackfill(): Promise<string> {
  const admin = need(S.admin, 'phiên admin');
  const pages = [
    { ch: need(S.chA, 'kênh A'), token: TOKEN_A },
    { ch: need(S.chB, 'kênh B'), token: TOKEN_B },
  ];
  const expected: Array<{ name: string; channelId: string; messages: number }> = [];
  for (const { ch, token } of pages) {
    for (const t of MOCK_THREADS) {
      const psid = syncPsid(ch.externalId, t.n);
      const profile = await mockGraphGet<{ name: string }>(`${psid}?fields=name`, token);
      expected.push({ name: profile.name, channelId: ch.id, messages: t.messages });
    }
  }
  // Chờ cả 2 kênh xong backfill (sync.lastBackfillAt có, backfillRunning=false).
  const channels = await pollUntil(S.syncWaitMs, 'sync.lastBackfillAt của 2 kênh', async () => {
    const res = await api<ChannelAccountDto[]>('GET', '/channels', admin.token);
    const mine = res.body.filter((c) => pages.some((p) => p.ch.id === c.id));
    const done = mine.every((c) => c.sync?.lastBackfillAt && !c.sync.backfillRunning);
    return mine.length === 2 && done ? mine : undefined;
  });
  for (const c of channels) {
    assert(c.sync?.lastError == null, `kênh ${c.displayName}: sync.lastError="${c.sync?.lastError}"`);
    assert(c.sync?.lastSyncedAt, `kênh ${c.displayName}: thiếu sync.lastSyncedAt`);
  }
  const list = await listConversations(admin.token);
  const notes: string[] = [];
  for (const e of expected) {
    const conv = list.filter((c) => c.channel.id === e.channelId && c.contact.displayName === e.name);
    assert(conv.length === 1, `có ${conv.length} hội thoại "${e.name}" (mong đợi 1)`);
    const c = conv[0]!;
    assert(c.unreadCount === 0, `"${e.name}" unreadCount=${c.unreadCount} (lịch sử không tính chưa đọc)`);
    const msgs = await messagesOf(admin.token, c.id);
    assert(msgs.length === e.messages, `"${e.name}" có ${msgs.length} tin (mong đợi ${e.messages})`);
    notes.push(`${e.name}:${msgs.length}`);
  }
  // Tin do Page gửi (Business Suite) => agent "Meta Business Suite"; tin ảnh có attachment image.
  const first = list.find((c) => c.contact.displayName === expected[0]!.name)!;
  const firstMsgs = await messagesOf(admin.token, first.id);
  assert(
    firstMsgs.some((m) => m.senderType === 'agent' && m.senderLabel === 'Meta Business Suite'),
    'tin của Page không thành agent "Meta Business Suite"',
  );
  assert(
    firstMsgs.some((m) => m.attachments.some((a) => a.type === 'image')),
    'tin ảnh của hội thoại 1 không có attachment image',
  );
  return `6 hội thoại, unread=0, ${notes.join(', ')}`;
}

/** s2: tin chỉ có ở Conversations API (webhook lỡ) => đồng bộ định kỳ nhập trong 1 tick, như webhook. */
async function syncIncremental(): Promise<string> {
  const ch = need(S.chA, 'kênh A');
  const sock = need(S.adminSock, 'socket admin');
  const text = `E2E ${RUN} chỉ có qua đồng bộ`;
  const since = sock.mark();
  const started = Date.now();
  await inboxMessage({ pageId: ch.externalId, psid: syncPsid(ch.externalId, 2), text });
  const match = (p: MessageCreatedPayload) => p.message.text === text;
  const ev = await sock.waitFor<MessageCreatedPayload>('message.created', match, S.syncWaitMs, since);
  assert(ev.message.senderType === 'customer', `senderType=${ev.message.senderType}`);
  const unread = ev.conversation.unreadCount;
  assert(unread >= 1, `unreadCount=${unread} (đồng bộ định kỳ xử lý như webhook)`);
  return `message.created sau ${((Date.now() - started) / 1000).toFixed(1)}s, unread=${unread}`;
}

/** s3: cùng một mid vừa qua webhook vừa qua đồng bộ => chỉ 1 tin. */
async function syncNoDuplicate(): Promise<string> {
  const ch = need(S.chA, 'kênh A');
  const sock = need(S.adminSock, 'socket admin');
  const admin = need(S.admin, 'phiên admin');
  const psid = newPsid();
  const mid = newMid();
  const text = `E2E ${RUN} webhook + đồng bộ cùng mid`;
  const sentinel = `E2E ${RUN} mốc sau đồng bộ`;
  const since = sock.mark();
  await inboxMessage({ pageId: ch.externalId, psid, text, mid });
  await expectWebhook200(customerText(ch.externalId, psid, text, mid));
  const isText = (p: MessageCreatedPayload) => p.message.text === text;
  const ev = await sock.waitFor<MessageCreatedPayload>('message.created', isText, S.syncWaitMs, since);
  // Tin mốc chỉ có qua đồng bộ: khi nó về, lần đồng bộ đó chắc chắn đã đọc cả tin cùng mid.
  await inboxMessage({ pageId: ch.externalId, psid, text: sentinel });
  const isSentinel = (p: MessageCreatedPayload) => p.message.text === sentinel;
  await sock.waitFor<MessageCreatedPayload>('message.created', isSentinel, S.syncWaitMs, since);
  const msgs = await messagesOf(admin.token, ev.conversation.id);
  const count = msgs.filter((m) => m.text === text).length;
  const events = sock.count<MessageCreatedPayload>('message.created', isText, since);
  assert(count === 1, `có ${count} tin cùng mid (mong đợi 1)`);
  assert(events === 1, `nhận ${events} message.created (mong đợi 1)`);
  return '1 tin, 1 sự kiện';
}

/** s4: tin nhân viên gửi từ hộp thư (Send API -> thread của mock) không bị đồng bộ nhập lại lần 2. */
async function syncOwnSentNotDuplicated(): Promise<string> {
  const admin = need(S.admin, 'phiên admin');
  const conv = need(S.convA, 'hội thoại A');
  const reply = need(S.reply, 'tin trả lời (bước g)');
  const sock = need(S.adminSock, 'socket admin');
  const ch = need(S.chA, 'kênh A');
  // Mốc: tin mới trong cùng hội thoại chỉ có qua đồng bộ => lần đồng bộ đó đã đọc cả tin trả lời.
  const sentinel = `E2E ${RUN} mốc sau tin trả lời`;
  const since = sock.mark();
  await inboxMessage({ pageId: ch.externalId, psid: need(S.psidA, 'PSID A'), text: sentinel });
  const isSentinel = (p: MessageCreatedPayload) => p.message.text === sentinel;
  await sock.waitFor<MessageCreatedPayload>('message.created', isSentinel, S.syncWaitMs, since);
  const msgs = await messagesOf(admin.token, conv.id);
  const copies = msgs.filter((m) => m.text === reply.text);
  assert(copies.length === 1, `tin trả lời có ${copies.length} bản (mong đợi 1)`);
  return `1 bản, tổng ${msgs.length} tin trong hội thoại`;
}

// ---------- Chạy ----------

async function preflight(): Promise<void> {
  const health = await http(`${CFG.api}/health`).catch(() => undefined);
  if (!health) throw new Error(`Không kết nối được API ${CFG.api} — hãy chạy api trước`);
  const mock = await http(`${CFG.mock}/__health`).catch(() => undefined);
  if (!mock || mock.status !== 200)
    throw new Error(`Không kết nối được mock-graph ${CFG.mock} — hãy chạy scripts/mock-graph.ts`);
}

async function runWebhookOnly(waitSec: number): Promise<void> {
  await check('a', 'Đăng nhập admin', async () => {
    S.admin = await login(CFG.admin.email, CFG.admin.password);
  });
  const admin = need(S.admin, 'phiên admin');
  const pageA = await mockGraphGet<{ id: string }>('me?fields=id,name,category', TOKEN_A);
  const text = `E2E ${RUN} webhook-only (worker có thể đang tắt)`;
  await check('j1', 'Webhook trả 200 trong < 1000ms', async () => {
    const ms = await expectWebhook200(customerText(pageA.id, newPsid(), text));
    assert(ms < 1_000, `${ms}ms`);
    return `${ms}ms`;
  });
  console.log(`     … chờ worker xử lý tối đa ${waitSec}s (nếu đang tắt worker, hãy bật lại ngay bây giờ)`);
  await check('j2', `Worker xử lý tin (poll REST, tối đa ${waitSec}s)`, async () => {
    const deadline = Date.now() + waitSec * 1_000;
    const started = Date.now();
    while (Date.now() < deadline) {
      const items = await listConversations(admin.token);
      if (items.some((c) => c.lastMessage?.text === text))
        return `xuất hiện sau ${Math.round((Date.now() - started) / 1000)}s`;
      await sleep(2_000);
    }
    throw new Error('tin chưa xuất hiện trong hộp thư');
  });
}

async function runAll(sync: boolean): Promise<void> {
  await http(`${CFG.mock}/__reset`, { method: 'POST' });
  await check('a', 'Đăng nhập admin + agent', stepLogin);
  await check('b', 'Kết nối 2 Fanpage (mock), đặt màu, GET /channels', stepChannels);
  await check('-', 'Mở socket admin + agent', stepSockets);
  if (sync) await check('s1', 'Đồng bộ lịch sử sau kết nối: 6 hội thoại mẫu, tên thật', syncBackfill);
  await check('c', 'Webhook Page A -> 2 socket nhận message.created < 3s', stepInboundA);
  await check('d', 'Webhook Page B -> nhãn kênh khác Page A', stepInboundB);
  await check('e', 'Webhook trùng mid -> chỉ 1 tin', stepDuplicate);
  await check('f', 'Tin ảnh -> lưu S3, URL ký tải được', stepImage);
  await check('g', 'Trả lời từ hộp thư -> sent < 5s, Send API đúng', stepReply);
  await check('h1', 'Echo Business Suite -> agent "Meta Business Suite"', stepBusinessSuiteEcho);
  await check('h2', 'Echo của chính app -> không tạo tin trùng', stepOwnEcho);
  await check('k', 'Webhook delivery + read -> delivered rồi seen', stepDeliveryRead);
  await check('i', 'Ngoài cửa sổ 24h -> 422 + sendWindow.allowed=false', stepOutsideWindow);
  await check('j', 'Webhook trả 200 < 1000ms (5 lần)', stepWebhookLatency);
  await check('l', 'RBAC agent: 403 kênh, mất hội thoại khi phân công', stepRbac);
  if (sync) {
    console.log('---- đồng bộ hội thoại ----');
    await check('s2', 'Đồng bộ định kỳ: tin webhook lỡ về trong 1 tick', syncIncremental);
    await check('s3', 'Cùng mid qua webhook + đồng bộ -> chỉ 1 tin', syncNoDuplicate);
    await check('s4', 'Tin gửi từ hộp thư không bị đồng bộ nhập lại', syncOwnSentNotDuplicated);
  }
  console.log('---- bổ sung ----');
  await check('x1', 'Webhook: chữ ký sai bị từ chối, verify hub.challenge', extraWebhookSecurity);
  await check('x2', 'Kết nối bằng token người dùng / token hết hạn -> 400', extraBadTokens);
  await check('x3', 'Send API lỗi 10/2018278 -> tin failed có lý do', extraSendOutsideWindowError);
  await check('x4', 'Send API lỗi 613 -> worker thử lại -> sent', extraSendRateLimitRetry);
  await check('x5', 'Facebook Login (dialog mock) -> chọn Trang -> kết nối', extraFacebookLogin);
  console.log(
    '\nGhi chú j: để thử "worker tắt vẫn trả 200": tắt worker, chạy lại với --webhook-only, bật lại worker trong 60s.',
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'webhook-only': { type: 'boolean' },
      wait: { type: 'string', default: '60' },
      api: { type: 'string' },
      mock: { type: 'string' },
      'sync-wait': { type: 'string', default: '30' },
      'no-sync': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values.api) CFG.api = values.api.replace(/\/+$/, '');
  if (values.mock) CFG.mock = values.mock.replace(/\/+$/, '');
  S.syncWaitMs = (Number(values['sync-wait']) || 30) * 1_000;
  console.log(`Dezon Omni Inbox — nghiệm thu 1A với mock Graph (run ${RUN})`);
  console.log(`API ${CFG.api} · mock ${CFG.mock} · Graph ${CFG.graphVersion} · app_id ${CFG.appId}\n`);
  const started = Date.now();
  try {
    await preflight();
    if (values['webhook-only']) await runWebhookOnly(Number(values.wait) || 60);
    else await runAll(!values['no-sync']);
  } finally {
    S.adminSock?.close();
    S.agentSock?.close();
  }
  const by = (s: Result['status']) => results.filter((r) => r.status === s).length;
  console.log(
    `\nKết quả: ${by('PASS')} PASS, ${by('FAIL')} FAIL, ${by('SKIP')} SKIP — ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  if (by('FAIL') > 0 || by('SKIP') > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(`Lỗi: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
