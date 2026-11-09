import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FACEBOOK_LOGIN_SCOPES, appSecretProof, createMessengerLoginApi, pageMessagingAccess } from './index';

const SECRET = 'app-secret-test';
const USER_TOKEN = 'EAAU-user-token-secret';
const CODE = 'AQD-code-secret';
const REDIRECT = 'http://localhost:4000/channels/messenger/oauth/callback';

interface Call {
  url: URL;
  init: RequestInit;
}

function setup(...responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('hết phản hồi giả');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  const api = createMessengerLoginApi({
    appId: '999',
    appSecret: SECRET,
    graphBaseUrl: 'https://graph.test',
    graphVersion: 'v26.0',
    fetch: fetchFn,
  });
  return { api, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const authOf = (init: RequestInit) => new Headers(init.headers).get('authorization');

describe('buildLoginUrl', () => {
  it('không có config_id => scope mặc định, response_type=code, đúng version', () => {
    const { api } = setup();
    const url = new URL(api.buildLoginUrl({ redirectUri: REDIRECT, state: 'st4te' }));
    expect(url.origin + url.pathname).toBe('https://www.facebook.com/v26.0/dialog/oauth');
    expect(url.searchParams.get('client_id')).toBe('999');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('state')).toBe('st4te');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('auth_type')).toBe('rerequest');
    expect(url.searchParams.get('scope')).toBe(FACEBOOK_LOGIN_SCOPES.join(','));
    expect(url.searchParams.has('config_id')).toBe(false);
    expect(url.toString()).not.toContain(SECRET);
  });

  it('có config_id => gửi config_id, KHÔNG gửi scope', () => {
    const { api } = setup();
    const url = new URL(api.buildLoginUrl({ redirectUri: REDIRECT, state: 's', configId: '123456' }));
    expect(url.searchParams.get('config_id')).toBe('123456');
    expect(url.searchParams.get('override_default_response_type')).toBe('true');
    expect(url.searchParams.has('scope')).toBe(false);
  });
});

