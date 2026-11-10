// Kiểm thử end-to-end tính năng "Chatbot AI" với Gemini THẬT + mock Graph (không gửi gì tới Fanpage thật).
// Chạy trên một stack CÔ LẬP (DB riêng + Redis RIÊNG), KHÔNG chạy trên stack dev thật: runner đổi cài đặt
// (công tắc AI tổng, giờ làm việc, Lark) và gửi webhook giả. Redis phải là instance khác (vd container cổng
// 6380), không chỉ khác số DB: Pub/Sub của Socket.IO không phân theo số DB nên sự kiện sẽ lọt sang stack thật.
//
// Dựng stack (Git Bash, thư mục gốc repo):
//   docker run -d --name dezon-e2e-redis -p 6380:6379 redis:7-alpine
//   docker exec dezon-inbox-postgres-1 psql -U dezon -d postgres -c "CREATE DATABASE dezon_e2e"
//   export DATABASE_URL=postgres://dezon:dezon@localhost:5433/dezon_e2e REDIS_URL=redis://localhost:6380
//   pnpm db:migrate
//   export SEED_ADMIN_EMAIL=admin@dezon.vn SEED_ADMIN_PASSWORD='Dezon@2026'
//   export SEED_AGENT_EMAIL=sale@dezon.vn SEED_AGENT_PASSWORD='Sale@2026'
//   (cd packages/db && npx tsx src/scripts/seed.ts --reset-passwords)
//   export META_GRAPH_BASE_URL=http://localhost:4900 META_APP_ID=dev-app-id META_APP_SECRET=dev-app-secret
//   export META_VERIFY_TOKEN=dev-verify-token API_PORT=4100 API_URL=http://localhost:4100
//   export MESSENGER_SYNC_INTERVAL_SEC=0
//   export LARK_WEBHOOK_URL=http://localhost:4901/lark LARK_WEBHOOK_SECRET=e2e-lark-secret   # Lark giả của runner
//   (cd apps/worker && npx tsx ../../scripts/mock-graph.ts --port 4900 --name-prefix "[TEST] "
//       --echo-webhooks http://localhost:4100 dev-app-secret dev-app-id) &
//   (cd apps/api && npx tsc -p tsconfig.build.json --outDir /tmp/api-e2e)
//   (cd apps/api && NODE_PATH=$PWD/node_modules node /tmp/api-e2e/main.js) &
//   (cd apps/worker && npx tsx src/main.ts) &
//   (Không dùng `nest build`/apps/api/dist khi `pnpm dev` đang chạy: nest watch ghi đè dist.)
// Chạy runner:
//   cd apps/worker && E2E_DATABASE_URL=$DATABASE_URL npx tsx ../../scripts/e2e-chatbot.ts --api http://localhost:4100
//   thêm --lark-real để gửi ĐÚNG 1 thẻ Lark thật (s4a); --only s4,s9 để chạy lẻ (s1 luôn chạy).
// Dọn: tắt 3 tiến trình, DROP DATABASE dezon_e2e, docker rm -f dezon-e2e-redis.
//
// Gọi Gemini thật khoảng 10 lần mỗi lượt chạy đầy đủ (s2a, s3, s4c, s5b, s6b, s7a, s9 x2, s10, s11b).
// Đo độ trễ "trả lời < 4 s + đang soạn tin": thêm --latency (hoặc chỉ đo: --only s12) — thêm 11 lần gọi Gemini
// (đổi bằng --latency-trials 6,3,2). Mốc: t0 = POST webhook đã ký -> typing_on tới mock -> tin bot đầu tới mock.
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import type { LoginResponse } from '../packages/shared/src/auth';
import type {
  AiRunDto,
  BusinessHours,
  ChatbotDto,
  ChatbotSummary,
  ChatbotTestResult,
  LarkSettingsDto,
} from '../packages/shared/src/chatbots';
import type { ChannelAccountDto, ConversationSummary, MessageDto, Page } from '../packages/shared/src/inbox';
import type {
  AiTypingPayload,
  ConversationUpdatedPayload,
  HandoffCreatedPayload,
  MessageCreatedPayload,
} from '../packages/shared/src/realtime';

const USAGE = `Kiểm thử end-to-end Chatbot AI (Gemini thật + mock Graph) trên stack cô lập.

Cách dùng:
  pnpm --filter @dezon/worker exec tsx ../../scripts/e2e-chatbot.ts [--api <url>] [--mock <url>]
      [--lark-port <n>] [--lark-real] [--only s2,s3,...] [--latency] [--latency-trials a,b,c] [--help]

  --api <url>       URL API của stack cô lập (mặc định E2E_API_URL hoặc http://localhost:4100)
  --mock <url>      URL mock-graph (mặc định E2E_MOCK_URL hoặc http://localhost:4900)
  --lark-port <n>   Cổng server bắt thẻ Lark của runner (mặc định 4901). api + worker phải chạy với
                    LARK_WEBHOOK_URL=http://localhost:<n>/lark (Lark dự phòng từ env).
  --lark-real       Ở s4: lưu webhook Lark THẬT (E2E_LARK_WEBHOOK_URL, hoặc LARK_WEBHOOK_URL của .env) vào
                    Cài đặt => đúng 1 thẻ thật cho lần chuyển người thật; xong thì trả lại server bắt thẻ.
  --only <ids>      Chỉ chạy các mục (s1 luôn chạy), ví dụ --only s2,s7
  --latency         Chạy thêm s12: đo độ trễ webhook -> typing_on -> tin bot đầu tiên tới mock (mục tiêu < 4 s)
                    và kiểm "đang soạn tin" (sender_action typing_on + realtime ai.typing). --only s12 = chỉ đo.
  --latency-trials a,b,c  Số lượt: delay 0s Nhanh nhất (a, mặc định 6), delay 1s Nhanh nhất (b, 3), delay 0s
                    Cân bằng (c, 2). Mỗi lượt = 1 lần gọi Gemini thật.

Biến môi trường: E2E_DATABASE_URL hoặc DATABASE_URL (BẮT BUỘC đặt tay, phải là DB của stack cô lập — runner
  từ chối nếu trùng DATABASE_URL trong .env), META_APP_SECRET (dev-app-secret), META_GRAPH_VERSION (v26.0),
  E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD (admin@dezon.vn / Dezon@2026).`;

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
  api: env('E2E_API_URL', 'http://localhost:4100').replace(/\/+$/, ''),
  mock: env('E2E_MOCK_URL', 'http://localhost:4900').replace(/\/+$/, ''),
  larkPort: 4901,
  larkReal: false,
  appSecret: env('META_APP_SECRET', 'dev-app-secret'),
  graphVersion: env('META_GRAPH_VERSION', 'v26.0'),
  databaseUrl: process.env.E2E_DATABASE_URL || process.env.DATABASE_URL || '',
  admin: {
    email: env('E2E_ADMIN_EMAIL', 'admin@dezon.vn'),
    password: env('E2E_ADMIN_PASSWORD', 'Dezon@2026'),
  },
  only: null as Set<string> | null,
  /** s12 (đo độ trễ) chỉ chạy khi bật --latency hoặc --only có s12. */
  latency: false,
};

/** Page mock (API yêu cầu token >= 20 ký tự). */
const TOKEN_A = 'PAGE_TOKEN_A_DEZON_DESIGN_MOCK';
/** Page id của mock — runner từ chối chạy nếu stack có kênh Messenger khác (Fanpage thật). */
const MOCK_PAGE_IDS = new Set(['100000000000001', '100000000000002']);

const BOT_NAME = 'Bot thử nghiệm';
const BOT_REPLY_DELAY_SEC = 3;
const HANDOFF_KEYWORDS = ['giảm giá', 'bớt', 'chiết khấu', 'khiếu nại', 'gặp nhân viên', 'hoàn tiền'];
const BOT_INSTRUCTIONS = [
  'Bạn là trợ lý tư vấn thiết kế nhà của Dezon (thiết kế kiến trúc và nội thất nhà ở).',
  'Xưng "em", gọi khách là "anh/chị". Giọng thân thiện, ngắn gọn, lịch sự.',
  'Luôn trả lời thành 2 tin nhắn ngắn: tin 1 trả lời trực tiếp câu hỏi, tin 2 hỏi thêm một thông tin để tư vấn tiếp.',
  'Chỉ báo giá theo bảng giá trong phần kiến thức; không tự bịa giá hay khuyến mãi.',
].join('\n');
const BOT_KNOWLEDGE = [
  'BẢNG GIÁ THIẾT KẾ (dữ liệu thử nghiệm):',
  '- Thiết kế kiến trúc nhà phố: 150.000đ/m² sàn.',
  '- Thiết kế kiến trúc biệt thự: 200.000đ/m² sàn.',
  '- Thiết kế nội thất: 180.000đ/m² sàn.',
  '- Trọn gói kiến trúc + nội thất nhà phố: 300.000đ/m² sàn.',
  'CÂU HỎI THƯỜNG GẶP:',
  '- Thời gian thiết kế: 20–30 ngày làm việc cho nhà phố, 35–45 ngày cho biệt thự.',
  '- Hồ sơ gồm: phối cảnh 3D, bản vẽ kiến trúc, kết cấu, điện nước.',
  '- Văn phòng: 123 Đường Thử Nghiệm, Hà Nội. Làm việc 8:00–17:30 thứ Hai đến thứ Bảy.',
].join('\n');

const RUN = Date.now().toString(36);
let psidSeq = 0;
const newPsid = () => `${Date.now()}${String(++psidSeq).padStart(3, '0')}`;
let midSeq = 0;
const newMid = () => `m_e2ebot_${RUN}_${++midSeq}`;

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
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
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
  const group = id.replace(/[a-z]$/, '');
  if (CFG.only && group !== 's1' && !CFG.only.has(group) && !CFG.only.has(id)) return false;
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
  console.log(`${status.padEnd(4)} ${id.padEnd(4)} ${name.padEnd(62)} ${time}${detail ? `  ${detail}` : ''}`);
  return status === 'PASS';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- HTTP ----------

interface ApiRes<T> {
  status: number;
  body: T;
  ms: number;
}

