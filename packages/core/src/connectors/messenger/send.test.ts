import { describe, expect, it } from 'vitest';
import { PermanentSendError, TransientSendError, type ResolvedChannelAccount } from '../types';
import { createMessengerConnector, parseMessengerSendMetadata, type MessengerConfig } from './index';

const TOKEN = 'EAAB-page-token-secret';
const PAGE = '111111111111111';
const PSID = '2222222222222222';

interface Call {
  url: URL;
  init: RequestInit;
}

/** fetch giả: ghi lại request, trả lần lượt các phản hồi (hoặc ném lỗi). */
function fakeFetch(...responses: (Response | Error | (() => Response))[]) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('hết phản hồi giả');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const graphError = (status: number, code: number, subcode?: number, extra: Record<string, unknown> = {}) =>
  json(
    {
      error: {
        message: 'x',
        type: 'OAuthException',
        code,
        error_subcode: subcode,
        fbtrace_id: 'T',
        ...extra,
      },
    },
    status,
  );

const account: ResolvedChannelAccount = {
  id: 'acc-1',
  type: 'messenger',
  externalId: PAGE,
  credentials: { pageAccessToken: TOKEN },
};

function setup(...responses: Parameters<typeof fakeFetch>) {
  const fake = fakeFetch(...responses);
  const config: MessengerConfig = {
    appId: '999',
    appSecret: 's',
    graphBaseUrl: 'https://graph.test/',
    graphVersion: 'v26.0',
    fetch: fake.fn,
  };
  return { connector: createMessengerConnector(config), calls: fake.calls };
}

const headerOf = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

describe('send — text', () => {
  it('POST /{page}/messages, token ở header (không ở URL), RESPONSE + metadata', async () => {
    const { connector, calls } = setup(json({ recipient_id: PSID, message_id: 'm_sent_1' }));
    const result = await connector.send(
      account,
      { externalUserId: PSID },
      { kind: 'text', text: 'Xin chào' },
    );
    expect(result).toEqual({ externalMessageId: 'm_sent_1' });
    const [call] = calls;
    expect(call?.url.toString()).toBe(`https://graph.test/v26.0/${PAGE}/messages`);
    expect(call?.url.toString()).not.toContain(TOKEN);
    expect(call?.init.method).toBe('POST');
    expect(headerOf(call!.init, 'authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headerOf(call!.init, 'content-type')).toBe('application/json');
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(call?.init.body))).toEqual({
      recipient: { id: PSID },
      messaging_type: 'RESPONSE',
      message: { text: 'Xin chào', metadata: 'dezon-inbox' },
    });
  });

  it('options.messageId => metadata "dezon-inbox:<id>" (text và tệp)', async () => {
    const { connector, calls } = setup(json({ message_id: 'm1' }), json({ message_id: 'm2' }));
    await connector.send(
      account,
      { externalUserId: PSID },
      { kind: 'text', text: 'Hi' },
      { messageId: 'abc' },
    );
    await connector.send(
      account,
      { externalUserId: PSID },
      {
        kind: 'attachment',
        type: 'file',
        mime: 'application/pdf',
        filename: 'a.pdf',
        data: Buffer.from('x'),
      },
      { messageId: 'def' },
    );
    expect(JSON.parse(String(calls[0]?.init.body)).message.metadata).toBe('dezon-inbox:abc');
    const form = calls[1]!.init.body as FormData;
    expect(JSON.parse(String(form.get('message'))).metadata).toBe('dezon-inbox:def');
  });

  it('parseMessengerSendMetadata', () => {
    expect(parseMessengerSendMetadata('dezon-inbox')).toEqual({ own: true });
    expect(parseMessengerSendMetadata('dezon-inbox:abc')).toEqual({ own: true, messageId: 'abc' });
    expect(parseMessengerSendMetadata('dezon-inboxx')).toEqual({ own: false });
    expect(parseMessengerSendMetadata(undefined)).toEqual({ own: false });
  });

  it('options.tag => MESSAGE_TAG + HUMAN_AGENT', async () => {
    const { connector, calls } = setup(json({ message_id: 'm2' }));
    await connector.send(
      account,
      { externalUserId: PSID },
      { kind: 'text', text: 'Hi' },
      { tag: 'HUMAN_AGENT' },
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      messaging_type: 'MESSAGE_TAG',
      tag: 'HUMAN_AGENT',
    });
  });

  it('text ≥ 2000 ký tự hoặc rỗng => PermanentSendError, không gọi API', async () => {
    const { connector, calls } = setup();
    await expect(
      connector.send(account, { externalUserId: PSID }, { kind: 'text', text: 'a'.repeat(2000) }),
    ).rejects.toBeInstanceOf(PermanentSendError);
    await expect(
      connector.send(account, { externalUserId: PSID }, { kind: 'text', text: '  ' }),
    ).rejects.toBeInstanceOf(PermanentSendError);
    expect(calls).toHaveLength(0);
  });

  it('thiếu pageAccessToken => Permanent credentialsInvalid', async () => {
    const { connector } = setup();
    const err = await connector
      .send({ ...account, credentials: {} }, { externalUserId: PSID }, { kind: 'text', text: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentSendError);
    expect((err as PermanentSendError).credentialsInvalid).toBe(true);
  });

  it('phản hồi thiếu message_id => Permanent (không thử lại để tránh gửi trùng)', async () => {
    const { connector } = setup(json({ success: true }));
    await expect(
      connector.send(account, { externalUserId: PSID }, { kind: 'text', text: 'x' }),
    ).rejects.toBeInstanceOf(PermanentSendError);
  });
});

