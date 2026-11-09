// Mock Graph API (Facebook) cho dev/e2e: giả lập đúng các endpoint mà packages/core/src/connectors/messenger gọi,
// để chạy trọn Giai đoạn 1A mà KHÔNG cần Facebook App thật. Chỉ dùng node:http (không thêm dependency).
// Chạy (dùng tsx của worker):
//   pnpm --filter @dezon/worker exec tsx ../../scripts/mock-graph.ts --port 4900
// Rồi chạy api/worker với META_GRAPH_BASE_URL=http://localhost:4900 (xem docs/TESTING-1A.md).
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { deflateSync } from 'node:zlib';

const USAGE = `Mock Graph API (Facebook) cho dev — giả lập Page/Send/User Profile/subscribed_apps/OAuth/Conversations.

Cách dùng:
  pnpm --filter @dezon/worker exec tsx ../../scripts/mock-graph.ts [tuỳ chọn]

Tuỳ chọn:
  --port <n>                 Cổng (mặc định 4900)
  --host <host>              Địa chỉ lắng nghe (mặc định: mọi địa chỉ, cả IPv4/IPv6)
  --public-url <url>         URL gốc dùng trong profile_pic/picture (mặc định http://localhost:<port>)
  --config <file.json>       Ghi đè cấu hình mặc định (appId, appSecret, user, pages, expiredTokens)
  --echo-webhooks <apiUrl> <appSecret> <appId>
                             Sau mỗi lần gửi thành công, POST webhook message_echoes đã ký về API
                             (apiUrl = http://localhost:4000 hoặc URL webhook đầy đủ) với app_id = <appId>
  --echo-delay <ms>          Độ trễ trước khi gửi echo (mặc định 300)
  --graph-version <v>        Version mong đợi (mặc định v26.0); version khác vẫn phục vụ nhưng log cảnh báo
  --help                     In hướng dẫn này

Token mặc định (Authorization: Bearer <token> hoặc ?access_token=):
  PAGE_TOKEN_A_DEZON_DESIGN_MOCK (alias PAGE_TOKEN_A) -> Page 100000000000001 "Dezon Design (test)"
  PAGE_TOKEN_B_DEZON_SHOP_MOCK   (alias PAGE_TOKEN_B) -> Page 100000000000002 "Dezon Shop (test)"
  USER_TOKEN, USER_TOKEN_LL, USER_TOKEN_DEZON_ADMIN_MOCK -> người dùng (không phải Page; /me?fields=...,category lỗi 100 như Graph thật)
  EXPIRED, EXPIRED_PAGE_TOKEN_DEZON_MOCK -> lỗi 190/463
  (API yêu cầu pageAccessToken >= 20 ký tự nên khi kết nối Fanpage hãy dùng token dài, không dùng alias.)

PSID đặc biệt khi gửi tin (POST /{page}/messages):
  PSID_OUTSIDE -> lỗi 10/2018278 (ngoài cửa sổ)   PSID_RATE -> lỗi 613 lần đầu, sau đó thành công
  PSID_TOKEN   -> lỗi 190/460                       PSID_NOPROFILE -> profile rỗng   PSID_PHONE -> lỗi 2018218

Conversations API (đồng bộ): GET /{page}/conversations, GET /{t_...}/messages — mỗi Page có 3 hội thoại mẫu
  (PSID_SYNC_<3 số cuối page>_1..3; có ảnh, chia sẻ link, nhãn dán); tin gửi qua Send API cũng hiện ở đây.
  POST /__inbox/message {"psid":"...","text":"...","pageId"?,"fromPage"?,"mid"?} thêm tin KHÔNG kèm webhook.

Endpoint kiểm tra: GET /__calls[?path=&method=]  ·  POST /__reset  ·  GET /__health`;

// ---------- Cấu hình ----------

interface PageDef {
  id: string;
  name: string;
  category: string;
  /** Token đầu tiên là token "chính" (trả về ở /me/accounts); các token sau là alias. */
  tokens: string[];
  tasks: string[];
}

interface MockConfig {
  appId: string;
  appSecret: string;
  user: { id: string; name: string; tokens: string[] };
  pages: PageDef[];
  expiredTokens: string[];
}

const DEFAULT_CONFIG: MockConfig = {
  appId: 'dev-app-id',
  appSecret: 'dev-app-secret',
  user: {
    id: '100000000000099',
    name: 'Quản trị Dezon (test)',
    tokens: ['USER_TOKEN', 'USER_TOKEN_LL', 'USER_TOKEN_DEZON_ADMIN_MOCK'],
  },
  pages: [
    {
      id: '100000000000001',
      name: 'Dezon Design (test)',
      category: 'Interior Design Studio',
      tokens: ['PAGE_TOKEN_A_DEZON_DESIGN_MOCK', 'PAGE_TOKEN_A'],
      tasks: ['ADVERTISE', 'ANALYZE', 'CREATE_CONTENT', 'MESSAGING', 'MODERATE', 'MANAGE'],
    },
    {
      id: '100000000000002',
      name: 'Dezon Shop (test)',
      category: 'Furniture Store',
      tokens: ['PAGE_TOKEN_B_DEZON_SHOP_MOCK', 'PAGE_TOKEN_B'],
      tasks: ['ADVERTISE', 'ANALYZE', 'CREATE_CONTENT', 'MESSAGING', 'MODERATE', 'MANAGE'],
    },
  ],
  expiredTokens: ['EXPIRED', 'EXPIRED_PAGE_TOKEN_DEZON_MOCK'],
};

const GRANTED_SCOPES = [
  'pages_show_list',
  'pages_manage_metadata',
  'pages_messaging',
  'pages_read_engagement',
];
const MOCK_CODE = 'MOCK_CODE';

interface EchoTarget {
  webhookUrl: string;
  appSecret: string;
  appId: string;
}

interface Options {
  port: number;
  host?: string;
  publicUrl: string;
  config: MockConfig;
  echo?: EchoTarget;
  echoDelayMs: number;
  graphVersion: string;
}

function takeValue(argv: string[], i: number, flag: string): string {
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`Thiếu giá trị cho ${flag}`);
  return value;
}

function webhookUrlOf(apiUrl: string): string {
  const url = new URL(apiUrl);
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/webhooks/messenger';
  return url.toString();
}

