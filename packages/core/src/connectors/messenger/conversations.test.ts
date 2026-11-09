import { describe, expect, it } from 'vitest';
import { PermanentSendError, TransientSendError } from '../types';
import { appSecretProof, createMessengerConnector, messengerConversationsOf } from './index';

const TOKEN = 'EAAB-page-token-secret';
const PAGE = '1373442085851879';
const PSID = '39840294375585055';

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
  const connector = createMessengerConnector({
    appId: '999',
    appSecret: 'app-secret',
    graphBaseUrl: 'https://graph.test',
    graphVersion: 'v26.0',
    fetch: fetchFn,
  });
  const reader = messengerConversationsOf(connector)!;
  return { reader, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

// Dạng phản hồi thật (đã rút gọn) ngày 2026-11-05.
const conv = (id: string, updated: string, psid: string, name: string) => ({
  id,
  updated_time: updated,
  message_count: 2,
  participants: {
    data: [
      { name, email: `${psid}@facebook.com`, id: psid },
      { name: 'Demo app', email: `${PAGE}@facebook.com`, id: PAGE },
    ],
  },
});
const paging = (after: string, next = true) => ({
  cursors: { before: 'B', after },
  ...(next ? { next: `https://graph.facebook.com/v27.0/x?access_token=${TOKEN}&after=${after}` } : {}),
});

describe('listConversations', () => {
  it('GET /{page}/conversations: token ở header, có appsecret_proof, platform, fields, limit, after', async () => {
    const { reader, calls } = setup(
      json({
        data: [conv('t_1', '2026-11-05T15:00:20+0000', PSID, 'Đúng Văn')],
        paging: paging('CUR2'),
      }),
    );
    const page = await reader.listConversations(TOKEN, PAGE, { limit: 25, after: 'CUR1' });
    expect(page.after).toBe('CUR2');
    expect(page.items).toEqual([
      {
        id: 't_1',
        updatedTime: new Date('2026-11-05T15:00:20Z'),
        messageCount: 2,
        participants: [
          { id: PSID, name: 'Đúng Văn' },
          { id: PAGE, name: 'Demo app' },
        ],
      },
    ]);
    const call = calls[0]!;
    expect(call.init.method).toBe('GET');
    expect(call.url.pathname).toBe(`/v26.0/${PAGE}/conversations`);
    expect(call.url.searchParams.get('platform')).toBe('messenger');
    expect(call.url.searchParams.get('fields')).toBe('id,updated_time,message_count,participants');
    expect(call.url.searchParams.get('limit')).toBe('25');
    expect(call.url.searchParams.get('after')).toBe('CUR1');
    expect(call.url.searchParams.get('appsecret_proof')).toBe(appSecretProof(TOKEN, 'app-secret'));
    expect(call.url.toString()).not.toContain(TOKEN);
    expect(new Headers(call.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('không có paging.next => after null (trang cuối), dù có cursors.after', async () => {
    const { reader } = setup(json({ data: [], paging: paging('X', false) }));
    expect(await reader.listConversations(TOKEN, PAGE, { limit: 25 })).toEqual({ items: [], after: null });
  });

  it('since: dừng ở hội thoại cũ hơn mốc (Graph bỏ qua tham số since)', async () => {
    const { reader, calls } = setup(
      json({
        data: [
          conv('t_1', '2026-11-05T15:00:20+0000', PSID, 'A'),
          conv('t_2', '2026-11-03T04:20:59+0000', '2', 'B'),
          conv('t_3', '2026-11-05T16:00:00+0000', '3', 'C'),
        ],
        paging: paging('NEXT'),
      }),
    );
    const page = await reader.listConversations(TOKEN, PAGE, {
      limit: 25,
      since: new Date('2026-11-04T00:00:00Z'),
    });
    expect(page.items.map((c) => c.id)).toEqual(['t_1']);
    expect(page.after).toBeNull();
    expect(calls[0]!.url.searchParams.has('since')).toBe(false);
  });

  it('bỏ mục sai cấu trúc', async () => {
    const { reader } = setup(
      json({ data: [{ id: 't_x' }, null, conv('t_1', '2026-11-05T15:00:20+0000', PSID, 'A')] }),
    );
    const page = await reader.listConversations(TOKEN, PAGE, { limit: 25 });
    expect(page.items.map((c) => c.id)).toEqual(['t_1']);
  });

  it('token hỏng (190) => PermanentSendError credentialsInvalid, thông điệp không chứa token', async () => {
    const { reader } = setup(
      json(
        {
          error: { message: `Invalid OAuth ${TOKEN}`, type: 'OAuthException', code: 190, error_subcode: 460 },
        },
        400,
      ),
    );
    const err = await reader.listConversations(TOKEN, PAGE, { limit: 25 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentSendError);
    expect((err as PermanentSendError).credentialsInvalid).toBe(true);
    expect((err as Error).message).toContain('190/460');
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('thiếu quyền (10/200) => Permanent không phải credentials; rate limit / 5xx / mạng => Transient', async () => {
    const { reader } = setup(
      json({ error: { code: 200, type: 'OAuthException' } }, 403),
      json({ error: { code: 4 } }, 400),
      json({}, 503),
      new TypeError('fetch failed'),
      json({ error: { code: 33, error_subcode: 1893013 } }, 400),
    );
    const run = () => reader.listConversations(TOKEN, PAGE, { limit: 25 }).catch((e: unknown) => e);
    const forbidden = await run();
    expect(forbidden).toBeInstanceOf(PermanentSendError);
    expect((forbidden as PermanentSendError).credentialsInvalid).toBe(false);
    expect(await run()).toBeInstanceOf(TransientSendError);
    expect(await run()).toBeInstanceOf(TransientSendError);
    expect(await run()).toBeInstanceOf(TransientSendError);
    const invalid = await run();
    expect(invalid).toBeInstanceOf(PermanentSendError);
    expect((invalid as Error).message).toContain('33/1893013');
  });
});

describe('listMessages', () => {
  it('GET /{conversation}/messages với fields đủ đính kèm, parse from/to/attachments/sticker/shares', async () => {
    const { reader, calls } = setup(
      json({
        data: [
          {
            id: 'm_2',
            message: '',
            from: { name: 'Đúng Văn', email: `${PSID}@facebook.com`, id: PSID },
            to: { data: [{ name: 'Demo app', id: PAGE }] },
            created_time: '2026-11-05T15:00:20+0000',
            attachments: {
              data: [
                {
                  id: 'a1',
                  mime_type: 'image/jpeg',
                  name: 'image-1.jpg',
                  image_data: { url: 'https://cdn.test/1.jpg', width: 960, height: 1280 },
                },
                {
                  id: 'a2',
                  mime_type: 'application/pdf',
                  name: 'bao-gia.pdf',
                  file_url: 'https://cdn.test/f.pdf',
                },
              ],
            },
            sticker: 'https://cdn.test/sticker.png',
            shares: {
              data: [{ link: 'https://l.facebook.com/l.php?u=https%3A%2F%2Fdezon.vn%2F', name: 'Dezon' }],
            },
          },
        ],
        paging: paging('M2'),
      }),
    );
    const page = await reader.listMessages(TOKEN, 't_1', { limit: 50 });
    expect(calls[0]!.url.pathname).toBe('/v26.0/t_1/messages');
    expect(calls[0]!.url.searchParams.get('fields')).toContain(
      'attachments{id,mime_type,name,file_url,image_data',
    );
    expect(calls[0]!.url.searchParams.get('appsecret_proof')).toMatch(/^[0-9a-f]{64}$/);
    expect(page.after).toBe('M2');
    expect(page.items[0]).toEqual({
      id: 'm_2',
      text: '',
      from: { id: PSID, name: 'Đúng Văn' },
      to: [{ id: PAGE, name: 'Demo app' }],
      createdTime: new Date('2026-11-05T15:00:20Z'),
      attachments: [
        {
          id: 'a1',
          mimeType: 'image/jpeg',
          name: 'image-1.jpg',
          image: { url: 'https://cdn.test/1.jpg', width: 960, height: 1280 },
        },
        { id: 'a2', mimeType: 'application/pdf', name: 'bao-gia.pdf', fileUrl: 'https://cdn.test/f.pdf' },
      ],
      sticker: 'https://cdn.test/sticker.png',
      shares: [{ link: 'https://l.facebook.com/l.php?u=https%3A%2F%2Fdezon.vn%2F', name: 'Dezon' }],
    });
  });

  it('since: dừng ở tin cũ hơn mốc', async () => {
    const msg = (id: string, t: string) => ({ id, message: id, from: { id: PSID }, created_time: t });
    const { reader } = setup(
      json({
        data: [msg('m_3', '2026-11-05T10:00:00+0000'), msg('m_2', '2026-11-05T08:59:59+0000')],
        paging: paging('M'),
      }),
    );
    const page = await reader.listMessages(TOKEN, 't_1', {
      limit: 50,
      since: new Date('2026-11-05T09:00:00Z'),
    });
    expect(page.items.map((m) => m.id)).toEqual(['m_3']);
    expect(page.after).toBeNull();
  });
});
