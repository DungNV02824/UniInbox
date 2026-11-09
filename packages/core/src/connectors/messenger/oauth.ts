// Facebook Login (luồng thủ công redirect + code) để admin chọn Fanpage thay vì dán token.
// Nguồn: docs/research/messenger-platform.md §12. KHÔNG ghi log token/code.
import { createHmac } from 'node:crypto';
import type { MessengerConfig } from './config';
import {
  GraphNetworkError,
  graphErrorCode,
  graphRequest,
  type GraphRequest,
  type GraphResponse,
} from './graph';

export const FACEBOOK_DIALOG_BASE_URL = 'https://www.facebook.com';

/**
 * Quyền khi không dùng config_id (§12e): pages_messaging phụ thuộc pages_show_list + pages_manage_metadata;
 * pages_read_engagement cho Conversations API (đồng bộ); business_management để thấy Trang thuộc
 * Business Manager (không có trong /me/accounts nếu người dùng chỉ được giao Trang qua doanh nghiệp).
 */
export const FACEBOOK_LOGIN_SCOPES = [
  'pages_show_list',
  'pages_manage_metadata',
  'pages_messaging',
  'pages_read_engagement',
  'business_management',
] as const;

/** Giới hạn số vòng phân trang /me/accounts (100 Page mỗi trang). */
const MAX_PAGE_REQUESTS = 20;
const PAGES_LIMIT = '100';

export interface FacebookLoginUrlInput {
  redirectUri: string;
  state: string;
  /** Facebook Login for Business: có config_id thì KHÔNG gửi scope (§12d). */
  configId?: string;
  scopes?: readonly string[];
}

export interface FacebookUserToken {
  accessToken: string;
  /** Giây; null nếu Meta không trả. */
  expiresIn: number | null;
}

export interface FacebookManagedPage {
  id: string;
  name: string;
  /** Page Access Token (lấy bằng user token dài hạn => không hết hạn). */
  accessToken: string;
  /** null = Meta không trả `tasks`. */
  tasks: string[] | null;
  pictureUrl: string | null;
}

/** Facebook Login + liệt kê Page của người dùng. */
export interface MessengerLoginApi {
  buildLoginUrl(input: FacebookLoginUrlInput): string;
  /** Đổi `code` lấy user token ngắn hạn. `redirectUri` phải trùng URL đã mở dialog. */
  exchangeCode(code: string, redirectUri: string): Promise<FacebookUserToken>;
  /** grant_type=fb_exchange_token => user token dài hạn (~60 ngày). */
  exchangeLongLivedUserToken(userToken: string): Promise<FacebookUserToken>;
  getMe(userToken: string): Promise<{ id: string; name: string }>;
  /** GET /me/accounts (theo phân trang) => các Page kèm Page token. */
  listPages(userToken: string): Promise<FacebookManagedPage[]>;
}

/** Lỗi của luồng đăng nhập; message tiếng Việt, không chứa token/code. */
export class FacebookLoginError extends Error {
  override readonly name = 'FacebookLoginError';
}

/** appsecret_proof = hex HMAC-SHA256(appSecret, accessToken) (§12f). */
export function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

const PAGE_SUBSCRIBE_TASKS = ['MODERATE', 'MANAGE', 'CREATE_CONTENT'];

/**
 * Quyền nhắn tin theo task (§12c): cần MESSAGING (gửi tin) và một trong MODERATE/MANAGE/CREATE_CONTENT
 * (đăng ký webhook). Không có `tasks` => cho thử, lỗi thật sẽ báo khi kết nối.
 */
export function pageMessagingAccess(tasks: readonly string[] | null): {
  canMessage: boolean;
  reason: string | null;
} {
  if (!tasks) return { canMessage: true, reason: null };
  const has = (t: string) => tasks.includes(t);
  if (!has('MESSAGING')) {
    return {
      canMessage: false,
      reason: 'Tài khoản Facebook này không có quyền nhắn tin (MESSAGING) trên Trang',
    };
  }
  if (!PAGE_SUBSCRIBE_TASKS.some(has)) {
    return {
      canMessage: false,
      reason:
        'Tài khoản Facebook này không đủ quyền đăng ký nhận tin cho Trang (cần quyền kiểm duyệt hoặc quản lý)',
    };
  }
  return { canMessage: true, reason: null };
}