function loadConfig(path: string | undefined): MockConfig {
  if (!path) return DEFAULT_CONFIG;
  const override = JSON.parse(readFileSync(path, 'utf8')) as Partial<MockConfig>;
  return { ...DEFAULT_CONFIG, ...override };
}

function parseCli(argv: string[]): Options | 'help' {
  let port = 4900;
  let host: string | undefined;
  let publicUrl: string | undefined;
  let configPath: string | undefined;
  let echo: EchoTarget | undefined;
  let echoDelayMs = 300;
  let graphVersion = 'v26.0';
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--help':
      case '-h':
        return 'help';
      case '--port':
        port = Number(takeValue(argv, i++, flag));
        if (!Number.isInteger(port) || port <= 0) throw new Error('--port không hợp lệ');
        break;
      case '--host':
        host = takeValue(argv, i++, flag);
        break;
      case '--public-url':
        publicUrl = takeValue(argv, i++, flag).replace(/\/+$/, '');
        break;
      case '--config':
        configPath = takeValue(argv, i++, flag);
        break;
      case '--echo-webhooks': {
        const apiUrl = takeValue(argv, i++, flag);
        const appSecret = takeValue(argv, i++, flag);
        const appId = takeValue(argv, i++, flag);
        echo = { webhookUrl: webhookUrlOf(apiUrl), appSecret, appId };
        break;
      }
      case '--echo-delay':
        echoDelayMs = Number(takeValue(argv, i++, flag));
        break;
      case '--graph-version':
        graphVersion = takeValue(argv, i++, flag);
        break;
      default:
        throw new Error(`Tuỳ chọn không hợp lệ: ${flag} (xem --help)`);
    }
  }
  return {
    port,
    ...(host ? { host } : {}),
    publicUrl: publicUrl ?? `http://localhost:${port}`,
    config: loadConfig(configPath),
    ...(echo ? { echo } : {}),
    echoDelayMs,
    graphVersion,
  };
}

// ---------- PNG tự dựng (avatar) ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function hashOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** PNG RGB size×size: nền màu theo hash + ô vuông sáng ở giữa. */
function makeAvatarPng(seed: string, size = 96): Buffer {
  const h = hashOf(seed);
  const bg = [64 + (h & 0x7f), 64 + ((h >>> 8) & 0x7f), 64 + ((h >>> 16) & 0x7f)];
  const fg = bg.map((v) => Math.min(255, v + 90));
  const rowLen = 1 + size * 3;
  const raw = Buffer.alloc(rowLen * size);
  const lo = size / 4;
  const hi = (size * 3) / 4;
  for (let y = 0; y < size; y++) {
    raw[y * rowLen] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const color = x >= lo && x < hi && y >= lo && y < hi ? fg : bg;
      const o = y * rowLen + 1 + x * 3;
      raw[o] = color[0] as number;
      raw[o + 1] = color[1] as number;
      raw[o + 2] = color[2] as number;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- Trạng thái ----------

interface CallRecord {
  n: number;
  at: string;
  method: string;
  /** Đường dẫn không gồm query. */
  path: string;
  version: string | null;
  /** Query đã ẩn token/secret/code. */
  query: Record<string, string>;
  auth: string;
  pageId?: string;
  body?: unknown;
  status: number;
  response?: unknown;
}

interface StoredFile {
  data: Buffer;
  mime: string;
  name: string;
}

const state = {
  seq: 0,
  sendSeq: 0,
  calls: [] as CallRecord[],
  subscriptions: new Map<string, string[]>(),
  rateLimited: new Set<string>(),
  files: new Map<string, StoredFile>(),
  /** code OAuth đã cấp -> redirect_uri (phải khớp khi đổi token). */
  codes: new Map<string, string>(),
  avatarCache: new Map<string, Buffer>(),
  /** pageId -> hội thoại (Conversations API); tạo mẫu khi được hỏi lần đầu. */
  threads: new Map<string, MockThread[]>(),
};

function resetState(): void {
  state.calls = [];
  state.sendSeq = 0;
  state.subscriptions.clear();
  state.rateLimited.clear();
  state.files.clear();
  state.codes.clear();
  state.threads.clear();
}

// ---------- Tiện ích HTTP ----------

const SECRET_KEYS = new Set(['access_token', 'client_secret', 'code', 'fb_exchange_token', 'input_token']);

function redactQuery(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = SECRET_KEYS.has(k) ? '***' : v;
  return out;
}

function redactBody(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) out[k] = SECRET_KEYS.has(k) ? '***' : v;
  return out;
}

async function readBody(req: IncomingMessage, limit = 30 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limit) throw new Error('Body quá lớn');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

interface ParsedBody {
  fields: Record<string, unknown>;
  file?: StoredFile;
}

function maybeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** JSON / multipart (Request.formData của Node) / x-www-form-urlencoded. */
async function parseBody(raw: Buffer, contentType: string | undefined): Promise<ParsedBody> {
  if (raw.length === 0) return { fields: {} };
  const type = (contentType ?? '').toLowerCase();
  if (type.includes('application/json')) {
    const json = JSON.parse(raw.toString('utf8')) as unknown;
    return { fields: json && typeof json === 'object' ? (json as Record<string, unknown>) : {} };
  }
  if (type.includes('multipart/form-data')) {
    const form = await new Request('http://mock.local/', {
      method: 'POST',
      headers: { 'content-type': contentType ?? '' },
      body: raw,
    }).formData();
    const fields: Record<string, unknown> = {};
    let file: StoredFile | undefined;
    for (const [key, value] of form) {
      if (typeof value === 'string') {
        fields[key] = maybeJson(value);
      } else {
        const data = Buffer.from(await value.arrayBuffer());
        file = { data, mime: value.type || 'application/octet-stream', name: value.name || key };
        fields[key] = { filename: file.name, mime: file.mime, size: data.length };
      }
    }
    return file ? { fields, file } : { fields };
  }
  const fields: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(raw.toString('utf8'))) fields[k] = maybeJson(v);
  return { fields };
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  version: string | null;
  /** Các đoạn path sau version. */
  segments: string[];
  body: ParsedBody;
  record: CallRecord;
  note: string[];
}

function sendJson(ctx: Ctx, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  ctx.record.status = status;
  ctx.record.response = payload;
  ctx.res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  ctx.res.end(JSON.stringify(payload));
}

interface GraphErrorSpec {
  status?: number;
  code: number;
  message: string;
  subcode?: number;
  type?: string;
}