async function http<T>(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<ApiRes<T>> {
  const started = Date.now();
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, body: body as T, ms: Date.now() - started };
}

function api<T>(method: string, path: string, token?: string, body?: unknown, timeoutMs?: number) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return http<T>(
    `${CFG.api}${path}`,
    { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
    timeoutMs,
  );
}

const errMsg = (res: ApiRes<unknown>) => {
  const b = res.body as { message?: unknown } | undefined;
  return `HTTP ${res.status}${b && typeof b === 'object' && typeof b.message === 'string' ? `: ${b.message}` : ''}`;
};

async function ok<T>(res: Promise<ApiRes<T>>, what: string, expected = [200, 201]): Promise<T> {
  const r = await res;
  assert(expected.includes(r.status), `${what}: ${errMsg(r)}`);
  return r.body;
}

// ---------- Webhook ----------

/** Escape ký tự ngoài ASCII như Meta (chữ ký tính trên đúng bytes gửi đi). */
function metaJson(payload: unknown): string {
  return JSON.stringify(payload).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

async function postWebhook(payload: unknown): Promise<void> {
  const body = metaJson(payload);
  const signature = `sha256=${createHmac('sha256', CFG.appSecret).update(body).digest('hex')}`;
  const res = await http<string>(`${CFG.api}/webhooks/messenger`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body,
  });
  assert(res.status === 200, `webhook trả ${res.status}`);
}

async function customerSays(pageId: string, psid: string, text: string): Promise<void> {
  await postWebhook({
    object: 'page',
    entry: [
      {
        id: pageId,
        time: Date.now(),
        messaging: [
          {
            sender: { id: psid },
            recipient: { id: pageId },
            timestamp: Date.now(),
            message: { mid: newMid(), text },
          },
        ],
      },
    ],
  });
}

// ---------- Socket ----------

interface LoggedEvent {
  event: string;
  payload: unknown;
  at: number;
}

const SOCKET_EVENTS = [
  'message.created',
  'message.updated',
  'conversation.updated',
  'handoff.created',
  'ai.typing',
];

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
    for (const event of SOCKET_EVENTS) {
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

  mark(): number {
    return this.events.length;
  }

  list<T>(event: string, pred: (p: T) => boolean, since = 0): LoggedEvent[] {
    return this.events.slice(since).filter((e) => e.event === event && pred(e.payload as T));
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

// ---------- Mock Graph + server bắt thẻ Lark ----------

interface MockCall {
  at: string;
  method: string;
  path: string;
  pageId?: string;
  status: number;
  body?: { recipient?: { id?: string }; message?: { text?: string }; messaging_type?: string };
}

async function sendApiCallsTo(psid: string): Promise<MockCall[]> {
  const q = new URLSearchParams({ path: '/messages', method: 'POST' });
  const res = await http<{ calls: MockCall[] }>(`${CFG.mock}/__calls?${q}`);
  // Chỉ lần gửi TIN (có message); lần gọi sender_action (typing_on/mark_seen…) xem GET /__sender_actions.
  return res.body.calls.filter((c) => c.body?.recipient?.id === psid && c.status === 200 && c.body?.message);
}

interface LarkHit {
  at: number;
  body: { msg_type?: string; timestamp?: string; sign?: string; card?: unknown };
}
const larkHits: LarkHit[] = [];

function startLarkCapture(port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        larkHits.push({
          at: Date.now(),
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as LarkHit['body'],
        });
      } catch {
        larkHits.push({ at: Date.now(), body: {} });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0, msg: 'success' }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}

// ---------- Trạng thái dùng chung ----------

interface Session {
  token: string;
  user: LoginResponse['user'];
}

const S: {
  admin?: Session;
  sock?: SocketLog;
  ch?: ChannelAccountDto;
  bot?: ChatbotDto;
  pg?: PgClient;
  /** s2/s4: hội thoại khách 1 */
  c1?: { psid: string; conv: ConversationSummary };
  /** s3/s5/s6/s8: hội thoại khách 2 */
  c2?: { psid: string; conv: ConversationSummary };
  /** s4: hội thoại khách 3 (mở đầu bằng từ khóa chuyển người thật) */
  c4?: { psid: string; conv: ConversationSummary };
} = {};

const need = <T>(value: T | undefined, what: string): T => value ?? skip(`thiếu ${what} từ bước trước`);

const ALL_DAY: BusinessHours['days'] = {
  mon: [{ start: '00:00', end: '23:59' }],
  tue: [{ start: '00:00', end: '23:59' }],
  wed: [{ start: '00:00', end: '23:59' }],
  thu: [{ start: '00:00', end: '23:59' }],
  fri: [{ start: '00:00', end: '23:59' }],
  sat: [{ start: '00:00', end: '23:59' }],
  sun: [{ start: '00:00', end: '23:59' }],
};
const CLOSED: BusinessHours['days'] = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };

const VI_DIACRITICS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

async function login(email: string, password: string): Promise<Session> {
  const res = await api<LoginResponse>('POST', '/auth/login', undefined, { email, password });
  assert(res.status === 200, `đăng nhập ${email}: ${errMsg(res)}`);
  return { token: res.body.accessToken, user: res.body.user };
}

const adminToken = () => need(S.admin, 'phiên admin').token;
const sock = () => need(S.sock, 'socket admin');

async function messagesOf(conversationId: string): Promise<MessageDto[]> {
  const page = await ok(
    api<Page<MessageDto>>('GET', `/conversations/${conversationId}/messages?limit=100`, adminToken()),
    'GET messages',
  );
  return page.items;
}

async function conversation(conversationId: string): Promise<ConversationSummary> {
  return ok(
    api<ConversationSummary>('GET', `/conversations/${conversationId}`, adminToken()),
    'GET conversation',
  );
}

async function aiRuns(conversationId: string): Promise<AiRunDto[]> {
  return ok(api<AiRunDto[]>('GET', `/conversations/${conversationId}/ai-runs`, adminToken()), 'GET ai-runs');
}

async function dbRuns(conversationId: string) {
  const pg = need(S.pg, 'kết nối Postgres');
  const res = await pg.query<{ id: string; decision: string; triggers: number; error: string | null }>(
    `select id, decision, cardinality(trigger_message_ids)::int as triggers, error
       from ai_runs where conversation_id = $1 order by created_at, id`,
    [conversationId],
  );
  return res.rows;
}

/** Khách mới nhắn tin đầu tiên => chờ message.created để lấy hội thoại. */
async function newCustomer(text: string): Promise<{ psid: string; conv: ConversationSummary }> {
  const ch = need(S.ch, 'kênh mock');
  const psid = newPsid();
  const since = sock().mark();
  await customerSays(ch.externalId, psid, text);
  const created = await sock().waitFor<MessageCreatedPayload>(
    'message.created',
    (p) => p.message.senderType === 'customer' && p.message.text === text,
    10_000,
    since,
  );
  return { psid, conv: created.conversation };
}

/** Chờ các tin bot (message.created sender 'bot') sau mốc `since`; trả khi đủ yên lặng 3s sau tin cuối. */
async function waitBotMessages(
  conversationId: string,
  since: number,
  timeoutMs = 75_000,
): Promise<MessageDto[]> {
  const isBot = (p: MessageCreatedPayload) =>
    p.message.conversationId === conversationId && p.message.senderType === 'bot';
  await sock().waitFor<MessageCreatedPayload>('message.created', isBot, timeoutMs, since);
  await sleep(3_000);
  return sock()
    .list<MessageCreatedPayload>('message.created', isBot, since)
    .map((e) => (e.payload as MessageCreatedPayload).message);
}

/** Không có tin bot nào trong `ms` (đo trên socket). */
async function expectNoBot(conversationId: string, since: number, ms: number): Promise<void> {
  await sleep(ms);
  const bots = sock().list<MessageCreatedPayload>(
    'message.created',
    (p) => p.message.conversationId === conversationId && p.message.senderType === 'bot',
    since,
  );
  assert(bots.length === 0, `có ${bots.length} tin bot (mong đợi 0)`);
}

/** Chờ ai_runs của hội thoại đạt `count` dòng (poll DB). */
async function waitRuns(conversationId: string, count: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await dbRuns(conversationId);
    if (rows.length >= count) return rows;
    if (Date.now() > deadline)
      throw new Error(`ai_runs có ${rows.length} dòng sau ${timeoutMs}ms (mong đợi ${count})`);
    await sleep(500);
  }
}

async function putSetting<T>(path: string, body: unknown): Promise<T> {
  return ok(api<T>('PUT', `/settings/${path}`, adminToken(), body), `PUT /settings/${path}`);
}

/** Xóa dòng app_settings 'lark' => api/worker dùng LARK_WEBHOOK_URL của env (server bắt thẻ). */
async function resetLarkToCapture(): Promise<void> {
  await need(S.pg, 'kết nối Postgres').query(`delete from app_settings where key = 'lark'`);
}

const fmtLatency = (r: AiRunDto | undefined) =>
  r ? `${r.decision} ${r.latencyMs}ms in=${r.inputTokens} out=${r.outputTokens} model=${r.model}` : '—';

// ---------- s1: chuẩn bị ----------

async function s1Login(): Promise<string> {
  S.admin = await login(CFG.admin.email, CFG.admin.password);
  assert(S.admin.user.role === 'admin', `vai trò = ${S.admin.user.role}`);
  S.sock = await connectSocket('admin', S.admin.token);
  return S.admin.user.email;
}

async function s1Guard(): Promise<string> {
  const channels = await ok(api<ChannelAccountDto[]>('GET', '/channels', adminToken()), 'GET /channels');
  const real = channels.filter((c) => c.type === 'messenger' && !MOCK_PAGE_IDS.has(c.externalId));
  if (real.length > 0) {
    throw new Error(
      `stack có ${real.length} Fanpage không phải mock — đây có vẻ là stack thật, dừng để không gửi tin thật`,
    );
  }
  const pg = need(S.pg, 'kết nối Postgres');
  const db = await pg.query<{ db: string }>('select current_database() as db');
  return `${channels.length} kênh mock, DB ${db.rows[0]?.db}`;
}