type Failure = Extract<GraphResponse, { ok: false }>;

async function request(config: MessengerConfig, req: GraphRequest): Promise<GraphResponse> {
  try {
    return await graphRequest(config, req);
  } catch (err) {
    if (err instanceof GraphNetworkError) {
      throw new FacebookLoginError('Không kết nối được tới Facebook, vui lòng thử lại');
    }
    throw err;
  }
}

function fail(label: string, res: Failure): never {
  throw new FacebookLoginError(`${label} (mã ${graphErrorCode(res.status, res.error)})`);
}

function parseToken(data: Record<string, unknown>, label: string): FacebookUserToken {
  const accessToken = data.access_token;
  if (typeof accessToken !== 'string' || !accessToken) throw new FacebookLoginError(label);
  const expires = data.expires_in;
  const expiresIn = typeof expires === 'number' && Number.isFinite(expires) ? expires : null;
  return { accessToken, expiresIn };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function parsePage(raw: unknown): FacebookManagedPage | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const id = str(p.id);
  const name = str(p.name);
  const accessToken = str(p.access_token);
  if (!id || !name || !accessToken) return null;
  const tasks = Array.isArray(p.tasks) ? p.tasks.filter((t): t is string => typeof t === 'string') : null;
  const picture = p.picture as { data?: { url?: unknown } } | undefined;
  return { id, name, accessToken, tasks, pictureUrl: str(picture?.data?.url) };
}

/** Doanh nghiệp từ /me/businesses: tái dùng kiểu Trang (chỉ cần id) để đi qua collectEdge. */
function parseBusiness(raw: unknown): FacebookManagedPage | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = str((raw as Record<string, unknown>).id);
  return id ? { id, name: id, accessToken: '', tasks: null, pictureUrl: null } : null;
}

/** Lỗi quyền/field (10, 100, 200-299) khi xin field picture => thử lại không có picture. */
function isFieldOrPermissionError(res: Failure): boolean {
  const code = res.error.code;
  return code === 10 || code === 100 || (code !== undefined && code >= 200 && code < 300);
}