function graphError(ctx: Ctx, spec: GraphErrorSpec): void {
  const error: Record<string, unknown> = {
    message: spec.message,
    type: spec.type ?? 'OAuthException',
    code: spec.code,
    ...(spec.subcode !== undefined ? { error_subcode: spec.subcode } : {}),
    fbtrace_id: `Amock${randomBytes(6).toString('hex')}`,
  };
  ctx.note.push(`lỗi ${spec.code}${spec.subcode !== undefined ? `/${spec.subcode}` : ''}`);
  const headers: Record<string, string> =
    spec.code === 190 || spec.code === 104
      ? { 'www-authenticate': `OAuth "Facebook Platform" "invalid_token" "${spec.message}"` }
      : {};
  sendJson(ctx, spec.status ?? 400, { error }, headers);
}

// ---------- Token ----------

type Principal =
  | { kind: 'page'; page: PageDef }
  | { kind: 'user' }
  | { kind: 'app' }
  | { kind: 'expired' }
  | { kind: 'invalid' }
  | { kind: 'none' };

function tokenOf(ctx: Ctx): string | undefined {
  const header = ctx.req.headers.authorization;
  if (header && /^(Bearer|OAuth)\s+/i.test(header)) return header.replace(/^(Bearer|OAuth)\s+/i, '').trim();
  const fromQuery = ctx.url.searchParams.get('access_token');
  if (fromQuery) return fromQuery;
  const fromBody = ctx.body.fields.access_token;
  return typeof fromBody === 'string' ? fromBody : undefined;
}

function resolvePrincipal(opts: Options, token: string | undefined): Principal {
  const { config } = opts;
  if (!token) return { kind: 'none' };
  if (config.expiredTokens.includes(token)) return { kind: 'expired' };
  const page = config.pages.find((p) => p.tokens.includes(token));
  if (page) return { kind: 'page', page };
  if (config.user.tokens.includes(token)) return { kind: 'user' };
  if (token === appToken(config)) return { kind: 'app' };
  return { kind: 'invalid' };
}

const appToken = (config: MockConfig) => `${config.appId}|mock_app_token`;

function describePrincipal(p: Principal): string {
  return p.kind === 'page' ? `page:${p.page.id}` : p.kind;
}

/** Lỗi token chung; trả true nếu đã trả lỗi. */
function rejectBadToken(ctx: Ctx, p: Principal): boolean {
  if (p.kind === 'none') {
    graphError(ctx, { code: 104, message: 'An access token is required to request this resource.' });
    return true;
  }
  if (p.kind === 'expired') {
    graphError(ctx, {
      code: 190,
      subcode: 463,
      message: 'Error validating access token: Session has expired (mock).',
    });
    return true;
  }
  if (p.kind === 'invalid') {
    graphError(ctx, { code: 190, message: 'Invalid OAuth access token - Cannot parse access token' });
    return true;
  }
  return false;
}

// ---------- Dữ liệu giả ----------

const LAST_NAMES = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Vũ', 'Đặng', 'Bùi', 'Đỗ', 'Ngô'];
const FIRST_NAMES = [
  'An',
  'Bình',
  'Chi',
  'Dũng',
  'Hà',
  'Khánh',
  'Linh',
  'Minh',
  'Ngọc',
  'Phương',
  'Quân',
  'Thảo',
];

/** Hồ sơ khách xác định theo PSID (cùng PSID luôn cùng tên). */
function profileFor(psid: string, publicUrl: string) {
  const h = hashOf(psid);
  const first = FIRST_NAMES[h % FIRST_NAMES.length] as string;
  const last = LAST_NAMES[(h >>> 8) % LAST_NAMES.length] as string;
  return {
    id: psid,
    first_name: first,
    last_name: last,
    name: `${last} ${first}`,
    profile_pic: `${publicUrl}/avatar/${encodeURIComponent(psid)}.png?oe=mock`,
  };
}