async function s1Channel(): Promise<string> {
  const res = await api<ChannelAccountDto>('POST', '/channels/messenger', adminToken(), {
    pageAccessToken: TOKEN_A,
    color: '#7c3aed',
  });
  assert(res.status === 201, `POST /channels/messenger: ${errMsg(res)}`);
  S.ch = res.body;
  assert(MOCK_PAGE_IDS.has(S.ch.externalId), `page ${S.ch.externalId} không phải mock`);
  return `${S.ch.displayName} (${S.ch.externalId}) ${S.ch.status}`;
}

async function s1Settings(): Promise<string> {
  const ai = await putSetting<{ enabled: boolean }>('ai', { enabled: true });
  assert(ai.enabled === true, 'AI tổng chưa bật');
  const bh = await putSetting<BusinessHours>('business-hours', {
    timezone: 'Asia/Ho_Chi_Minh',
    days: ALL_DAY,
  });
  assert(bh.days.sun.length === 1, 'giờ làm việc chưa lưu');
  await resetLarkToCapture();
  const lark = await ok(api<LarkSettingsDto>('GET', '/settings/lark', adminToken()), 'GET /settings/lark');
  assert(lark.webhookUrl === null && !lark.hasSecret, `lark=${JSON.stringify(lark)}`);
  return 'AI bật, giờ làm việc 24/7, Lark = server bắt thẻ (env)';
}

async function s1Bot(): Promise<string> {
  const token = adminToken();
  const config = {
    name: BOT_NAME,
    description: '[TEST] bot của runner e2e-chatbot',
    isActive: true,
    instructions: BOT_INSTRUCTIONS,
    knowledge: BOT_KNOWLEDGE,
    examples: [
      {
        customer: 'Bên em có thiết kế nội thất chung cư không?',
        reply:
          'Dạ có ạ, bên em thiết kế nội thất 180.000đ/m² sàn. Căn hộ của anh/chị rộng khoảng bao nhiêu m² ạ?',
      },
    ],
    handoffKeywords: HANDOFF_KEYWORDS,
    handoffMessage: null,
    model: null,
    temperature: 0.4,
    replyDelaySec: BOT_REPLY_DELAY_SEC,
    maxWaitSec: 20,
    maxRepliesPerHour: 20,
  };
  const list = await ok(api<ChatbotSummary[]>('GET', '/chatbots', token), 'GET /chatbots');
  const existing = list.find((b) => b.name === BOT_NAME);
  S.bot = existing
    ? await ok(api<ChatbotDto>('PATCH', `/chatbots/${existing.id}`, token, config), 'PATCH chatbot')
    : await ok(api<ChatbotDto>('POST', '/chatbots', token, config), 'POST /chatbots');
  assert(S.bot.replyDelaySec === BOT_REPLY_DELAY_SEC, `replyDelaySec=${S.bot.replyDelaySec}`);
  const ch = need(S.ch, 'kênh');
  const patched = await ok(
    api<ChannelAccountDto>('PATCH', `/channels/${ch.id}`, token, { defaultChatbotId: S.bot.id }),
    'PATCH /channels defaultChatbotId',
  );
  assert(patched.defaultChatbotId === S.bot.id, `defaultChatbotId=${String(patched.defaultChatbotId)}`);
  S.ch = patched;
  return `${existing ? 'cập nhật' : 'tạo'} "${S.bot.name}" và đặt làm mặc định của ${ch.displayName}`;
}

// ---------- s2: hội thoại mới -> bot trả lời ----------

async function s2Reply(): Promise<string> {
  const bot = need(S.bot, 'chatbot');
  const since = sock().mark();
  const sentAt = Date.now();
  const c = await newCustomer(
    'Chào em, anh muốn thiết kế nhà phố 3 tầng, mỗi sàn 60m² thì chi phí khoảng bao nhiêu?',
  );
  S.c1 = c;
  assert(c.conv.chatbot?.id === bot.id, `chatbot=${JSON.stringify(c.conv.chatbot)}`);
  assert(c.conv.aiMode === 'auto', `aiMode=${c.conv.aiMode}`);
  assert(
    c.conv.contact.displayName.startsWith('[TEST]'),
    `tên khách "${c.conv.contact.displayName}" thiếu [TEST]`,
  );
  const bots = await waitBotMessages(c.conv.id, since);
  const firstBotAt = sock().list<MessageCreatedPayload>(
    'message.created',
    (p) => p.message.conversationId === c.conv.id && p.message.senderType === 'bot',
    since,
  )[0]!.at;
  for (const m of bots) {
    assert(m.senderLabel === bot.name, `senderLabel=${String(m.senderLabel)}`);
    assert(m.text && m.text.length > 0, 'tin bot rỗng');
  }
  assert(bots.length >= 1 && bots.length <= 3, `${bots.length} bong bóng`);
  const waited = firstBotAt - sentAt;
  assert(
    waited >= BOT_REPLY_DELAY_SEC * 1000,
    `bot trả lời sau ${waited}ms < độ trễ ${BOT_REPLY_DELAY_SEC}s`,
  );
  const runs = await aiRuns(c.conv.id);
  const run = runs[0];
  assert(run?.decision === 'reply', `ai_run mới nhất: ${fmtLatency(run)}`);
  assert(
    run.inputTokens > 0 && run.outputTokens > 0 && run.latencyMs > 0,
    `tokens/latency: ${fmtLatency(run)}`,
  );
  assert(run.chatbotName === bot.name, `chatbotName=${String(run.chatbotName)}`);
  return `${bots.length} bong bóng sau ${(waited / 1000).toFixed(1)}s · ${fmtLatency(run)} · "${bots[0]!.text!.slice(0, 70)}…"`;
}

async function s2Outbound(): Promise<string> {
  const c = need(S.c1, 'hội thoại s2');
  const msgs = await messagesOf(c.conv.id);
  const bots = msgs.filter((m) => m.senderType === 'bot');
  const deadline = Date.now() + 15_000;
  let calls: MockCall[] = [];
  while (Date.now() < deadline) {
    calls = await sendApiCallsTo(c.psid);
    if (calls.length >= bots.length) break;
    await sleep(500);
  }
  assert(calls.length === bots.length, `mock nhận ${calls.length} Send API call, có ${bots.length} tin bot`);
  for (const [i, m] of bots.entries()) {
    assert(calls[i]?.body?.message?.text === m.text, `bong bóng ${i + 1} gửi sai nội dung/thứ tự`);
    assert(
      calls[i]?.body?.messaging_type === 'RESPONSE',
      `messaging_type=${String(calls[i]?.body?.messaging_type)}`,
    );
  }
  const gaps = calls.slice(1).map((call, i) => Date.parse(call.at) - Date.parse(calls[i]!.at));
  for (const g of gaps) assert(g >= 700, `giãn bong bóng ${g}ms < 800ms`);
  // Chờ trạng thái sent trong DB.
  const after = await messagesOf(c.conv.id);
  const statuses = after.filter((m) => m.senderType === 'bot').map((m) => m.status);
  assert(
    statuses.every((s) => s === 'sent' || s === 'delivered' || s === 'seen'),
    `trạng thái tin bot: ${statuses.join(',')}`,
  );
  return `${calls.length} Send API call, giãn ${gaps.length ? gaps.map((g) => `${g}ms`).join(', ') : '(1 bong bóng)'}, trạng thái ${statuses.join(',')}`;
}

async function s2OwnEcho(): Promise<string> {
  const c = need(S.c1, 'hội thoại s2');
  // mock-graph (--echo-webhooks) gửi echo của chính app cho từng tin bot ~300ms sau khi gửi.
  await sleep(2_000);
  const conv = await conversation(c.conv.id);
  assert(!conv.aiPausedUntil, `echo của tin bot làm AI tạm dừng tới ${conv.aiPausedUntil}`);
  const msgs = await messagesOf(c.conv.id);
  const agents = msgs.filter((m) => m.senderType === 'agent');
  assert(agents.length === 0, `echo tạo ${agents.length} tin agent`);
  return 'echo tin bot không tạo tin trùng, không tạm dừng AI';
}

// ---------- s3: debounce ----------

async function s3Debounce(): Promise<string> {
  const since = sock().mark();
  const c = await newCustomer('Em ơi');
  S.c2 = c;
  const ch = need(S.ch, 'kênh');
  await sleep(1_000);
  await customerSays(ch.externalId, c.psid, 'Anh định làm biệt thự 2 tầng');
  await sleep(1_000);
  await customerSays(ch.externalId, c.psid, 'Diện tích sàn khoảng 200m², thiết kế mất bao lâu vậy?');
  const bots = await waitBotMessages(c.conv.id, since);
  await sleep(BOT_REPLY_DELAY_SEC * 1000 + 2_000);
  const rows = await dbRuns(c.conv.id);
  assert(
    rows.length === 1,
    `ai_runs có ${rows.length} dòng (mong đợi đúng 1): ${rows.map((r) => r.decision).join(',')}`,
  );
  assert(rows[0]!.triggers === 3, `trigger_message_ids có ${rows[0]!.triggers} tin (mong đợi 3)`);
  assert(rows[0]!.decision === 'reply', `decision=${rows[0]!.decision}`);
  const run = (await aiRuns(c.conv.id))[0];
  return `1 ai_run gom 3 tin · ${bots.length} bong bóng · ${fmtLatency(run)} · "${bots[0]?.text?.slice(0, 60)}…"`;
}

// ---------- s4: từ khóa chuyển người thật ----------

/** Lark lark_md: tên/tóm tắt đã escape ký tự đặc biệt bằng HTML entity (&#91; = "["). */
const decodeLarkMd = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