describe('send — attachment (multipart filedata)', () => {
  it('gửi form-data: recipient, message, messaging_type, filedata (tên + mime)', async () => {
    const { connector, calls } = setup(json({ recipient_id: PSID, message_id: 'm_img' }));
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const result = await connector.send(
      account,
      { externalUserId: PSID },
      { kind: 'attachment', type: 'image', mime: 'image/png', filename: 'mau.png', data },
      { tag: 'HUMAN_AGENT' },
    );
    expect(result.externalMessageId).toBe('m_img');
    const call = calls[0]!;
    expect(call.url.toString()).toBe(`https://graph.test/v26.0/${PAGE}/messages`);
    expect(headerOf(call.init, 'authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headerOf(call.init, 'content-type')).toBeNull(); // fetch tự đặt boundary
    const form = call.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(JSON.parse(String(form.get('recipient')))).toEqual({ id: PSID });
    expect(form.get('messaging_type')).toBe('MESSAGE_TAG');
    expect(form.get('tag')).toBe('HUMAN_AGENT');
    expect(JSON.parse(String(form.get('message')))).toEqual({
      attachment: { type: 'image', payload: { is_reusable: false } },
      metadata: 'dezon-inbox',
    });
    const file = form.get('filedata') as File;
    expect(file.name).toBe('mau.png');
    expect(file.type).toBe('image/png');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(data);
  });

  it('không tag => messaging_type RESPONSE, không có field tag', async () => {
    const { connector, calls } = setup(json({ message_id: 'm_file' }));
    await connector.send(
      account,
      { externalUserId: PSID },
      {
        kind: 'attachment',
        type: 'file',
        mime: 'application/pdf',
        filename: 'bao-gia.pdf',
        data: Buffer.from('%PDF'),
      },
    );
    const form = calls[0]!.init.body as FormData;
    expect(form.get('messaging_type')).toBe('RESPONSE');
    expect(form.has('tag')).toBe(false);
  });

  it('tệp > 25MB => PermanentSendError, không gọi API', async () => {
    const { connector, calls } = setup();
    const data = Buffer.alloc(25 * 1024 * 1024 + 1);
    await expect(
      connector.send(
        account,
        { externalUserId: PSID },
        { kind: 'attachment', type: 'video', mime: 'video/mp4', filename: 'v.mp4', data },
      ),
    ).rejects.toBeInstanceOf(PermanentSendError);
    expect(calls).toHaveLength(0);
  });
});

describe('send — ánh xạ lỗi', () => {
  const cases: [string, () => Response | Error, 'permanent' | 'transient', boolean, RegExp?][] = [
    ['190 token hết hạn', () => graphError(400, 190, 463), 'permanent', true, /kết nối lại/],
    ['190/492 mất quyền trên Page', () => graphError(400, 190, 492), 'permanent', true],
    ['102 session', () => graphError(400, 102), 'permanent', true],
    [
      '10/2018278 ngoài cửa sổ',
      () => graphError(400, 10, 2018278),
      'permanent',
      false,
      /ngoài cửa sổ gửi tin/,
    ],
    [
      '10/2534022 ngoài cửa sổ',
      () => graphError(400, 10, 2534022),
      'permanent',
      false,
      /ngoài cửa sổ gửi tin/,
    ],
    [
      '10 + message "outside of allowed window"',
      () => json({ error: { code: 10, message: 'This message is sent outside of allowed window.' } }, 400),
      'permanent',
      false,
      /ngoài cửa sổ gửi tin/,
    ],
    [
      '10/2018300 app khác giữ thread',
      () => graphError(400, 10, 2018300),
      'permanent',
      false,
      /ứng dụng khác/,
    ],
    [
      '10/2018108 không phải lỗi cửa sổ',
      () => graphError(400, 10, 2018108),
      'permanent',
      false,
      /không nhận được/,
    ],
    ['551 người dùng chặn', () => graphError(400, 551), 'permanent', false],
    ['551/1545041', () => graphError(400, 551, 1545041), 'permanent', false],
    ['200/1545041', () => graphError(400, 200, 1545041), 'permanent', false],
    ['100 tham số sai', () => graphError(400, 100), 'permanent', false],
    ['100/2018001 không có user', () => graphError(400, 100, 2018001), 'permanent', false],
    ['4 app rate limit', () => graphError(400, 4), 'transient', false],
    ['17 user rate limit', () => graphError(400, 17), 'transient', false],
    ['32 pages rate limit', () => graphError(400, 32), 'transient', false],
    ['613 rate limit', () => graphError(400, 613), 'transient', false],
    ['80006 BUC rate limit', () => graphError(400, 80006), 'transient', false],
    ['1 lỗi không rõ', () => graphError(500, 1), 'transient', false],
    ['2 lỗi tạm', () => graphError(503, 2), 'transient', false],
    ['HTTP 500 không JSON', () => new Response('<html>oops</html>', { status: 500 }), 'transient', false],
    ['HTTP 502 rỗng', () => new Response('', { status: 502 }), 'transient', false],
    ['lỗi mạng', () => new TypeError('fetch failed'), 'transient', false],
    [
      'timeout',
      () => Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
      'transient',
      false,
      /quá chậm/,
    ],
    ['400 không rõ mã', () => json({ error: { code: 999999 } }, 400), 'permanent', false],
  ];

  it.each(cases)('%s', async (_name, response, kind, credentialsInvalid, message) => {
    const { connector } = setup(response());
    const err = await connector
      .send(account, { externalUserId: PSID }, { kind: 'text', text: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(kind === 'permanent' ? PermanentSendError : TransientSendError);
    if (err instanceof PermanentSendError) expect(err.credentialsInvalid).toBe(credentialsInvalid);
    expect((err as Error).message).not.toContain(TOKEN);
    if (message) expect((err as Error).message).toMatch(message);
  });

  it('platformCode dạng "code/subcode"', async () => {
    const { connector } = setup(graphError(400, 10, 2018278));
    const err = (await connector
      .send(account, { externalUserId: PSID }, { kind: 'text', text: 'x' })
      .catch((e: unknown) => e)) as PermanentSendError;
    expect(err.platformCode).toBe('10/2018278');
  });

  it('lỗi ngoài cửa sổ mang reason = outside_window; lỗi khác thì không', async () => {
    for (const subcode of [2018278, 2534022]) {
      const { connector } = setup(graphError(400, 10, subcode));
      const err = (await connector
        .send(account, { externalUserId: PSID }, { kind: 'text', text: 'x' })
        .catch((e: unknown) => e)) as PermanentSendError;
      expect(err.reason).toBe('outside_window');
    }
    const { connector } = setup(graphError(400, 10, 2018108));
    const err = (await connector
      .send(account, { externalUserId: PSID }, { kind: 'text', text: 'x' })
      .catch((e: unknown) => e)) as PermanentSendError;
    expect(err.reason).toBeUndefined();
  });
});

describe('fetchProfile', () => {
  it('GET /{psid}?fields=... => name + avatarUrl', async () => {
    const { connector, calls } = setup(
      json({
        first_name: 'Lan',
        last_name: 'Nguyễn',
        name: 'Nguyễn Lan',
        profile_pic: 'https://cdn.test/p.jpg',
        id: PSID,
      }),
    );
    expect(await connector.fetchProfile!(account, PSID)).toEqual({
      name: 'Nguyễn Lan',
      avatarUrl: 'https://cdn.test/p.jpg',
    });
    const call = calls[0]!;
    expect(call.init.method).toBe('GET');
    expect(call.url.pathname).toBe(`/v26.0/${PSID}`);
    expect(call.url.searchParams.get('fields')).toBe('first_name,last_name,name,profile_pic');
    expect(call.url.toString()).not.toContain(TOKEN);
    expect(headerOf(call.init, 'authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('không có name => ghép first/last; object rỗng => {}', async () => {
    const { connector } = setup(json({ first_name: 'Lan', last_name: 'Nguyễn' }), json({}));
    expect(await connector.fetchProfile!(account, PSID)).toEqual({ name: 'Lan Nguyễn' });
    expect(await connector.fetchProfile!(account, PSID)).toEqual({});
  });

  it('lỗi Graph (thiếu quyền) => ném Error không chứa token', async () => {
    const { connector } = setup(graphError(400, 2018247));
    const err = await connector.fetchProfile!(account, PSID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/hồ sơ/);
    expect((err as Error).message).not.toContain(TOKEN);
  });
});