export function createLoginApi(config: MessengerConfig): MessengerLoginApi {
  const userGet = (path: string, token: string, query: Record<string, string>, label: string) => {
    if (!token.trim()) throw new FacebookLoginError(label);
    return request(config, {
      method: 'GET',
      path,
      token,
      query: { ...query, appsecret_proof: appSecretProof(token, config.appSecret) },
    });
  };

  /** Đọc một edge danh sách (me/accounts, {biz}/owned_pages...) theo cursor `after`. */
  async function collectEdge(
    userToken: string,
    path: string,
    fields: string,
    parse: (raw: unknown) => FacebookManagedPage | null,
  ): Promise<FacebookManagedPage[] | Failure> {
    const label = 'Không lấy được danh sách Trang từ Facebook';
    const pages: FacebookManagedPage[] = [];
    let after: string | null = null;
    for (let i = 0; i < MAX_PAGE_REQUESTS; i++) {
      const query: Record<string, string> = { fields, limit: PAGES_LIMIT };
      if (after) query.after = after;
      const res = await userGet(path, userToken, query, label);
      if (!res.ok) return res;
      const data = Array.isArray(res.data.data) ? res.data.data : [];
      for (const raw of data) {
        const page = parse(raw);
        if (page) pages.push(page);
      }
      // Đi theo cursor `after` thay vì gọi thẳng paging.next (URL đó chứa access_token).
      const paging = res.data.paging as { next?: unknown; cursors?: { after?: unknown } } | undefined;
      after = paging?.next ? str(paging.cursors?.after) : null;
      if (!after) break;
    }
    return pages;
  }

  const listPagesWith = (userToken: string, fields: string) =>
    collectEdge(userToken, 'me/accounts', fields, parsePage);

  /** Edge phụ: lỗi (thiếu business_management, không có doanh nghiệp...) => danh sách rỗng. */
  async function edgeOrEmpty(userToken: string, path: string, fields: string, parse = parsePage) {
    try {
      const res = await collectEdge(userToken, path, fields, parse);
      return Array.isArray(res) ? res : [];
    } catch {
      return [];
    }
  }

  /**
   * /me/accounts chỉ trả Trang người dùng có vai trò trực tiếp; Trang được giao qua Business Manager
   * bị bỏ sót. Bổ sung Trang của từng doanh nghiệp (owned_pages + client_pages, cần business_management).
   * Facebook chỉ trả các tài sản người dùng đã chọn trong hộp thoại cấp quyền.
   */
  async function withBusinessPages(userToken: string, pages: FacebookManagedPage[]) {
    const businesses = await edgeOrEmpty(userToken, 'me/businesses', 'id,name', parseBusiness);
    const known = new Set(pages.map((p) => p.id));
    const result = [...pages];
    for (const biz of businesses) {
      for (const edge of ['owned_pages', 'client_pages']) {
        const found = await edgeOrEmpty(userToken, `${biz.id}/${edge}`, 'id,name,access_token,picture{url}');
        for (const page of found) {
          if (known.has(page.id)) continue;
          known.add(page.id);
          result.push(page);
        }
      }
    }
    return result;
  }

  return {
    buildLoginUrl({ redirectUri, state, configId, scopes }) {
      const version = config.graphVersion.replace(/^\/+|\/+$/g, '');
      const base = (config.loginDialogBaseUrl ?? FACEBOOK_DIALOG_BASE_URL).replace(/\/+$/, '');
      const url = new URL(`${base}/${version}/dialog/oauth`);
      url.searchParams.set('client_id', config.appId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('response_type', 'code');
      // Facebook nhớ các Page đã chọn ở lần trước và có thể bỏ qua bước chọn: buộc hỏi lại quyền đã
      // từ chối/chưa cấp để admin cấp pages_messaging cho Page mới (quyền được cấp theo từng Page).
      url.searchParams.set('auth_type', 'rerequest');
      if (configId) {
        url.searchParams.set('config_id', configId);
        url.searchParams.set('override_default_response_type', 'true');
      } else {
        url.searchParams.set('scope', (scopes ?? FACEBOOK_LOGIN_SCOPES).join(','));
      }
      return url.toString();
    },

    async exchangeCode(code, redirectUri) {
      const label = 'Không đổi được mã đăng nhập Facebook';
      if (!code.trim()) throw new FacebookLoginError(label);
      const res = await request(config, {
        method: 'GET',
        path: 'oauth/access_token',
        token: '',
        query: {
          client_id: config.appId,
          client_secret: config.appSecret,
          redirect_uri: redirectUri,
          code,
        },
      });
      if (!res.ok) fail(label, res);
      return parseToken(res.data, label);
    },

    async exchangeLongLivedUserToken(userToken) {
      const label = 'Không đổi được token Facebook dài hạn';
      if (!userToken.trim()) throw new FacebookLoginError(label);
      const res = await request(config, {
        method: 'GET',
        path: 'oauth/access_token',
        token: '',
        query: {
          grant_type: 'fb_exchange_token',
          client_id: config.appId,
          client_secret: config.appSecret,
          fb_exchange_token: userToken,
        },
      });
      if (!res.ok) fail(label, res);
      return parseToken(res.data, label);
    },

    async getMe(userToken) {
      const label = 'Không lấy được thông tin tài khoản Facebook';
      const res = await userGet('me', userToken, { fields: 'id,name' }, label);
      if (!res.ok) fail(label, res);
      const id = str(res.data.id);
      const name = str(res.data.name);
      if (!id) throw new FacebookLoginError(label);
      return { id, name: name ?? 'Tài khoản Facebook' };
    },

    async listPages(userToken) {
      const label = 'Không lấy được danh sách Trang từ Facebook';
      const withPicture = await listPagesWith(userToken, 'id,name,access_token,tasks,picture{url}');
      if (Array.isArray(withPicture)) return withBusinessPages(userToken, withPicture);
      if (!isFieldOrPermissionError(withPicture)) fail(label, withPicture);
      const plain = await listPagesWith(userToken, 'id,name,access_token,tasks');
      if (Array.isArray(plain)) return withBusinessPages(userToken, plain);
      return fail(label, plain);
    },
  };
}