async function s4Escalate(): Promise<string> {
  let realLark = false;
  if (CFG.larkReal) {
    const url = process.env.E2E_LARK_WEBHOOK_URL || FILE_ENV.LARK_WEBHOOK_URL;
    assert(url, '--lark-real nhưng không có E2E_LARK_WEBHOOK_URL / LARK_WEBHOOK_URL');
    await putSetting<LarkSettingsDto>('lark', { webhookUrl: url });
    realLark = true;
  }
  try {
    const larkBefore = larkHits.length;
    const since = sock().mark();
    // Khách mới mở đầu bằng từ khóa => không phụ thuộc s2 và không tốn lượt Gemini.
    const c = await newCustomer('Chào em, cho anh xin giảm giá gói thiết kế nhà phố được không?');
    S.c4 = c;
    assert(c.conv.chatbot?.id === need(S.bot, 'bot').id, 'hội thoại mới chưa gắn bot');
    const handoff = await sock().waitFor<HandoffCreatedPayload>(
      'handoff.created',
      (p) => p.conversationId === c.conv.id,
      BOT_REPLY_DELAY_SEC * 1000 + 20_000,
      since,
    );
    // Từ khóa "giảm giá" => lý do 'discount' (bảng KEYWORD_REASON_TABLE của prefilter).
    assert(handoff.reasonCode === 'discount', `reasonCode=${handoff.reasonCode}`);
    assert(handoff.contactName.startsWith('[TEST]'), `contactName=${handoff.contactName}`);
    const updated = await sock().waitFor<ConversationUpdatedPayload>(
      'conversation.updated',
      (p) => p.conversation.id === c.conv.id && p.conversation.status === 'pending_human',
      5_000,
      since,
    );
    const conv = updated.conversation;
    assert(conv.aiMode === 'off', `aiMode=${conv.aiMode}`);
    assert(conv.chatbot?.id === need(S.bot, 'bot').id, 'chatbot bị gỡ khi chuyển người thật');
    assert(conv.handoff?.reasonCode === 'discount', `handoff=${JSON.stringify(conv.handoff)}`);
    const system = sock().list<MessageCreatedPayload>(
      'message.created',
      (p) => p.message.conversationId === c.conv.id && p.message.senderType === 'system',
      since,
    );
    const sysText = (system[0]?.payload as MessageCreatedPayload | undefined)?.message.text ?? '';
    assert(
      sysText === 'AI đã chuyển cho người thật: Khách hỏi giảm giá / khuyến mãi',
      `tin system: "${sysText}"`,
    );
    const rows = await dbRuns(c.conv.id);
    const run = rows[rows.length - 1];
    assert(
      rows.length === 1 && run?.decision === 'escalate',
      `ai_runs: ${rows.map((r) => r.decision).join(',')}`,
    );
    const dto = (await aiRuns(c.conv.id))[0];
    assert(dto && dto.inputTokens === 0 && dto.outputTokens === 0, `từ khóa vẫn gọi LLM: ${fmtLatency(dto)}`);
    let lark = '';
    if (realLark) {
      await sleep(2_000);
      assert(larkHits.length === larkBefore, 'thẻ đi vào server bắt thẻ thay vì Lark thật');
      lark = 'thẻ Lark THẬT đã gửi (xem nhóm Lark / log worker)';
    } else {
      const deadline = Date.now() + 5_000;
      while (larkHits.length === larkBefore && Date.now() < deadline) await sleep(200);
      assert(larkHits.length === larkBefore + 1, `server bắt thẻ nhận ${larkHits.length - larkBefore} thẻ`);
      const hit = larkHits[larkHits.length - 1]!.body;
      assert(hit.msg_type === 'interactive', `msg_type=${String(hit.msg_type)}`);
      assert(hit.timestamp && hit.sign, 'thẻ thiếu timestamp/sign (đã có secret)');
      const card = decodeLarkMd(JSON.stringify(hit.card));
      assert(
        card.includes(c.conv.contact.displayName),
        `thẻ không có tên khách "${c.conv.contact.displayName}"`,
      );
      assert(card.includes(`/inbox/${c.conv.id}`), 'thẻ thiếu link "Mở hội thoại"');
      lark = '1 thẻ Lark (bắt tại runner, có ký HMAC + link)';
    }
    return `handoff.created discount, tin system "${sysText.slice(29)}", không gọi LLM, ${lark}`;
  } finally {
    if (realLark) await resetLarkToCapture();
  }
}

async function s4AckResolve(): Promise<string> {
  const c = need(S.c4, 'hội thoại s4');
  const token = adminToken();
  const acked = await ok(
    api<ConversationSummary>('POST', `/conversations/${c.conv.id}/handoff/ack`, token),
    'POST handoff/ack',
  );
  assert(
    acked.handoff?.acknowledgedBy?.id === S.admin!.user.id,
    `acknowledgedBy=${JSON.stringify(acked.handoff)}`,
  );
  assert(acked.assignedUser?.id === S.admin!.user.id, 'ack không tự nhận hội thoại');
  assert(acked.status === 'pending_human', `status sau ack=${acked.status}`);
  // KHÔNG nhắn gì trong hộp thư (nhân viên xử lý ngoài hệ thống, ví dụ gọi điện) rồi trả lại cho AI.
  const runsBefore = (await dbRuns(c.conv.id)).length;
  const since = sock().mark();
  const resolved = await ok(
    api<ConversationSummary>('POST', `/conversations/${c.conv.id}/handoff/resolve`, token),
    'POST handoff/resolve',
  );
  assert(resolved.status === 'open', `status=${resolved.status}`);
  assert(resolved.aiMode === 'auto', `aiMode=${resolved.aiMode}`);
  assert(!resolved.handoff, `handoff còn: ${JSON.stringify(resolved.handoff)}`);
  assert(!resolved.aiPausedUntil, `aiPausedUntil=${resolved.aiPausedUntil}`);
  // Tin cuối là của khách => API "đánh thức" bot, nhưng tin "giảm giá" đã được xử lý (mốc resolve) nên
  // bot không được chạy lại trên nó (không chuyển người lần nữa).
  await sleep(BOT_REPLY_DELAY_SEC * 1000 + 4_000);
  const runsAfter = await dbRuns(c.conv.id);
  assert(
    runsAfter.length === runsBefore,
    `sau resolve có thêm ai_run: ${runsAfter.map((r) => `${r.decision}/${r.triggers}`).join(',')}`,
  );
  const again = sock().list<HandoffCreatedPayload>(
    'handoff.created',
    (p) => p.conversationId === c.conv.id,
    since,
  );
  assert(again.length === 0, 'chuyển người thật lần nữa ngay sau resolve');
  return 'ack: gán admin + acknowledgedBy; resolve (không nhắn gì): open, auto, handoff null; kick không chạy lại tin cũ';
}

async function s4Resume(): Promise<string> {
  const c = need(S.c4, 'hội thoại s4');
  const ch = need(S.ch, 'kênh');
  const since = sock().mark();
  // Câu hỏi KHÁC chủ đề: bot phải trả lời, không chuyển người lại vì yêu cầu giảm giá cũ trong lịch sử.
  const before = (await dbRuns(c.conv.id)).length;
  await customerSays(ch.externalId, c.psid, 'À em ơi, thời gian thiết kế nhà phố mất bao lâu vậy?');
  const rows = await waitRuns(c.conv.id, before + 1, BOT_REPLY_DELAY_SEC * 1000 + 45_000);
  const last = rows[rows.length - 1]!;
  const run = (await aiRuns(c.conv.id))[0];
  assert(
    last.decision === 'reply',
    `bot ${last.decision} thay vì trả lời: ${fmtLatency(run)} ${run?.reasoningSummary ?? ''}`,
  );
  const bots = await waitBotMessages(c.conv.id, since, 15_000);
  return `không chuyển người lại; ${bots.length} bong bóng · ${fmtLatency(run)} · "${bots[0]?.text?.slice(0, 70)}…"`;
}

/** (d) "Xong" (PATCH status resolved) lúc đang chờ người => đóng handoff, bot vẫn tắt; bật lại ĐÚNG bot => auto. */
async function s4StatusResolved(): Promise<string> {
  const token = adminToken();
  const bot = need(S.bot, 'bot');
  const since = sock().mark();
  const c = await newCustomer('Anh muốn khiếu nại về tiến độ thiết kế');
  await sock().waitFor<HandoffCreatedPayload>(
    'handoff.created',
    (p) => p.conversationId === c.conv.id,
    BOT_REPLY_DELAY_SEC * 1000 + 20_000,
    since,
  );
  const esc = await conversation(c.conv.id);
  assert(esc.handoff?.reasonCode === 'complaint', `từ khóa "khiếu nại" => ${esc.handoff?.reasonCode}`);
  const done = await ok(
    api<ConversationSummary>('PATCH', `/conversations/${c.conv.id}`, token, { status: 'resolved' }),
    'PATCH status resolved',
  );
  assert(done.status === 'resolved', `status=${done.status}`);
  assert(!done.handoff, `handoff vẫn mở: ${JSON.stringify(done.handoff)}`);
  assert(done.aiMode === 'off', `aiMode=${done.aiMode} (Xong phải giữ bot tắt)`);
  assert(done.chatbot?.id === bot.id, 'chatbot bị gỡ');
  const runsBefore = (await dbRuns(c.conv.id)).length;
  const again = await ok(
    api<ConversationSummary>('PATCH', `/conversations/${c.conv.id}/chatbot`, token, { chatbotId: bot.id }),
    'PATCH chatbot (bật lại)',
  );
  assert(again.aiMode === 'auto', `aiMode=${again.aiMode}`);
  assert(again.chatbot?.id === bot.id && !again.handoff, `chatbot=${JSON.stringify(again.chatbot)}`);
  await sleep(BOT_REPLY_DELAY_SEC * 1000 + 4_000);
  const runsAfter = await dbRuns(c.conv.id);
  assert(
    runsAfter.length === runsBefore,
    `bật lại bot chạy lại tin "khiếu nại" cũ (${runsAfter.length - runsBefore} ai_run)`,
  );
  return `complaint -> Xong: resolved, handoff đóng, ai_mode off -> bật lại: auto (status ${again.status}), không chạy lại tin cũ`;
}

// ---------- s5: nhân viên nhắn -> tạm dừng ----------