describe('exchangeCode / exchangeLongLivedUserToken', () => {
  it('đổi code: GET oauth/access_token với client_id, client_secret, redirect_uri, code', async () => {
    const { api, calls } = setup(json({ access_token: 'short', token_type: 'bearer', expires_in: 5000 }));
    expect(await api.exchangeCode(CODE, REDIRECT)).toEqual({ accessToken: 'short', expiresIn: 5000 });
    const call = calls[0]!;
    expect(call.url.pathname).toBe('/v26.0/oauth/access_token');
    expect(call.url.searchParams.get('code')).toBe(CODE);
    expect(call.url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(call.url.searchParams.get('client_secret')).toBe(SECRET);
    expect(authOf(call.init)).toBeNull();
  });

  it('đổi token dài hạn: grant_type=fb_exchange_token', async () => {
    const { api, calls } = setup(json({ access_token: 'long', token_type: 'bearer' }));
    expect(await api.exchangeLongLivedUserToken('short')).toEqual({ accessToken: 'long', expiresIn: null });
    const q = calls[0]!.url.searchParams;
    expect(q.get('grant_type')).toBe('fb_exchange_token');
    expect(q.get('fb_exchange_token')).toBe('short');
  });

  it('lỗi Graph => FacebookLoginError tiếng Việt có mã, không chứa code/secret', async () => {
    const { api } = setup(json({ error: { message: 'Invalid verification code', code: 100 } }, 400));
    const err = (await api.exchangeCode(CODE, REDIRECT).catch((e: unknown) => e)) as Error;
    expect(err.name).toBe('FacebookLoginError');
    expect(err.message).toContain('Không đổi được mã đăng nhập Facebook');
    expect(err.message).toContain('100');
    expect(err.message).not.toContain(CODE);
    expect(err.message).not.toContain(SECRET);
  });

  it('lỗi mạng => thông điệp thân thiện', async () => {
    const { api } = setup(new TypeError('fetch failed'));
    await expect(api.exchangeCode(CODE, REDIRECT)).rejects.toThrow('Không kết nối được tới Facebook');
  });
});

describe('getMe / listPages', () => {
  it('getMe: token ở header, có appsecret_proof', async () => {
    const { api, calls } = setup(json({ id: '42', name: 'Đúng Văn' }));
    expect(await api.getMe(USER_TOKEN)).toEqual({ id: '42', name: 'Đúng Văn' });
    const call = calls[0]!;
    expect(call.url.pathname).toBe('/v26.0/me');
    expect(authOf(call.init)).toBe(`Bearer ${USER_TOKEN}`);
    expect(call.url.toString()).not.toContain(USER_TOKEN);
    expect(call.url.searchParams.get('appsecret_proof')).toBe(
      createHmac('sha256', SECRET).update(USER_TOKEN).digest('hex'),
    );
  });

  it('listPages: theo cursor after (không gọi URL paging.next), bỏ mục thiếu token', async () => {
    const { api, calls } = setup(
      json({
        data: [
          {
            id: '1',
            name: 'Demo app',
            access_token: 'p1',
            tasks: ['MESSAGING', 'MODERATE'],
            picture: { data: { url: 'https://cdn.test/1.jpg' } },
          },
          { id: '2', name: 'Thiếu token' },
        ],
        paging: {
          cursors: { after: 'CUR1' },
          next: `https://graph.test/v26.0/me/accounts?access_token=${USER_TOKEN}&after=CUR1`,
        },
      }),
      json({ data: [{ id: '3', name: 'Trang 3', access_token: 'p3' }], paging: { cursors: { after: 'X' } } }),
    );
    expect(await api.listPages(USER_TOKEN)).toEqual([
      {
        id: '1',
        name: 'Demo app',
        accessToken: 'p1',
        tasks: ['MESSAGING', 'MODERATE'],
        pictureUrl: 'https://cdn.test/1.jpg',
      },
      { id: '3', name: 'Trang 3', accessToken: 'p3', tasks: null, pictureUrl: null },
    ]);
    expect(calls.filter((c) => c.url.pathname.endsWith('/me/accounts'))).toHaveLength(2);
    expect(calls[0]!.url.searchParams.get('fields')).toBe('id,name,access_token,tasks,picture{url}');
    expect(calls[1]!.url.searchParams.get('after')).toBe('CUR1');
    for (const c of calls) expect(c.url.toString()).not.toContain(USER_TOKEN);
  });

  it('listPages: field picture bị từ chối => thử lại không có picture', async () => {
    const { api, calls } = setup(
      json({ error: { message: 'requires pages_read_engagement', code: 200 } }, 403),
      json({ data: [{ id: '1', name: 'A', access_token: 'p1', tasks: ['MANAGE'] }] }),
    );
    const pages = await api.listPages(USER_TOKEN);
    expect(pages).toHaveLength(1);
    expect(calls[1]!.url.searchParams.get('fields')).toBe('id,name,access_token,tasks');
  });

  it('listPages: bổ sung Trang được giao qua Business Manager (owned_pages + client_pages), không trùng', async () => {
    const { api, calls } = setup(
      json({ data: [{ id: '1', name: 'Trang riêng', access_token: 'p1', tasks: ['MESSAGING', 'MANAGE'] }] }),
      json({ data: [{ id: 'B1', name: 'Dezon' }] }),
      json({
        data: [
          { id: '1', name: 'Trang riêng', access_token: 'p1' },
          {
            id: '7',
            name: 'Trang doanh nghiệp',
            access_token: 'p7',
            picture: { data: { url: 'https://cdn.test/7.jpg' } },
          },
          { id: '8', name: 'Thiếu token' },
        ],
      }),
      json({ error: { message: 'no access', code: 200 } }, 403),
    );
    expect(await api.listPages(USER_TOKEN)).toEqual([
      { id: '1', name: 'Trang riêng', accessToken: 'p1', tasks: ['MESSAGING', 'MANAGE'], pictureUrl: null },
      {
        id: '7',
        name: 'Trang doanh nghiệp',
        accessToken: 'p7',
        tasks: null,
        pictureUrl: 'https://cdn.test/7.jpg',
      },
    ]);
    expect(calls.map((c) => c.url.pathname)).toEqual([
      '/v26.0/me/accounts',
      '/v26.0/me/businesses',
      '/v26.0/B1/owned_pages',
      '/v26.0/B1/client_pages',
    ]);
    for (const c of calls) {
      expect(c.url.toString()).not.toContain(USER_TOKEN);
      expect(c.url.toString()).not.toContain(SECRET);
    }
  });

  it('listPages: token hết hạn (190) => lỗi', async () => {
    const { api } = setup(json({ error: { message: 'expired', code: 190 } }, 400));
    await expect(api.listPages(USER_TOKEN)).rejects.toThrow(
      'Không lấy được danh sách Trang từ Facebook (mã 190)',
    );
  });
});

describe('pageMessagingAccess', () => {
  it.each([
    [['MESSAGING', 'MODERATE'], true],
    [['MESSAGING', 'MANAGE'], true],
    [['MESSAGING', 'CREATE_CONTENT'], true],
    [['MESSAGING'], false],
    [['MODERATE', 'MANAGE', 'CREATE_CONTENT'], false],
    [[], false],
  ])('%j => %s', (tasks, ok) => {
    const r = pageMessagingAccess(tasks);
    expect(r.canMessage).toBe(ok);
    expect(r.reason === null).toBe(ok);
  });

  it('không có tasks => cho thử', () => {
    expect(pageMessagingAccess(null)).toEqual({ canMessage: true, reason: null });
  });

  it('appSecretProof = hex HMAC-SHA256', () => {
    expect(appSecretProof('t', 'k')).toMatch(/^[0-9a-f]{64}$/);
  });
});