/** `fields=id,name,picture{url}` -> ['id','name','picture']. */
function requestedFields(ctx: Ctx): string[] | undefined {
  const raw = ctx.url.searchParams.get('fields') ?? (ctx.body.fields.fields as string | undefined);
  if (!raw) return undefined;
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of raw) {
    if (ch === '{' || ch === '(') depth++;
    if (ch === '}' || ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((f) => f.trim().split(/[{.(]/)[0] as string).filter(Boolean);
}

function pick(obj: Record<string, unknown>, fields: string[] | undefined): Record<string, unknown> {
  if (!fields) return obj;
  const out: Record<string, unknown> = { id: obj.id };
  for (const f of fields) if (f in obj) out[f] = obj[f];
  return out;
}

function pageNode(opts: Options, page: PageDef): Record<string, unknown> {
  return {
    id: page.id,
    name: page.name,
    category: page.category,
    category_list: [{ id: '2200', name: page.category }],
    access_token: page.tokens[0],
    tasks: page.tasks,
    picture: {
      data: {
        height: 50,
        width: 50,
        is_silhouette: false,
        url: `${opts.publicUrl}/avatar/page-${page.id}.png`,
      },
    },
  };
}

// ---------- Handler Graph ----------

function handleMe(ctx: Ctx, opts: Options, p: Principal): void {
  if (rejectBadToken(ctx, p)) return;
  const fields = requestedFields(ctx);
  if (p.kind === 'page') {
    const { access_token: _token, tasks: _tasks, ...node } = pageNode(opts, p.page);
    sendJson(ctx, 200, pick(node, fields ?? ['id', 'name']));
    return;
  }
  if (p.kind === 'user') {
    // Graph thật: hỏi field chỉ có ở Page (category...) trên node User => lỗi 100.
    const bad = fields?.find(
      (f) => !['id', 'name', 'first_name', 'last_name', 'email', 'picture'].includes(f),
    );
    if (bad) {
      graphError(ctx, {
        code: 100,
        message: `(#100) Tried accessing nonexisting field (${bad}) on node type (User)`,
      });
      return;
    }
    const user = { id: opts.config.user.id, name: opts.config.user.name };
    sendJson(ctx, 200, pick(user, fields ?? ['id', 'name']));
    return;
  }
  graphError(ctx, {
    code: 2500,
    message: 'An active access token must be used to query information about the current user.',
  });
}

function handleAccounts(ctx: Ctx, opts: Options, p: Principal): void {
  if (rejectBadToken(ctx, p)) return;
  if (p.kind !== 'user') {
    graphError(ctx, {
      code: 100,
      message: '(#100) Tried accessing nonexisting field (accounts) on node type (Page)',
    });
    return;
  }
  const fields = requestedFields(ctx) ?? ['access_token', 'category', 'category_list', 'name', 'id', 'tasks'];
  const data = opts.config.pages.map((page) => pick(pageNode(opts, page), fields));
  sendJson(ctx, 200, {
    data,
    paging: { cursors: { before: 'QVFIUmock_before', after: 'QVFIUmock_after' } },
  });
}

function handleSubscribedApps(ctx: Ctx, opts: Options, p: Principal, pageId: string): void {
  if (rejectBadToken(ctx, p)) return;
  ctx.record.pageId = pageId;
  const ownsPage = p.kind === 'page' && p.page.id === pageId;
  // DELETE cho phép App Access Token (tài liệu subscribed_apps); GET/POST cần Page token của đúng Page.
  if (!ownsPage && !(ctx.method === 'DELETE' && p.kind === 'app')) {
    graphError(ctx, {
      code: 200,
      message: '(#200) The page token does not belong to this Page or lacks pages_manage_metadata',
      type: 'OAuthException',
    });
    return;
  }
  if (ctx.method === 'GET') {
    const fields = state.subscriptions.get(pageId);
    sendJson(ctx, 200, {
      data: fields
        ? [
            {
              category: 'Business',
              link: 'https://localhost/',
              name: 'Dezon Inbox (mock)',
              id: opts.config.appId,
              subscribed_fields: fields,
            },
          ]
        : [],
    });
    return;
  }
  if (ctx.method === 'POST') {
    const raw = ctx.url.searchParams.get('subscribed_fields') ?? ctx.body.fields.subscribed_fields;
    const list = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(',') : [];
    if (list.length === 0) {
      graphError(ctx, { code: 100, message: '(#100) The parameter subscribed_fields is required' });
      return;
    }
    state.subscriptions.set(pageId, list.map((f) => f.trim()).filter(Boolean));
    ctx.note.push(`fields=${list.length}`);
    sendJson(ctx, 200, { success: true });
    return;
  }
  if (ctx.method === 'DELETE') {
    state.subscriptions.delete(pageId);
    sendJson(ctx, 200, { success: true });
    return;
  }
  graphError(ctx, { code: 100, message: `Unsupported ${ctx.method} request.`, type: 'GraphMethodException' });
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function handleSend(ctx: Ctx, opts: Options, p: Principal, pageParam: string): void {
  if (rejectBadToken(ctx, p)) return;
  if (p.kind !== 'page' || (pageParam !== 'me' && pageParam !== p.page.id)) {
    graphError(ctx, {
      code: 200,
      message: '(#200) Page access token of this Page is required to send messages',
    });
    return;
  }
  const page = p.page;
  ctx.record.pageId = page.id;
  const f = ctx.body.fields;
  const recipient = asObject(f.recipient);
  const psid = typeof recipient?.id === 'string' ? recipient.id : undefined;
  const message = asObject(f.message);
  const messagingType = typeof f.messaging_type === 'string' ? f.messaging_type : undefined;
  if (!psid) {
    graphError(ctx, { code: 100, message: '(#100) param recipient must be non-empty.' });
    return;
  }
  if (f.sender_action !== undefined) {
    sendJson(ctx, 200, { recipient_id: psid });
    return;
  }
  if (!message) {
    graphError(ctx, { code: 100, message: '(#100) param message must be non-empty.' });
    return;
  }
  if (!messagingType || !['RESPONSE', 'UPDATE', 'MESSAGE_TAG', 'UTILITY'].includes(messagingType)) {
    graphError(ctx, { code: 100, message: '(#100) The parameter messaging_type is required or invalid' });
    return;
  }
  if (messagingType === 'MESSAGE_TAG' && !['HUMAN_AGENT', 'CUSTOMER_FEEDBACK'].includes(String(f.tag))) {
    graphError(ctx, { code: 100, message: '(#100) Invalid or removed message tag' });
    return;
  }
  const text = typeof message.text === 'string' ? message.text : undefined;
  const attachment = asObject(message.attachment);
  if (text !== undefined && text.length >= 2000) {
    graphError(ctx, { code: 100, message: '(#100) Length of param message[text] must be less than 2000' });
    return;
  }
  if (!text && !attachment) {
    graphError(ctx, { code: 100, message: '(#100) Must send either message text or an attachment' });
    return;
  }
  if (
    attachment &&
    !ctx.body.file &&
    !asObject(attachment.payload)?.url &&
    !asObject(attachment.payload)?.attachment_id
  ) {
    graphError(ctx, {
      code: 100,
      subcode: 2018047,
      message: '(#100) Upload attachment failure: missing filedata',
    });
    return;
  }
  ctx.note.push(
    `recipient=${psid} type=${messagingType}${attachment ? ` file=${String(attachment.type)}` : ''}`,
  );

  // PSID đặc biệt để thử nhánh lỗi.
  if (psid === 'PSID_OUTSIDE') {
    graphError(ctx, {
      code: 10,
      subcode: 2018278,
      message: '(#10) This message is sent outside of allowed window.',
    });
    return;
  }
  if (psid === 'PSID_TOKEN') {
    graphError(ctx, {
      code: 190,
      subcode: 460,
      message: 'Error validating access token: The session has been invalidated (mock).',
    });
    return;
  }
  if (psid === 'PSID_RATE' && !state.rateLimited.has(psid)) {
    state.rateLimited.add(psid);
    graphError(ctx, { code: 613, message: '(#613) Calls to this api have exceeded the rate limit.' });
    return;
  }

  const mid = `m_mock_${++state.sendSeq}`;
  if (ctx.body.file) state.files.set(mid, ctx.body.file);
  // Tin đã gửi cũng hiện trong Conversations API (id = message_id của Send API, như Graph thật).
  appendThreadMessage(opts, page.id, psid, {
    id: mid,
    fromId: page.id,
    ...(text !== undefined ? { text } : {}),
    ...(attachment
      ? {
          attachments: [
            {
              id: `att_${mid}`,
              mime_type: ctx.body.file?.mime ?? 'application/octet-stream',
              name: ctx.body.file?.name ?? 'file',
              ...(String(attachment.type) === 'image'
                ? { image_data: { url: `${opts.publicUrl}/files/${mid}` } }
                : { file_url: `${opts.publicUrl}/files/${mid}` }),
            },
          ],
        }
      : {}),
  });
  sendJson(ctx, 200, { recipient_id: psid, message_id: mid });
  if (opts.echo) {
    const metadata = typeof message.metadata === 'string' ? message.metadata : undefined;
    const echoAttachment = attachment
      ? { type: String(attachment.type), url: `${opts.publicUrl}/files/${mid}` }
      : undefined;
    setTimeout(
      () => void postEcho(opts, opts.echo as EchoTarget, page.id, psid, mid, text, metadata, echoAttachment),
      opts.echoDelayMs,
    );
  }
}

/** Escape ký tự ngoài ASCII như Meta (chữ ký tính trên đúng bytes gửi đi). */
function metaJson(payload: unknown): string {
  return JSON.stringify(payload).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

async function postEcho(
  _opts: Options,
  echo: EchoTarget,
  pageId: string,
  psid: string,
  mid: string,
  text: string | undefined,
  metadata: string | undefined,
  attachment: { type: string; url: string } | undefined,
): Promise<void> {
  const now = Date.now();
  // Meta gửi app_id dạng số; app id dev (không phải số) giữ dạng chuỗi.
  const appId = /^\d+$/.test(echo.appId) ? Number(echo.appId) : echo.appId;
  const message: Record<string, unknown> = { mid, is_echo: true, app_id: appId };
  if (metadata) message.metadata = metadata;
  if (text) message.text = text;
  if (attachment) message.attachments = [{ type: attachment.type, payload: { url: attachment.url } }];
  const body = metaJson({
    object: 'page',
    entry: [
      {
        id: pageId,
        time: now,
        messaging: [{ sender: { id: pageId }, recipient: { id: psid }, timestamp: now, message }],
      },
    ],
  });
  const signature = `sha256=${createHmac('sha256', echo.appSecret).update(body).digest('hex')}`;
  try {
    const res = await fetch(echo.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    log(`echo -> ${echo.webhookUrl} ${res.status} (mid ${mid})`);
  } catch (err) {
    log(`echo -> ${echo.webhookUrl} THẤT BẠI: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function handleNode(ctx: Ctx, opts: Options, p: Principal, id: string): void {
  if (rejectBadToken(ctx, p)) return;
  const fields = requestedFields(ctx);
  const page = opts.config.pages.find((pg) => pg.id === id);
  if (page) {
    const { access_token: _t, tasks: _k, ...node } = pageNode(opts, page);
    sendJson(ctx, 200, pick(node, fields ?? ['id', 'name']));
    return;
  }
  if (id === opts.config.user.id) {
    sendJson(ctx, 200, { id, name: opts.config.user.name });
    return;
  }
  // Còn lại: coi là PSID -> User Profile API, cần Page token.
  if (p.kind !== 'page') {
    graphError(ctx, {
      code: 100,
      subcode: 33,
      message: `Unsupported get request. Object with ID '${id}' does not exist.`,
      type: 'GraphMethodException',
    });
    return;
  }
  ctx.record.pageId = p.page.id;
  if (id === 'PSID_PHONE') {
    graphError(ctx, { code: 100, subcode: 2018218, message: 'No profile available for this user.' });
    return;
  }
  if (id === 'PSID_NOPROFILE') {
    sendJson(ctx, 200, { id });
    return;
  }
  sendJson(
    ctx,
    200,
    pick(profileFor(id, opts.publicUrl), fields ?? ['id', 'first_name', 'last_name', 'profile_pic']),
  );
}

// ---------- Conversations API (đồng bộ hội thoại) ----------
// Dạng phản hồi theo Graph thật (docs/research/messenger-platform.md §13): sắp mới nhất trước,
// phân trang bằng cursors.after (paging.next chỉ có khi còn trang), `since` bị bỏ qua như Graph thật.

interface MockThreadMessage {
  id: string;
  fromId: string;
  at: number;
  text?: string;
  attachments?: Record<string, unknown>[];
  shares?: { link: string; name: string }[];
  sticker?: string;
}

interface MockThread {
  id: string;
  psid: string;
  messages: MockThreadMessage[];
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function midOf(pageId: string, n: number | string): string {
  return `m_sync_${pageId.slice(-3)}_${n}`;
}

/** 3 hội thoại mẫu mỗi Page (tạo lần đầu được hỏi, mốc thời gian tính từ lúc tạo). */
function seedThreads(opts: Options, pageId: string): MockThread[] {
  const now = Date.now();
  const short = pageId.slice(-3);
  const psid = (n: number) => `PSID_SYNC_${short}_${n}`;
  const m = (
    n: number,
    fromId: string,
    at: number,
    extra: Partial<MockThreadMessage>,
  ): MockThreadMessage => ({
    id: midOf(pageId, n),
    fromId,
    at,
    ...extra,
  });
  return [
    {
      id: `t_${short}0001`,
      psid: psid(1),
      messages: [
        m(1, psid(1), now - 2 * DAY_MS, { text: 'Chào shop, em muốn hỏi mẫu nhà phố 5x20' }),
        m(2, pageId, now - 2 * DAY_MS + 5 * 60_000, { text: 'Dạ chào anh/chị, shop gửi mẫu ạ' }),
        m(3, psid(1), now - DAY_MS, {
          text: '',
          attachments: [
            {
              id: `att_${short}_3`,
              mime_type: 'image/png',
              name: 'image-mau-nha.png',
              image_data: {
                url: `${opts.publicUrl}/avatar/${encodeURIComponent(`sync-${short}-3`)}.png?oe=mock`,
                width: 96,
                height: 96,
              },
            },
          ],
        }),
      ],
    },
    {
      id: `t_${short}0002`,
      psid: psid(2),
      messages: [
        m(4, psid(2), now - 5 * HOUR_MS, {
          text: 'https://dezon.vn/mau-thiet-ke/',
          shares: [
            {
              link: 'https://l.facebook.com/l.php?u=https%3A%2F%2Fdezon.vn%2Fmau-thiet-ke%2F&h=mock',
              name: 'Mẫu thiết kế Dezon',
            },
          ],
        }),
        m(5, psid(2), now - 5 * HOUR_MS + 60_000, { text: 'Mẫu này giá bao nhiêu ạ?' }),
      ],
    },
    {
      id: `t_${short}0003`,
      psid: psid(3),
      messages: [
        m(6, psid(3), now - 10 * DAY_MS, { text: 'Shop còn nhận thiết kế không?' }),
        m(7, pageId, now - 10 * DAY_MS + HOUR_MS, {
          text: '',
          sticker: `${opts.publicUrl}/avatar/sticker-${short}.png?oe=mock`,
        }),
      ],
    },
  ];
}

function threadsOf(opts: Options, pageId: string): MockThread[] {
  let threads = state.threads.get(pageId);
  if (!threads) {
    threads = seedThreads(opts, pageId);
    state.threads.set(pageId, threads);
  }
  return threads;
}

/** Thêm tin vào hội thoại (tạo hội thoại nếu chưa có). Dùng cho Send API và /__inbox/message. */
function appendThreadMessage(
  opts: Options,
  pageId: string,
  psid: string,
  msg: Omit<MockThreadMessage, 'at'> & { at?: number },
): void {
  const threads = threadsOf(opts, pageId);
  let thread = threads.find((t) => t.psid === psid);
  if (!thread) {
    const n = String(threads.length + 1).padStart(4, '0');
    thread = { id: `t_${pageId.slice(-3)}${n}`, psid, messages: [] };
    threads.push(thread);
  }
  thread.messages.push({ ...msg, at: msg.at ?? Date.now() });
}

const fbTime = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+0000');

function personOf(opts: Options, id: string, pageId: string): Record<string, string> {
  const page = opts.config.pages.find((pg) => pg.id === pageId);
  const name = id === pageId ? (page?.name ?? 'Page') : profileFor(id, opts.publicUrl).name;
  return { name, email: `${id}@facebook.com`, id };
}

const threadUpdated = (t: MockThread) => Math.max(0, ...t.messages.map((x) => x.at));

/** Cắt trang theo limit/after (cursor = base64 của vị trí); `next` không chứa token. */
function paginate<T>(ctx: Ctx, items: T[]): { data: T[]; paging: unknown } {
  const limit = Math.min(Math.max(Number(ctx.url.searchParams.get('limit') ?? 25) || 25, 1), 100);
  const after = ctx.url.searchParams.get('after');
  const offset = after ? Number(Buffer.from(after, 'base64').toString('utf8')) || 0 : 0;
  const data = items.slice(offset, offset + limit);
  const cursor = (n: number) => Buffer.from(String(n)).toString('base64');
  const next = new URL(ctx.url.pathname, ctx.url.origin);
  for (const [k, v] of ctx.url.searchParams) {
    if (k !== 'after' && k !== 'appsecret_proof' && k !== 'access_token') next.searchParams.set(k, v);
  }
  next.searchParams.set('after', cursor(offset + limit));
  return {
    data,
    paging: {
      cursors: { before: cursor(offset), after: cursor(offset + limit) },
      ...(offset + limit < items.length ? { next: next.toString() } : {}),
    },
  };
}

function handleConversations(ctx: Ctx, opts: Options, p: Principal, pageParam: string): void {
  if (rejectBadToken(ctx, p)) return;
  if (p.kind !== 'page' || (pageParam !== 'me' && pageParam !== p.page.id)) {
    graphError(ctx, { code: 200, message: '(#200) Page access token of this Page is required' });
    return;
  }
  const pageId = p.page.id;
  ctx.record.pageId = pageId;
  const fields = requestedFields(ctx);
  const items = [...threadsOf(opts, pageId)]
    .sort((a, b) => threadUpdated(b) - threadUpdated(a))
    .map((t) =>
      pick(
        {
          id: t.id,
          updated_time: fbTime(threadUpdated(t)),
          message_count: t.messages.length,
          participants: { data: [personOf(opts, t.psid, pageId), personOf(opts, pageId, pageId)] },
          link: `/${pageId}/inbox/${t.id.slice(2)}/?section=messages`,
        },
        fields ?? ['id', 'updated_time'],
      ),
    );
  ctx.note.push(`conversations=${items.length}`);
  sendJson(ctx, 200, paginate(ctx, items));
}

function handleThreadMessages(ctx: Ctx, opts: Options, p: Principal, threadId: string): void {
  if (rejectBadToken(ctx, p)) return;
  const pageId = p.kind === 'page' ? p.page.id : undefined;
  const thread = pageId ? threadsOf(opts, pageId).find((t) => t.id === threadId) : undefined;
  if (!pageId || !thread) {
    graphError(ctx, { code: 33, subcode: 1893013, message: '(#33) Invalid conversation ID (mock)' });
    return;
  }
  ctx.record.pageId = pageId;
  const fields = requestedFields(ctx);
  const items = [...thread.messages]
    .sort((a, b) => b.at - a.at)
    .map((x) => {
      const to = x.fromId === pageId ? thread.psid : pageId;
      return pick(
        {
          id: x.id,
          message: x.text ?? '',
          from: personOf(opts, x.fromId, pageId),
          to: { data: [personOf(opts, to, pageId)] },
          created_time: fbTime(x.at),
          ...(x.attachments ? { attachments: { data: x.attachments } } : {}),
          ...(x.shares ? { shares: { data: x.shares.map((s) => ({ ...s, id: x.id })) } } : {}),
          ...(x.sticker ? { sticker: x.sticker } : {}),
        },
        fields ?? ['id', 'created_time'],
      );
    });
  ctx.note.push(`messages=${items.length}`);
  sendJson(ctx, 200, paginate(ctx, items));
}

/** POST /__inbox/message {pageId?, psid, text?, fromPage?, mid?}: thêm tin mà KHÔNG gửi webhook (giả lập webhook lỡ). */
function handleInboxMessage(ctx: Ctx, opts: Options): void {
  const f = ctx.body.fields;
  const pageId = typeof f.pageId === 'string' ? f.pageId : opts.config.pages[0]?.id;
  const psid = typeof f.psid === 'string' ? f.psid : undefined;
  if (!pageId || !psid) {
    sendJson(ctx, 400, { error: 'cần psid (và pageId nếu không phải Page đầu tiên)' });
    return;
  }
  // `mid` tùy chọn: dùng cùng mid với một webhook để kiểm chống trùng webhook + đồng bộ.
  const id = typeof f.mid === 'string' && f.mid ? f.mid : midOf(pageId, `x${++state.sendSeq}`);
  const text = typeof f.text === 'string' ? f.text : 'Tin nhắn chỉ có qua đồng bộ';
  appendThreadMessage(opts, pageId, psid, { id, fromId: f.fromPage === true ? pageId : psid, text });
  sendJson(ctx, 200, { id });
}

function handleAccessToken(ctx: Ctx, opts: Options): void {
  const q = ctx.url.searchParams;
  const param = (k: string) =>
    q.get(k) ?? (typeof ctx.body.fields[k] === 'string' ? (ctx.body.fields[k] as string) : null);
  const { config } = opts;
  if (param('client_id') !== config.appId) {
    graphError(ctx, { code: 101, message: 'Error validating application. Invalid application ID.' });
    return;
  }
  const grantType = param('grant_type');
  if (grantType === 'client_credentials') {
    if (param('client_secret') !== config.appSecret) {
      graphError(ctx, { code: 1, message: 'Error validating client secret.' });
      return;
    }
    sendJson(ctx, 200, { access_token: appToken(config), token_type: 'bearer' });
    return;
  }
  if (param('client_secret') !== config.appSecret) {
    graphError(ctx, { code: 1, message: 'Error validating client secret.' });
    return;
  }
  if (grantType === 'fb_exchange_token') {
    const p = resolvePrincipal(opts, param('fb_exchange_token') ?? undefined);
    if (p.kind !== 'user') {
      graphError(ctx, {
        code: 190,
        message: 'Invalid OAuth access token - fb_exchange_token is not a user token',
      });
      return;
    }
    ctx.note.push('fb_exchange_token');
    sendJson(ctx, 200, { access_token: 'USER_TOKEN_LL', token_type: 'bearer', expires_in: 5183944 });
    return;
  }
  const code = param('code');
  if (code) {
    const issuedFor = state.codes.get(code);
    if (code !== MOCK_CODE && issuedFor === undefined) {
      graphError(ctx, { code: 100, subcode: 36007, message: 'Invalid verification code format.' });
      return;
    }
    const redirectUri = param('redirect_uri');
    if (issuedFor !== undefined && redirectUri !== issuedFor) {
      graphError(ctx, {
        code: 100,
        subcode: 36008,
        message:
          'Error validating verification code. Please make sure your redirect_uri is identical to the one you used in the OAuth dialog request',
      });
      return;
    }
    ctx.note.push('code exchange');
    sendJson(ctx, 200, { access_token: 'USER_TOKEN_LL', token_type: 'bearer', expires_in: 5183944 });
    return;
  }
  graphError(ctx, { code: 100, message: 'Missing grant_type/code parameter' });
}

function handleDebugToken(ctx: Ctx, opts: Options, p: Principal): void {
  if (rejectBadToken(ctx, p)) return;
  const input = resolvePrincipal(opts, ctx.url.searchParams.get('input_token') ?? undefined);
  const base = {
    app_id: opts.config.appId,
    application: 'Dezon Inbox (mock)',
    expires_at: 0,
    data_access_expires_at: 0,
  };
  if (input.kind === 'page' || input.kind === 'user') {
    sendJson(ctx, 200, {
      data: {
        ...base,
        type: input.kind === 'page' ? 'PAGE' : 'USER',
        is_valid: true,
        scopes: GRANTED_SCOPES,
        user_id: opts.config.user.id,
        ...(input.kind === 'page' ? { profile_id: input.page.id } : {}),
      },
    });
    return;
  }
  sendJson(ctx, 200, { data: { ...base, is_valid: false, error: { code: 190, message: 'Invalid token' } } });
}

function handlePermissions(ctx: Ctx, p: Principal): void {
  if (rejectBadToken(ctx, p)) return;
  sendJson(ctx, 200, { data: GRANTED_SCOPES.map((permission) => ({ permission, status: 'granted' })) });
}

/** Hộp thoại đăng nhập giả: chuyển ngay về redirect_uri kèm code (hoặc lỗi nếu ?mock_error=...). */
function handleDialog(ctx: Ctx, opts: Options): void {
  const q = ctx.url.searchParams;
  const redirectUri = q.get('redirect_uri');
  const sendText = (status: number, text: string) => {
    ctx.record.status = status;
    ctx.res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    ctx.res.end(text);
  };
  if (q.get('client_id') !== opts.config.appId)
    return sendText(400, 'Mock dialog: client_id không khớp appId của mock');
  if (!redirectUri) return sendText(400, 'Mock dialog: thiếu redirect_uri');
  let target: URL;
  try {
    target = new URL(redirectUri);
  } catch {
    return sendText(400, 'Mock dialog: redirect_uri không hợp lệ');
  }
  const state_ = q.get('state');
  const mockError = q.get('mock_error');
  if (mockError) {
    target.searchParams.set('error', mockError);
    target.searchParams.set('error_reason', 'user_denied');
    target.searchParams.set('error_description', 'Permissions error');
  } else {
    const code = `${MOCK_CODE}_${++state.seq}`;
    state.codes.set(code, redirectUri);
    state.codes.set(MOCK_CODE, redirectUri);
    target.searchParams.set('code', code);
  }
  if (state_ !== null) target.searchParams.set('state', state_);
  ctx.note.push(`scope=${q.get('scope') ?? ''}`);
  ctx.record.status = 302;
  ctx.res.writeHead(302, { location: target.toString() });
  ctx.res.end();
}

function serveBinary(ctx: Ctx, data: Buffer, mime: string): void {
  ctx.record.status = 200;
  ctx.res.writeHead(200, {
    'content-type': mime,
    'content-length': data.length,
    'cache-control': 'no-store',
  });
  ctx.res.end(data);
}

// ---------- Router ----------

async function route(ctx: Ctx, opts: Options): Promise<void> {
  const { method, segments } = ctx;
  const [s0, s1, s2] = segments;

  // Endpoint nội bộ của mock (không có version).
  if (ctx.version === null) {
    if (s0 === '__health' || (s0 === undefined && method === 'GET'))
      return sendJson(ctx, 200, { ok: true, service: 'mock-graph' });
    if (s0 === '__calls' && method === 'GET') {
      const path = ctx.url.searchParams.get('path');
      const m = ctx.url.searchParams.get('method');
      const calls = state.calls.filter(
        (c) => (!path || c.path.includes(path)) && (!m || c.method === m.toUpperCase()),
      );
      ctx.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      ctx.res.end(JSON.stringify({ count: calls.length, calls }));
      return;
    }
    if (s0 === '__inbox' && s1 === 'message' && method === 'POST') return handleInboxMessage(ctx, opts);
    if (s0 === '__reset' && method === 'POST') {
      resetState();
      return sendJson(ctx, 200, { ok: true });
    }
    if (s0 === 'avatar' && s1 && method === 'GET') {
      const seed = decodeURIComponent(s1).replace(/\.png$/i, '');
      let png = state.avatarCache.get(seed);
      if (!png) {
        png = makeAvatarPng(seed);
        state.avatarCache.set(seed, png);
      }
      return serveBinary(ctx, png, 'image/png');
    }
    if (s0 === 'files' && s1 && method === 'GET') {
      const file = state.files.get(decodeURIComponent(s1));
      if (!file) return sendJson(ctx, 404, { error: 'not found' });
      return serveBinary(ctx, file.data, file.mime);
    }
  }
  if (s0 === 'dialog' && s1 === 'oauth' && method === 'GET') return handleDialog(ctx, opts);

  const token = tokenOf(ctx);
  const p = resolvePrincipal(opts, token);
  ctx.record.auth = describePrincipal(p);
  // Graph thật kiểm appsecret_proof khi có gửi: HMAC-SHA256(appSecret, access_token).
  const proof = ctx.url.searchParams.get('appsecret_proof');
  if (proof !== null && token) {
    const expected = createHmac('sha256', opts.config.appSecret).update(token).digest('hex');
    if (proof !== expected) {
      return graphError(ctx, {
        code: 100,
        type: 'GraphMethodException',
        message: 'Invalid appsecret_proof provided in the API argument',
      });
    }
    ctx.note.push('appsecret_proof OK');
  }

  if (s0 === 'oauth' && s1 === 'access_token') return handleAccessToken(ctx, opts);
  if (s0 === 'debug_token' && method === 'GET') return handleDebugToken(ctx, opts, p);
  if (s0 === 'me' && s1 === undefined && method === 'GET') return handleMe(ctx, opts, p);
  if (s0 === 'me' && s1 === 'permissions' && method === 'GET') return handlePermissions(ctx, p);
  if (
    s0 &&
    s1 === 'accounts' &&
    s2 === undefined &&
    method === 'GET' &&
    (s0 === 'me' || s0 === opts.config.user.id)
  ) {
    return handleAccounts(ctx, opts, p);
  }
  if (s0 && s1 === 'subscribed_apps' && s2 === undefined) {
    const pageId = s0 === 'me' && p.kind === 'page' ? p.page.id : s0;
    return handleSubscribedApps(ctx, opts, p, pageId);
  }
  if (s0 && s1 === 'messages' && s2 === undefined && method === 'POST') return handleSend(ctx, opts, p, s0);
  if (s0 && s1 === 'conversations' && s2 === undefined && method === 'GET')
    return handleConversations(ctx, opts, p, s0);
  if (s0?.startsWith('t_') && s1 === 'messages' && s2 === undefined && method === 'GET')
    return handleThreadMessages(ctx, opts, p, s0);
  if (s0 && s1 === undefined && method === 'GET') return handleNode(ctx, opts, p, s0);

  ctx.note.push('KHÔNG HỖ TRỢ');
  graphError(ctx, {
    code: 100,
    subcode: 33,
    type: 'GraphMethodException',
    message: `Unsupported ${method} request (mock-graph chưa giả lập endpoint này).`,
  });
}

function log(line: string): void {
  const time = new Date().toISOString().slice(11, 23);
  console.log(`[mock-graph ${time}] ${line}`);
}

function createMockServer(opts: Options) {
  return createServer((req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://mock.local');
    const all = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const hasVersion = /^v\d+\.\d+$/.test(all[0] ?? '');
    const version = hasVersion ? (all[0] as string) : null;
    const method = (req.method ?? 'GET').toUpperCase();
    const record: CallRecord = {
      n: ++state.seq,
      at: new Date().toISOString(),
      method,
      path: url.pathname,
      version,
      query: redactQuery(url.searchParams),
      auth: 'none',
      status: 0,
    };
    const ctx: Ctx = {
      req,
      res,
      url,
      method,
      version,
      segments: hasVersion ? all.slice(1) : all,
      body: { fields: {} },
      record,
      note: [],
    };
    const internal = ['__calls', '__reset', '__health', '__inbox'].includes(all[0] ?? '');
    void (async () => {
      try {
        const raw = await readBody(req);
        ctx.body = await parseBody(raw, req.headers['content-type']);
        if (Object.keys(ctx.body.fields).length > 0) record.body = redactBody(ctx.body.fields);
        if (version && version !== opts.graphVersion)
          ctx.note.push(`CẢNH BÁO version ${version} != ${opts.graphVersion}`);
        await route(ctx, opts);
      } catch (err) {
        ctx.note.push(`exception: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent)
          graphError(ctx, { status: 500, code: 2, message: 'An unexpected error has occurred (mock).' });
      } finally {
        if (!internal) state.calls.push(record);
        const extra = ctx.note.length ? ` ${ctx.note.join(' ')}` : '';
        const who = record.auth !== 'none' ? ` [${record.auth}]` : '';
        log(`${method} ${url.pathname} -> ${record.status} (${Date.now() - started}ms)${who}${extra}`);
      }
    })();
  });
}

function main(): void {
  let opts: Options | 'help';
  try {
    opts = parseCli(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  if (opts === 'help') {
    console.log(USAGE);
    return;
  }
  const options = opts;
  const server = createMockServer(options);
  server.on('error', (err) => {
    console.error(`[mock-graph] Không mở được cổng ${options.port}: ${err.message}`);
    process.exit(1);
  });
  const onListen = () => {
    log(`Đang chạy tại ${options.publicUrl} (Graph ${options.graphVersion}, app_id ${options.config.appId})`);
    for (const page of options.config.pages)
      log(`  Page ${page.id} "${page.name}" — token: ${page.tokens.join(' | ')}`);
    if (options.echo) log(`  Echo webhook -> ${options.echo.webhookUrl} (app_id ${options.echo.appId})`);
  };
  if (options.host) server.listen(options.port, options.host, onListen);
  else server.listen(options.port, onListen);
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main();