async function s5Pause(): Promise<string> {
  const c = need(S.c2, 'hội thoại s3');
  const ch = need(S.ch, 'kênh');
  const res = await api<{ messages: MessageDto[]; conversation?: ConversationSummary }>(
    'POST',
    `/conversations/${c.conv.id}/messages`,
    adminToken(),
    { text: 'Dạ em là nhân viên Dezon, em hỗ trợ anh tiếp nhé', clientId: `e2ebot-${RUN}` },
  );
  assert(res.status === 201, `POST messages: ${errMsg(res)}`);
  const conv = await conversation(c.conv.id);
  assert(conv.aiPausedUntil, 'aiPausedUntil chưa được đặt sau khi nhân viên nhắn');
  const minutes = Math.round((Date.parse(conv.aiPausedUntil) - Date.now()) / 60_000);
  assert(minutes >= 25 && minutes <= 31, `tạm dừng ${minutes} phút (mong đợi ~30)`);
  const before = (await dbRuns(c.conv.id)).length;
  const since = sock().mark();
  await customerSays(ch.externalId, c.psid, 'Vâng, anh cảm ơn');
  const rows = await waitRuns(c.conv.id, before + 1, BOT_REPLY_DELAY_SEC * 1000 + 15_000);
  const run = rows[rows.length - 1]!;
  assert(run.decision === 'no_reply', `decision=${run.decision}`);
  assert(/tạm dừng/i.test(run.error ?? ''), `lý do=${run.error}`);
  await expectNoBot(c.conv.id, since, 1_000);
  return `aiPausedUntil +${minutes} phút; tin khách lúc tạm dừng => ai_run no_reply "${run.error}"`;
}

async function s5Resume(): Promise<string> {
  const c = need(S.c2, 'hội thoại s3');
  const ch = need(S.ch, 'kênh');
  const resumed = await ok(
    api<ConversationSummary>('POST', `/conversations/${c.conv.id}/ai/resume`, adminToken()),
    'POST ai/resume',
  );
  assert(!resumed.aiPausedUntil, `aiPausedUntil=${resumed.aiPausedUntil}`);
  const since = sock().mark();
  await customerSays(ch.externalId, c.psid, 'Em ơi cho anh hỏi thêm, hồ sơ thiết kế gồm những gì?');
  const bots = await waitBotMessages(c.conv.id, since);
  const run = (await aiRuns(c.conv.id))[0];
  assert(run?.decision === 'reply', `ai_run: ${fmtLatency(run)}`);
  return `"Tiếp tục AI" => bot trả lời ${bots.length} bong bóng · ${fmtLatency(run)}`;
}

// ---------- s6: công tắc AI tổng + ngoài giờ làm việc ----------

async function s6Off(): Promise<string> {
  const c = need(S.c2, 'hội thoại s3');
  const ch = need(S.ch, 'kênh');
  const off = await putSetting<{ enabled: boolean }>('ai', { enabled: false });
  assert(off.enabled === false, 'không tắt được AI tổng');
  try {
    const before = (await dbRuns(c.conv.id)).length;
    const since = sock().mark();
    await customerSays(ch.externalId, c.psid, 'Alo em');
    await expectNoBot(c.conv.id, since, BOT_REPLY_DELAY_SEC * 1000 + 5_000);
    const after = (await dbRuns(c.conv.id)).length;
    assert(after === before, `AI tắt mà vẫn ghi ${after - before} ai_run`);
  } finally {
    await putSetting('ai', { enabled: true });
  }
  return 'AI tổng tắt => không trả lời, không ghi ai_runs; đã bật lại';
}

async function s6OnOutsideHours(): Promise<string> {
  const c = need(S.c2, 'hội thoại s3');
  const ch = need(S.ch, 'kênh');
  await putSetting('business-hours', { timezone: 'Asia/Ho_Chi_Minh', days: CLOSED });
  try {
    const since = sock().mark();
    await customerSays(ch.externalId, c.psid, 'Bây giờ bên mình còn làm việc không em?');
    const bots = await waitBotMessages(c.conv.id, since);
    const run = (await aiRuns(c.conv.id))[0];
    assert(run?.decision === 'reply', `ai_run: ${fmtLatency(run)}`);
    const pg = need(S.pg, 'pg');
    const trig = await pg.query<{ n: number }>(
      `select cardinality(trigger_message_ids)::int as n from ai_runs where id = $1`,
      [run.id],
    );
    // Tin "Alo em" lúc AI tắt không bị đánh dấu đã xử lý => lượt này gom cả 2 tin.
    assert(trig.rows[0]?.n === 2, `trigger=${trig.rows[0]?.n} (mong đợi 2: tin lúc AI tắt + tin mới)`);
    const text = bots.map((m) => m.text).join(' ');
    return `AI bật lại + ngoài giờ (bot vẫn trả lời theo brief: chỉ là ngữ cảnh prompt) · gom 2 tin · ${fmtLatency(run)} · "${text.slice(0, 90)}…"`;
  } finally {
    await putSetting('business-hours', { timezone: 'Asia/Ho_Chi_Minh', days: ALL_DAY });
  }
}

// ---------- s7: chat thử ----------

async function s7Test(): Promise<string> {
  const bot = need(S.bot, 'chatbot');
  const res = await api<ChatbotTestResult>(
    'POST',
    `/chatbots/${bot.id}/test`,
    adminToken(),
    { messages: [{ role: 'customer', text: 'Cho em hỏi giá thiết kế nội thất căn hộ 80m² ạ?' }] },
    60_000,
  );
  assert(res.status === 200 || res.status === 201, `POST /chatbots/:id/test: ${errMsg(res)}`);
  const r = res.body;
  assert(r.decision === 'reply', `decision=${r.decision} ${r.reason ?? r.summary ?? ''}`);
  const text = (r.messages ?? []).join(' ');
  assert(text && VI_DIACRITICS.test(text), `trả lời không phải tiếng Việt: "${text}"`);
  assert(r.latencyMs > 0 && r.model, `latency/model: ${r.latencyMs} ${r.model}`);
  return `${r.messages!.length} bong bóng · ${r.latencyMs}ms · ${r.model} · in=${r.usage?.inputTokens} out=${r.usage?.outputTokens} · "${text.slice(0, 90)}…"`;
}

async function s7LarkTest(): Promise<string> {
  const before = larkHits.length;
  const res = await api<{ ok: boolean }>('POST', '/settings/lark/test', adminToken());
  assert(res.status === 200, `POST /settings/lark/test: ${errMsg(res)}`);
  assert(larkHits.length === before + 1, `server bắt thẻ nhận ${larkHits.length - before} thẻ`);
  return 'thẻ thử tới server bắt thẻ (Lark dự phòng từ env)';
}

// ---------- s8: giới hạn lượt trả lời/giờ ----------

async function s8HourlyCap(): Promise<string> {
  const c = need(S.c2, 'hội thoại s3');
  const ch = need(S.ch, 'kênh');
  const bot = need(S.bot, 'chatbot');
  await ok(
    api('PATCH', `/chatbots/${bot.id}`, adminToken(), { maxRepliesPerHour: 1 }),
    'PATCH maxRepliesPerHour',
  );
  try {
    const before = (await dbRuns(c.conv.id)).length;
    const since = sock().mark();
    await customerSays(ch.externalId, c.psid, 'Em gửi anh báo giá chi tiết nhé');
    const rows = await waitRuns(c.conv.id, before + 1, BOT_REPLY_DELAY_SEC * 1000 + 15_000);
    const run = rows[rows.length - 1]!;
    assert(run.decision === 'no_reply', `decision=${run.decision}`);
    assert(/giới hạn/i.test(run.error ?? ''), `lý do=${run.error}`);
    await expectNoBot(c.conv.id, since, 1_000);
    return `max_replies_per_hour=1 => no_reply "${run.error}"`;
  } finally {
    await ok(api('PATCH', `/chatbots/${bot.id}`, adminToken(), { maxRepliesPerHour: 20 }), 'PATCH khôi phục');
  }
}

// ---------- s9: chống đua (6.4) ----------

/**
 * Khách nhắn thêm đúng lúc Gemini đang trả lời => lượt đang chạy tự hủy (ai_run no_reply "Đã hủy: Khách vừa
 * nhắn thêm", trigger rỗng), debounce chạy lại và một lượt gom cả 2 tin. Dựa vào thời gian (job chạy ~3s sau
 * tin, Gemini mất 2–5s); nếu tin thứ 2 không rơi vào lúc Gemini chạy thì báo SKIP thay vì FAIL.
 */
async function s9Race(): Promise<string> {
  const c = need(S.c1, 'hội thoại s2');
  const ch = need(S.ch, 'kênh');
  const before = (await dbRuns(c.conv.id)).length;
  const since = sock().mark();
  await customerSays(ch.externalId, c.psid, 'À em ơi, bên mình có nhận thiết kế nhà ở tỉnh không?');
  await sleep(BOT_REPLY_DELAY_SEC * 1000 + 1_200);
  await customerSays(ch.externalId, c.psid, 'Nhà anh ở Bắc Ninh');
  // Chờ tới khi có một lượt "thật" (không phải lượt bị hủy) — Gemini có thể trả lời hoặc chuyển người thật
  // (câu hỏi nằm ngoài kiến thức của bot), cả hai đều hợp lệ.
  const deadline = Date.now() + 90_000;
  let rows = (await dbRuns(c.conv.id)).slice(before);
  const isFinal = (r: (typeof rows)[number]) => r.triggers > 0;
  while (!rows.some(isFinal) && Date.now() < deadline) {
    await sleep(1_000);
    rows = (await dbRuns(c.conv.id)).slice(before);
  }
  await sleep(BOT_REPLY_DELAY_SEC * 1000 + 3_000);
  rows = (await dbRuns(c.conv.id)).slice(before);
  const summary = rows.map((r) => `${r.decision}/${r.triggers}${r.error ? ` "${r.error}"` : ''}`).join(', ');
  const cancelled = rows.filter((r) => r.decision === 'no_reply' && r.triggers === 0);
  const finals = rows.filter(isFinal);
  if (cancelled.length === 0) {
    skip(`tin thứ 2 không rơi vào lúc Gemini đang chạy (ai_runs: ${summary}) — chạy lại mục s9`);
  }
  assert(/Khách vừa nhắn thêm/.test(cancelled[0]!.error ?? ''), `lý do hủy: ${cancelled[0]!.error}`);
  assert(finals.length === 1 && finals[0]!.triggers === 2, `ai_runs sau hủy: ${summary}`);
  const decision = finals[0]!.decision;
  assert(decision === 'reply' || decision === 'escalate', `lượt gom có decision=${decision}`);
  const bots = sock().list<MessageCreatedPayload>(
    'message.created',
    (p) => p.message.conversationId === c.conv.id && p.message.senderType === 'bot',
    since,
  );
  if (decision === 'reply') {
    assert(
      bots.length >= 1 && bots.length <= 3,
      `${bots.length} tin bot mới (mong đợi 1 lượt, 1–3 bong bóng)`,
    );
  } else {
    // Dọn: trả hội thoại về cho AI để chạy lại runner không bị kẹt pending_human.
    const token = adminToken();
    await ok(api('POST', `/conversations/${c.conv.id}/handoff/resolve`, token), 'POST handoff/resolve');
  }
  return `ai_runs: ${summary} · lượt gom: ${decision}, ${bots.length} tin bot mới`;
}

