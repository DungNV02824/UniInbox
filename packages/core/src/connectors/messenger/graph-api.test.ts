import { describe, expect, it } from 'vitest';
import { MESSENGER_SUBSCRIBED_FIELDS, createMessengerGraphApi } from './index';

const TOKEN = 'EAAB-page-token-secret';
const PAGE = '111111111111111';

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
  const api = createMessengerGraphApi({
    appId: '999',
    appSecret: 's',
    graphBaseUrl: 'https://graph.test',
    graphVersion: 'v26.0',
    fetch: fetchFn,
  });
  return { api, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const authOf = (init: RequestInit) => new Headers(init.headers).get('authorization');

describe('getPage', () => {
  it('Page token hợp lệ => {id, name}; gọi /me?fields=id,name,category', async () => {
    const { api, calls } = setup(
      json({ id: PAGE, name: 'Dezon Nội Thất', category: 'Interior Design Studio' }),
    );
    expect(await api.getPage(TOKEN)).toEqual({ id: PAGE, name: 'Dezon Nội Thất' });
    const call = calls[0]!;
    expect(call.init.method).toBe('GET');
    expect(call.url.pathname).toBe('/v26.0/me');
    expect(call.url.searchParams.get('fields')).toBe('id,name,category');
    expect(call.url.toString()).not.toContain(TOKEN);
    expect(authOf(call.init)).toBe(`Bearer ${TOKEN}`);
  });

  it('token người dùng (node User không có category) => "không phải của Fanpage"', async () => {
    const { api } = setup(
      json(
        {
          error: {
            message: '(#100) Tried accessing nonexisting field (category) on node type (User)',
            type: 'OAuthException',
            code: 100,
          },
        },
        400,
      ),
    );
    await expect(api.getPage(TOKEN)).rejects.toThrow('Token này không phải của Fanpage');
  });

  it('phản hồi không có category => "không phải của Fanpage"', async () => {
    const { api } = setup(json({ id: '1', name: 'Người dùng' }));
    await expect(api.getPage(TOKEN)).rejects.toThrow('Token này không phải của Fanpage');
  });

  it('token sai/hết hạn (190) => thông điệp tiếng Việt kèm mã, không chứa token', async () => {
    const { api } = setup(json({ error: { message: 'Invalid OAuth access token', code: 190 } }, 400));
    const err = (await api.getPage(TOKEN).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('Page Access Token không hợp lệ hoặc đã hết hạn');
    expect(err.message).toContain('190');
    expect(err.message).not.toContain(TOKEN);
  });

  it('token rỗng => lỗi, không gọi API', async () => {
    const { api, calls } = setup();
    await expect(api.getPage('  ')).rejects.toThrow('Page Access Token không hợp lệ');
    expect(calls).toHaveLength(0);
  });

  it('lỗi mạng => thông điệp thử lại', async () => {
    const { api } = setup(new TypeError('fetch failed'));
    await expect(api.getPage(TOKEN)).rejects.toThrow('Không kết nối được tới Facebook');
  });
});

describe('subscribeApp / unsubscribeApp', () => {
  it('POST /{page}/subscribed_apps với đủ subscribed_fields', async () => {
    const { api, calls } = setup(json({ success: true }));
    await api.subscribeApp(PAGE, TOKEN);
    const call = calls[0]!;
    expect(call.init.method).toBe('POST');
    expect(call.url.toString()).toBe(`https://graph.test/v26.0/${PAGE}/subscribed_apps`);
    expect(authOf(call.init)).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(String(call.init.body)) as { subscribed_fields: string };
    expect(body.subscribed_fields.split(',')).toEqual([...MESSENGER_SUBSCRIBED_FIELDS]);
    expect(MESSENGER_SUBSCRIBED_FIELDS).toEqual(
      expect.arrayContaining([
        'messages',
        'message_echoes',
        'standby',
        'messaging_handovers',
        'messaging_referrals',
      ]),
    );
  });

  it('success dạng chuỗi "true" cũng chấp nhận', async () => {
    const { api } = setup(json({ success: 'true' }));
    await expect(api.subscribeApp(PAGE, TOKEN)).resolves.toBeUndefined();
  });

  it('thiếu quyền (200) => lỗi tiếng Việt nêu quyền cần + mã', async () => {
    const { api } = setup(json({ error: { message: 'perm', code: 200 } }, 403));
    await expect(api.subscribeApp(PAGE, TOKEN)).rejects.toThrow(/pages_manage_metadata.*mã 200/);
  });

  it('success=false => lỗi', async () => {
    const { api } = setup(json({ success: false }));
    await expect(api.subscribeApp(PAGE, TOKEN)).rejects.toThrow('Không đăng ký được webhook');
  });

  it('DELETE /{page}/subscribed_apps', async () => {
    const { api, calls } = setup(json({ success: true }));
    await api.unsubscribeApp(PAGE, TOKEN);
    expect(calls[0]?.init.method).toBe('DELETE');
    expect(calls[0]?.url.pathname).toBe(`/v26.0/${PAGE}/subscribed_apps`);
  });

  it('unsubscribe lỗi Graph => Error kèm mã', async () => {
    const { api } = setup(json({ error: { code: 100, error_subcode: 33 } }, 400));
    await expect(api.unsubscribeApp(PAGE, TOKEN)).rejects.toThrow(
      'Không huỷ được đăng ký webhook của Fanpage (mã 100/33)',
    );
  });
});