// ---------- s10: bật bot cho hội thoại khách đang chờ ----------

/** (b) Hội thoại không có bot, tin cuối của khách => bật bot => bot tự trả lời (job "kick"), không cần tin mới. */
async function s10Kick(): Promise<string> {
  const token = adminToken();
  const bot = need(S.bot, 'bot');
  const ch = need(S.ch, 'kênh');
  // Tạm bỏ bot mặc định của kênh để hội thoại mới không có bot.
  await ok(api('PATCH', `/channels/${ch.id}`, token, { defaultChatbotId: null }), 'PATCH bỏ bot mặc định');
  let c: { psid: string; conv: ConversationSummary };
  try {
    c = await newCustomer('Chào shop, bên mình có thiết kế nội thất chung cư không ạ?');
  } finally {
    await ok(
      api('PATCH', `/channels/${ch.id}`, token, { defaultChatbotId: bot.id }),
      'PATCH khôi phục bot mặc định',
    );
  }
  assert(
    !c.conv.chatbot && c.conv.aiMode === 'off',
    `hội thoại mới đã có bot: ${JSON.stringify(c.conv.chatbot)}`,
  );
  await sleep(BOT_REPLY_DELAY_SEC * 1000 + 1_000);
  assert((await dbRuns(c.conv.id)).length === 0, 'không có bot mà vẫn có ai_run');
  const since = sock().mark();
  const enabled = await ok(
    api<ConversationSummary>('PATCH', `/conversations/${c.conv.id}/chatbot`, token, { chatbotId: bot.id }),
    'PATCH chatbot',
  );
  assert(enabled.aiMode === 'auto' && enabled.chatbot?.id === bot.id, `aiMode=${enabled.aiMode}`);
  const bots = await waitBotMessages(c.conv.id, since);
  const rows = await dbRuns(c.conv.id);
  assert(
    rows.length === 1 && rows[0]!.decision === 'reply' && rows[0]!.triggers === 1,
    `ai_runs: ${rows.map((r) => `${r.decision}/${r.triggers}`).join(',')}`,
  );
  const run = (await aiRuns(c.conv.id))[0];
  return `bật bot => tự trả lời tin đang chờ: ${bots.length} bong bóng · ${fmtLatency(run)}`;
}

// ---------- s11: bot trung tính do quản trị tự định nghĩa + escalateWhenUnsure=false ----------

const BOT2_NAME = 'Bot nội bộ [TEST]';
const BOT2_INSTRUCTIONS = [
  'Bạn là trợ lý nội bộ của văn phòng Dezon, hỗ trợ đồng nghiệp các câu hỏi hành chính và văn phòng.',
  'Xưng "mình", gọi người nhắn là "bạn". Giọng thân mật như đồng nghiệp, ngắn gọn. Không chào bán sản phẩm hay dịch vụ.',
].join('\n');
const BOT2_KNOWLEDGE = [
  'Giờ làm việc văn phòng: 8:00–17:30 thứ Hai đến thứ Sáu.',
  'Wifi nhân viên: Dezon-Staff.',
].join('\n');

/**
 * (a) Bot mới tạo chỉ với tên => trung tính: không từ khóa chuyển người, hướng dẫn rỗng, escalateWhenUnsure mặc
 * định true. (b) Bot persona "trợ lý nội bộ" + escalateWhenUnsure=false, khách hỏi câu NGOÀI kiến thức => bot
 * trả lời (không chuyển người), dùng xưng hô của Hướng dẫn. 1 lượt Gemini.
 */
async function s11Neutral(): Promise<string> {
  const token = adminToken();
  const bare = await ok(
    api<ChatbotDto>('POST', '/chatbots', token, { name: `Bot trống ${RUN} [TEST]` }),
    'POST /chatbots (chỉ tên)',
  );
  try {
    assert(bare.handoffKeywords.length === 0, `bot mới có sẵn từ khóa: ${bare.handoffKeywords.join(', ')}`);
    assert(bare.instructions === '', `bot mới có sẵn hướng dẫn: "${bare.instructions.slice(0, 60)}"`);
    assert(
      bare.escalateWhenUnsure === true,
      `escalateWhenUnsure mặc định=${String(bare.escalateWhenUnsure)}`,
    );
  } finally {
    await api('DELETE', `/chatbots/${bare.id}`, token);
  }
  return 'bot chỉ có tên: handoffKeywords=[], instructions="", escalateWhenUnsure=true';
}

async function s11Unsure(): Promise<string> {
  const token = adminToken();
  const ch = need(S.ch, 'kênh');
  const bot = need(S.bot, 'bot');
  const config = {
    name: BOT2_NAME,
    description: '[TEST] bot nội bộ của runner e2e-chatbot',
    isActive: true,
    instructions: BOT2_INSTRUCTIONS,
    knowledge: BOT2_KNOWLEDGE,
    examples: [],
    handoffKeywords: [],
    handoffMessage: null,
    model: null,
    temperature: 0.4,
    replyDelaySec: BOT_REPLY_DELAY_SEC,
    maxWaitSec: 20,
    maxRepliesPerHour: 20,
    escalateWhenUnsure: false,
  };
  const list = await ok(api<ChatbotSummary[]>('GET', '/chatbots', token), 'GET /chatbots');
  const existing = list.find((b) => b.name === BOT2_NAME);
  const bot2 = existing
    ? await ok(api<ChatbotDto>('PATCH', `/chatbots/${existing.id}`, token, config), 'PATCH bot nội bộ')
    : await ok(api<ChatbotDto>('POST', '/chatbots', token, config), 'POST bot nội bộ');
  assert(bot2.escalateWhenUnsure === false, `escalateWhenUnsure=${String(bot2.escalateWhenUnsure)}`);
  const pg = need(S.pg, 'pg');
  const dbFlag = await pg.query<{ v: boolean }>(
    'select escalate_when_unsure as v from chatbots where id = $1',
    [bot2.id],
  );
  assert(dbFlag.rows[0]?.v === false, `DB escalate_when_unsure=${String(dbFlag.rows[0]?.v)}`);
  await ok(
    api('PATCH', `/channels/${ch.id}`, token, { defaultChatbotId: bot2.id }),
    'PATCH bot mặc định = bot 2',
  );
  let c: { psid: string; conv: ConversationSummary };
  const since = sock().mark();
  try {
    c = await newCustomer('Bạn ơi, công ty mình có cho nghỉ bù ngày Quốc khánh năm nay không nhỉ?');
  } finally {
    await ok(
      api('PATCH', `/channels/${ch.id}`, token, { defaultChatbotId: bot.id }),
      'PATCH khôi phục bot mặc định',
    );
  }
  assert(c.conv.chatbot?.id === bot2.id, `chatbot=${JSON.stringify(c.conv.chatbot)}`);
  const rows = await waitRuns(c.conv.id, 1, BOT_REPLY_DELAY_SEC * 1000 + 45_000);
  const run = (await aiRuns(c.conv.id))[0];
  const calls = JSON.stringify(run?.toolCalls ?? null).slice(0, 200);
  assert(
    rows[0]!.decision === 'reply',
    `decision=${rows[0]!.decision} (mong đợi reply) · ${run?.reasoningSummary ?? ''} · ${calls}`,
  );
  const bots = await waitBotMessages(c.conv.id, since, 15_000);
  const text = bots
    .map((m) => m.text ?? '')
    .join(' ')
    .toLowerCase();
  const usesPersona = text.includes('mình') || text.includes('bạn');
  const usesDefault = /\bem\b|anh\/chị|anh chị/.test(text);
  assert(usesPersona, `không dùng xưng hô "mình/bạn" của Hướng dẫn: "${text.slice(0, 120)}"`);
  assert(!usesDefault, `vẫn dùng xưng hô mặc định em/anh chị: "${text.slice(0, 120)}"`);
  const conv = await conversation(c.conv.id);
  assert(!conv.handoff && conv.status !== 'pending_human', `hội thoại bị chuyển người: ${conv.status}`);
  return `reply (không escalate) · ${bots.length} bong bóng · ${fmtLatency(run)} · ${calls.slice(0, 80)} · "${text.slice(0, 110)}…"`;
}

// ---------- s12: đo độ trễ trả lời + "đang soạn tin" (chỉ chạy với --latency hoặc --only s12) ----------

const LATENCY_BOT_NAME = 'Bot đo tốc độ';
/** Mục tiêu: tin đầu của bot tới Send API < 4 s tính từ lúc webhook tới. */
const LATENCY_TARGET_MS = 4_000;
const LATENCY_INSTRUCTIONS = [
  'Bạn là trợ lý tư vấn của Dezon (thiết kế nhà). Xưng "em", gọi khách là "anh/chị".',
  'Trả lời ngắn gọn bằng 2 tin nhắn: tin 1 trả lời câu hỏi, tin 2 hỏi thêm một thông tin.',
  'Chỉ dùng giá trong phần kiến thức.',
].join('\n');
const LATENCY_KNOWLEDGE = [
  '- Thiết kế kiến trúc nhà phố: 150.000đ/m² sàn; biệt thự: 200.000đ/m² sàn.',
  '- Thiết kế nội thất: 180.000đ/m² sàn.',
  '- Thời gian thiết kế nhà phố 20–30 ngày làm việc.',
].join('\n');
const LATENCY_QUESTIONS = [
  'Chào em, thiết kế nhà phố 3 tầng mỗi sàn 50m² hết bao nhiêu tiền?',
  'Thiết kế nội thất căn hộ 70m² giá sao em?',
  'Bên em thiết kế mất bao lâu?',
  'Biệt thự 2 tầng 150m² sàn thì phí thiết kế bao nhiêu?',
  'Nhà phố 4 tầng thì tính phí thế nào?',
  'Thiết kế nội thất cho nhà phố 3 tầng 180m² sàn hết bao nhiêu?',
  'Biệt thự thì phí thiết kế kiến trúc tính sao em?',
  'Nhà phố 2 tầng 80m² sàn thì phí thiết kế kiến trúc bao nhiêu?',
];
/** Câu hỏi kế tiếp (xoay vòng; luôn nằm trong phần kiến thức để bot không chuyển người). */
let latencyQuestionSeq = 0;

interface SenderActionRow {
  n: number;
  at: string;
  psid: string;
  action: string;
}

interface LatencyTrial {
  label: string;
  kind: 'mới' | 'tiếp';
  /** Mọi mốc tính bằng ms từ t0 = lúc bắt đầu POST webhook đã ký ("khách vừa gửi"). */
  acceptedMs: number;
  storedMs: number;
  typingRtMs: number | null;
  typingOnMs: number | null;
  commitMs: number;
  firstSendMs: number;
  llmMs: number;
  model: string;
  bubbles: number;
  typingOff: boolean;
  typingBeforeFirst: boolean;
  typingBeforeEach: boolean;
  gapsMs: number[];
}

const latencyTrials: LatencyTrial[] = [];
/** Số lần gửi tin mock đã thấy theo PSID (lượt "tiếp" chỉ xét các lần gửi mới). */
const latencyCallCount = new Map<string, number>();
const latencyOpts = { trials0: 6, trials1: 3, balanced: 2 };

const isoMs = (iso: string) => Date.parse(iso);

async function senderActionsOf(psid: string): Promise<SenderActionRow[]> {
  const res = await http<{ actions: SenderActionRow[] }>(
    `${CFG.mock}/__sender_actions?${new URLSearchParams({ psid })}`,
  );
  return res.body.actions;
}

async function sendCallsWithSeq(psid: string): Promise<Array<MockCall & { n: number }>> {
  return (await sendApiCallsTo(psid)) as Array<MockCall & { n: number }>;
}

/** Bot đo tốc độ: tạo/cập nhật + đặt mặc định cho kênh (khách mới sẽ gắn bot này). */
async function useLatencyBot(replyDelaySec: number, responseSpeed: ChatbotDto['responseSpeed']) {
  const token = adminToken();
  const config = {
    name: LATENCY_BOT_NAME,
    description: '[TEST] bot đo độ trễ của runner e2e-chatbot',
    isActive: true,
    instructions: LATENCY_INSTRUCTIONS,
    knowledge: LATENCY_KNOWLEDGE,
    examples: [],
    handoffKeywords: [],
    handoffMessage: null,
    model: null,
    temperature: 0.4,
    replyDelaySec,
    maxWaitSec: 10,
    maxRepliesPerHour: 60,
    // Đo độ trễ lượt 'reply': không chuyển người khi bot không chắc (lượt escalate làm hội thoại chờ người).
    escalateWhenUnsure: false,
    responseSpeed,
  };
  const list = await ok(api<ChatbotSummary[]>('GET', '/chatbots', token), 'GET /chatbots');
  const existing = list.find((b) => b.name === LATENCY_BOT_NAME);
  const bot = existing
    ? await ok(api<ChatbotDto>('PATCH', `/chatbots/${existing.id}`, token, config), 'PATCH bot đo tốc độ')
    : await ok(api<ChatbotDto>('POST', '/chatbots', token, config), 'POST bot đo tốc độ');
  assert(bot.replyDelaySec === replyDelaySec, `replyDelaySec=${bot.replyDelaySec}`);
  assert(bot.responseSpeed === responseSpeed, `responseSpeed=${String(bot.responseSpeed)}`);
  const ch = need(S.ch, 'kênh');
  if (ch.defaultChatbotId !== bot.id) {
    S.ch = await ok(
      api<ChannelAccountDto>('PATCH', `/channels/${ch.id}`, token, { defaultChatbotId: bot.id }),
      'PATCH /channels defaultChatbotId',
    );
  }
  return bot;
}

/** Trả kênh về bot của các mục khác (s1e). */
async function restoreDefaultBot(): Promise<void> {
  const bot = S.bot;
  const ch = S.ch;
  if (!bot || !ch || ch.defaultChatbotId === bot.id) return;
  S.ch = await ok(
    api<ChannelAccountDto>('PATCH', `/channels/${ch.id}`, adminToken(), { defaultChatbotId: bot.id }),
    'PATCH /channels defaultChatbotId (trả lại)',
  );
}

/**
 * Một lượt đo: khách gửi 1 tin (hội thoại mới, hoặc tiếp sau lượt trước) → chờ đủ bong bóng tới mock.
 * Mốc giờ đều theo đồng hồ máy này (runner + mock-graph cùng máy; socket = lúc runner nhận sự kiện).
 */
async function latencyTrial(
  label: string,
  question: string,
  prev?: { psid: string; conversationId: string },
): Promise<{ psid: string; conversationId: string }> {
  const ch = need(S.ch, 'kênh');
  const psid = prev?.psid ?? newPsid();
  const nonReplyBefore = prev ? await nonReplyRuns(prev.conversationId) : 0;
  const since = sock().mark();
  const t0 = Date.now();
  await customerSays(ch.externalId, psid, question);
  const acceptedMs = Date.now() - t0;
  const created = await sock().waitFor<MessageCreatedPayload>(
    'message.created',
    (p) => p.message.senderType === 'customer' && p.message.text === question,
    10_000,
    since,
  );
  const conversationId = created.conversation.id;
  const storedAt = sock()
    .list<MessageCreatedPayload>(
      'message.created',
      (p) => p.message.senderType === 'customer' && p.message.text === question,
      since,
    )
    .at(0)!.at;
  const watch = { done: false };
  const bots = await Promise.race([
    waitBotMessages(conversationId, since, 60_000),
    failOnNonReplyRun(label, conversationId, nonReplyBefore, watch),
  ]).finally(() => {
    watch.done = true;
  });
  // Đợi mock nhận đủ bong bóng (giãn 0,8–1,5 s mỗi bong bóng).
  const before = latencyCallCount.get(psid) ?? 0;
  const deadline = Date.now() + 15_000;
  let calls = await sendCallsWithSeq(psid);
  while (calls.length - before < bots.length && Date.now() < deadline) {
    await sleep(300);
    calls = await sendCallsWithSeq(psid);
  }
  const mine = calls.slice(before);
  latencyCallCount.set(psid, calls.length);
  assert(mine.length === bots.length, `${label}: mock nhận ${mine.length} tin, có ${bots.length} tin bot`);
  const typingOns = (await senderActionsOf(psid)).filter(
    (a) => a.action === 'typing_on' && isoMs(a.at) >= t0,
  );
  const ofConv = (typing: boolean) =>
    sock().list<AiTypingPayload>(
      'ai.typing',
      (p) => p.conversationId === conversationId && p.typing === typing,
      since,
    )[0];
  const typingRt = ofConv(true);
  const typingOffRt = ofConv(false);
  const commitAt = sock().list<MessageCreatedPayload>(
    'message.created',
    (p) => p.message.conversationId === conversationId && p.message.senderType === 'bot',
    since,
  )[0]!.at;
  const pg = need(S.pg, 'kết nối Postgres');
  const run = (
    await pg.query<{ decision: string; latency_ms: number; model: string }>(
      `select decision, latency_ms, model from ai_runs where conversation_id = $1
        order by created_at desc, id desc limit 1`,
      [conversationId],
    )
  ).rows[0];
  assert(run?.decision === 'reply', `${label}: ai_run decision=${String(run?.decision)}`);
  const first = mine[0]!;
  const trial: LatencyTrial = {
    label,
    kind: prev ? 'tiếp' : 'mới',
    acceptedMs,
    storedMs: storedAt - t0,
    typingRtMs: typingRt ? typingRt.at - t0 : null,
    typingOnMs: typingOns[0] ? isoMs(typingOns[0].at) - t0 : null,
    commitMs: commitAt - t0,
    firstSendMs: isoMs(first.at) - t0,
    llmMs: run.latency_ms,
    model: run.model,
    bubbles: mine.length,
    typingOff: Boolean(typingOffRt),
    typingBeforeFirst: typingOns.some((a) => a.n < first.n),
    typingBeforeEach: mine.every(
      (c, i) => i === 0 || typingOns.some((a) => a.n > mine[i - 1]!.n && a.n < c.n),
    ),
    gapsMs: mine.slice(1).map((c, i) => isoMs(c.at) - isoMs(mine[i]!.at)),
  };
  latencyTrials.push(trial);
  const f = (v: number | null) => String(v ?? '—').padStart(5);
  console.log(
    `     ${label.padEnd(18)} ${trial.kind.padEnd(4)} 200 ${f(acceptedMs)} · lưu ${f(trial.storedMs)} · ` +
      `ai.typing ${f(trial.typingRtMs)} · typing_on ${f(trial.typingOnMs)} · LLM ${f(trial.llmMs)} · ` +
      `commit ${f(trial.commitMs)} · TIN ĐẦU ${f(trial.firstSendMs)} ms · ${trial.bubbles} bb` +
      (trial.gapsMs.length ? ` (giãn ${trial.gapsMs.join('/')})` : ''),
  );
  return { psid, conversationId };
}

async function nonReplyRuns(conversationId: string): Promise<number> {
  return (await dbRuns(conversationId)).filter((r) => r.decision !== 'reply').length;
}

/** Lượt không phải 'reply' (escalate/no_reply/error…) ⇒ báo lỗi ngay thay vì chờ hết 60 s. */
async function failOnNonReplyRun(
  label: string,
  conversationId: string,
  before: number,
  watch: { done: boolean },
): Promise<never> {
  const deadline = Date.now() + 65_000;
  while (!watch.done && Date.now() < deadline) {
    await sleep(500);
    const rows = (await dbRuns(conversationId)).filter((r) => r.decision !== 'reply');
    if (rows.length > before) {
      const last = rows.at(-1)!;
      throw new Error(`${label}: ai_run ${last.decision}${last.error ? ` (${last.error})` : ''}`);
    }
  }
  return new Promise<never>(() => undefined);
}

/** Phân vị kiểu nearest-rank. */
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
};

async function latencySeries(
  tag: string,
  replyDelaySec: number,
  speed: ChatbotDto['responseSpeed'],
  trials: number,
  enforce: boolean,
): Promise<string> {
  if (trials <= 0) skip('số lượt = 0');
  await useLatencyBot(replyDelaySec, speed);
  const start = latencyTrials.length;
  let prev: { psid: string; conversationId: string } | undefined;
  for (let i = 0; i < trials; i++) {
    const q = LATENCY_QUESTIONS[latencyQuestionSeq++ % LATENCY_QUESTIONS.length]!;
    prev = await latencyTrial(`${tag}#${i + 1}`, q, prev);
    await sleep(1_500); // để echo của tin bot về xong trước tin khách kế tiếp
  }
  const mine = latencyTrials.slice(start);
  const first = mine.map((t) => t.firstSendMs);
  const typingOn = mine.map((t) => t.typingOnMs).filter((x): x is number => x !== null);
  const llm = mine.map((t) => t.llmMs);
  const summary =
    `n=${mine.length} · TIN ĐẦU p50 ${pct(first, 50)} / max ${Math.max(...first)} ms · typing_on p50 ` +
    `${typingOn.length ? pct(typingOn, 50) : '—'} / max ${typingOn.length ? Math.max(...typingOn) : '—'} ms · ` +
    `LLM p50 ${pct(llm, 50)} ms · model ${mine[0]?.model}`;
  if (enforce) {
    assert(pct(first, 50) < LATENCY_TARGET_MS, `p50 tin đầu ≥ ${LATENCY_TARGET_MS}ms: ${summary}`);
  }
  return summary;
}

async function s12Delay0(): Promise<string> {
  return latencySeries('fast/delay0', 0, 'fast', latencyOpts.trials0, true);
}

async function s12Delay1(): Promise<string> {
  return latencySeries('fast/delay1', 1, 'fast', latencyOpts.trials1, true);
}

async function s12Balanced(): Promise<string> {
  return latencySeries('balanced/delay0', 0, 'balanced', latencyOpts.balanced, false);
}

async function s12Typing(): Promise<string> {
  try {
    if (latencyTrials.length === 0) skip('không có lượt đo nào');
    const bad = (pred: (t: LatencyTrial) => boolean) =>
      latencyTrials.filter((t) => !pred(t)).map((t) => t.label);
    const noOn = bad((t) => t.typingOnMs !== null && t.typingBeforeFirst);
    const noRt = bad((t) => t.typingRtMs !== null && t.typingOff);
    const noEach = bad((t) => t.typingBeforeEach);
    assert(noOn.length === 0, `thiếu typing_on trước tin đầu: ${noOn.join(', ')}`);
    assert(noRt.length === 0, `thiếu ai.typing true/false trên socket: ${noRt.join(', ')}`);
    assert(noEach.length === 0, `thiếu typing_on trước bong bóng sau: ${noEach.join(', ')}`);
    const multi = latencyTrials.filter((t) => t.bubbles > 1).length;
    return (
      `${latencyTrials.length} lượt: typing_on trước tin đầu, ai.typing true→false; ` +
      `${multi} lượt nhiều bong bóng đều có typing_on trước mỗi bong bóng`
    );
  } finally {
    await restoreDefaultBot();
  }
}

// ---------- Chạy ----------

async function preflight(): Promise<void> {
  if (!CFG.databaseUrl)
    throw new Error('Thiếu E2E_DATABASE_URL/DATABASE_URL (đặt tay, trỏ vào DB của stack cô lập)');
  if (FILE_ENV.DATABASE_URL && CFG.databaseUrl === FILE_ENV.DATABASE_URL) {
    throw new Error('DATABASE_URL trùng .env (DB thật) — runner chỉ chạy trên stack cô lập');
  }
  const health = await http(`${CFG.api}/health`).catch(() => undefined);
  if (!health) throw new Error(`Không kết nối được API ${CFG.api}`);
  const mock = await http(`${CFG.mock}/__health`).catch(() => undefined);
  if (!mock || mock.status !== 200) throw new Error(`Không kết nối được mock-graph ${CFG.mock}`);
}

async function runAll(): Promise<void> {
  const Pg = loadPg();
  S.pg = new Pg({ connectionString: CFG.databaseUrl });
  await S.pg.connect();
  if (!(await check('s1a', 'Đăng nhập admin + mở socket', s1Login))) return;
  if (!(await check('s1b', 'Chặn chạy trên stack có Fanpage thật', s1Guard))) return;
  if (!(await check('s1c', 'Kết nối Fanpage mock A', s1Channel))) return;
  if (!(await check('s1d', 'Cài đặt: AI bật, giờ làm việc 24/7, Lark -> server bắt thẻ', s1Settings))) return;
  if (!(await check('s1e', `Tạo/cập nhật "${BOT_NAME}" + đặt mặc định cho kênh`, s1Bot))) return;
  console.log('---- luồng chạy ----');
  await check('s2a', 'Khách mới -> gắn bot, debounce -> bot trả lời (Gemini thật)', s2Reply);
  await check('s2b', 'Tin bot -> Send API mock, giãn bong bóng, sent', s2Outbound);
  await check('s2c', 'Echo tin bot của chính app -> không tạm dừng AI', s2OwnEcho);
  await check('s3', 'Debounce: 3 tin cách 1s -> đúng 1 ai_run gom 3 tin', s3Debounce);
  await check('s4a', 'Từ khóa "giảm giá" -> chuyển người (discount), không LLM, Lark', s4Escalate);
  await check('s4b', 'Nhận xử lý + Đã xong, trả lại cho AI (không nhắn gì)', s4AckResolve);
  await check('s4c', 'Sau "trả lại cho AI" -> câu hỏi khác được trả lời', s4Resume);
  await check('s4d', '"Xong" lúc chờ người -> bot tắt; bật lại đúng bot -> auto', s4StatusResolved);
  await check('s5a', 'Nhân viên nhắn -> AI tạm dừng, tin khách không được trả lời', s5Pause);
  await check('s5b', '"Tiếp tục AI" -> tin khách tiếp theo được trả lời', s5Resume);
  await check('s6a', 'Tắt AI tổng -> không trả lời', s6Off);
  await check('s6b', 'Bật lại + ngoài giờ làm việc -> vẫn trả lời', s6OnOutsideHours);
  await check('s7a', 'POST /chatbots/:id/test (Gemini thật) -> tiếng Việt', s7Test);
  await check('s7b', 'POST /settings/lark/test -> thẻ thử', s7LarkTest);
  await check('s8', 'Giới hạn lượt trả lời/giờ', s8HourlyCap);
  await check('s9', 'Chống đua: khách nhắn thêm lúc Gemini đang chạy -> hủy + gom lại', s9Race);
  await check('s10', 'Bật bot cho hội thoại khách đang chờ -> tự trả lời (kick)', s10Kick);
  await check('s11a', 'Bot mới chỉ có tên -> trung tính (không từ khóa/hướng dẫn sẵn)', s11Neutral);
  await check('s11b', 'Persona nội bộ + escalateWhenUnsure=false -> câu ngoài KT vẫn reply', s11Unsure);
  if (CFG.latency || CFG.only?.has('s12')) {
    console.log('---- đo độ trễ (mốc ms tính từ lúc POST webhook) ----');
    await check(
      's12a',
      `Độ trễ: delay 0s, Nhanh nhất, ${latencyOpts.trials0} lượt -> tin đầu < 4s`,
      s12Delay0,
    );
    await check(
      's12b',
      `Độ trễ: delay 1s, Nhanh nhất, ${latencyOpts.trials1} lượt -> tin đầu < 4s`,
      s12Delay1,
    );
    await check('s12c', `Độ trễ: delay 0s, Cân bằng, ${latencyOpts.balanced} lượt (so sánh)`, s12Balanced);
    await check('s12d', 'Đang soạn tin: typing_on trước mỗi bong bóng + ai.typing true/false', s12Typing);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      api: { type: 'string' },
      mock: { type: 'string' },
      'lark-port': { type: 'string' },
      'lark-real': { type: 'boolean' },
      only: { type: 'string' },
      latency: { type: 'boolean' },
      'latency-trials': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values.api) CFG.api = values.api.replace(/\/+$/, '');
  if (values.mock) CFG.mock = values.mock.replace(/\/+$/, '');
  if (values['lark-port']) CFG.larkPort = Number(values['lark-port']);
  CFG.larkReal = Boolean(values['lark-real']);
  CFG.latency = Boolean(values.latency);
  if (values['latency-trials']) {
    const [t0, t1, tb] = values['latency-trials'].split(',').map((x) => Number(x.trim()));
    if (Number.isInteger(t0)) latencyOpts.trials0 = t0!;
    if (Number.isInteger(t1)) latencyOpts.trials1 = t1!;
    if (Number.isInteger(tb)) latencyOpts.balanced = tb!;
  }
  if (values.only)
    CFG.only = new Set(
      values.only
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  console.log(`Dezon Omni Inbox — e2e Chatbot AI (run ${RUN})`);
  console.log(
    `API ${CFG.api} · mock ${CFG.mock} · Lark ${CFG.larkReal ? 'THẬT ở s4' : `bắt tại :${CFG.larkPort}`}\n`,
  );
  const started = Date.now();
  let lark: Server | undefined;
  try {
    await preflight();
    lark = await startLarkCapture(CFG.larkPort);
    await runAll();
  } finally {
    S.sock?.close();
    lark?.close();
    await S.pg?.end().catch(() => undefined);
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
