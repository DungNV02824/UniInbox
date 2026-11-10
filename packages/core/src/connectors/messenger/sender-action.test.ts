import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermanentSendError, TransientSendError, type ResolvedChannelAccount } from '../types';
import { createMessengerConnector, SENDER_ACTION_TIMEOUT_MS, type MessengerConfig } from './index';

const TOKEN = 'EAAB-page-token-secret';
const PAGE = '111111111111111';
const PSID = '2222222222222222';

const account: ResolvedChannelAccount = {
  id: 'acc-1',
  type: 'messenger',
  externalId: PAGE,
  credentials: { pageAccessToken: TOKEN },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(...responses: (Response | Error)[]) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('hết phản hồi giả');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof globalThis.fetch;
  const config: MessengerConfig = {
    appId: '999',
    appSecret: 's',
    graphBaseUrl: 'https://graph.test/',
    graphVersion: 'v26.0',
    fetch,
  };
  return { connector: createMessengerConnector(config), calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sendSenderAction', () => {
  it.each(['typing_on', 'typing_off', 'mark_seen'] as const)(
    '%s: POST /{page}/messages, token ở header, body chỉ recipient + sender_action',
    async (action) => {
      const { connector, calls } = setup(json({ recipient_id: PSID }));
      await expect(
        connector.sendSenderAction!(account, { externalUserId: PSID }, action),
      ).resolves.toBeUndefined();
      const [call] = calls;
      expect(call?.url.toString()).toBe(`https://graph.test/v26.0/${PAGE}/messages`);
      expect(call?.url.toString()).not.toContain(TOKEN);
      expect(call?.init.method).toBe('POST');
      const headers = new Headers(call!.init.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(headers.get('content-type')).toBe('application/json');
      expect(JSON.parse(String(call?.init.body))).toEqual({
        recipient: { id: PSID },
        sender_action: action,
      });
    },
  );

  it('timeout ngắn (≤ 3 s), không dùng timeout 15 s của Graph', async () => {
    expect(SENDER_ACTION_TIMEOUT_MS).toBeLessThanOrEqual(3_000);
    const spy = vi.spyOn(AbortSignal, 'timeout');
    const { connector } = setup(json({ recipient_id: PSID }));
    await connector.sendSenderAction!(account, { externalUserId: PSID }, 'typing_on');
    expect(spy).toHaveBeenCalledWith(SENDER_ACTION_TIMEOUT_MS);
  });

  it('phản hồi không có message_id vẫn là thành công (khác gửi tin)', async () => {
    const { connector } = setup(json({}));
    await expect(
      connector.sendSenderAction!(account, { externalUserId: PSID }, 'typing_on'),
    ).resolves.toBeUndefined();
  });

  it('lỗi Graph ⇒ PermanentSendError (token hỏng đánh dấu credentials, không lộ token)', async () => {
    const { connector } = setup(
      json({ error: { message: `bad ${TOKEN}`, type: 'OAuthException', code: 190 } }, 400),
    );
    const err = await connector.sendSenderAction!(account, { externalUserId: PSID }, 'typing_on').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PermanentSendError);
    expect((err as PermanentSendError).credentialsInvalid).toBe(true);
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('ngoài cửa sổ ⇒ PermanentSendError reason outside_window', async () => {
    const { connector } = setup(
      json({ error: { message: 'outside of allowed window', code: 10, error_subcode: 2018278 } }, 400),
    );
    const err = await connector.sendSenderAction!(account, { externalUserId: PSID }, 'typing_on').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PermanentSendError);
    expect((err as PermanentSendError).reason).toBe('outside_window');
  });

  it('lỗi mạng / timeout ⇒ TransientSendError', async () => {
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    const { connector } = setup(new Error('ECONNRESET'), timeout);
    const a = await connector.sendSenderAction!(account, { externalUserId: PSID }, 'typing_on').catch(
      (e: unknown) => e,
    );
    const b = await connector.sendSenderAction!(account, { externalUserId: PSID }, 'typing_on').catch(
      (e: unknown) => e,
    );
    expect(a).toBeInstanceOf(TransientSendError);
    expect((a as TransientSendError).platformCode).toBe('network');
    expect((b as TransientSendError).platformCode).toBe('timeout');
  });

  it('thiếu token ⇒ PermanentSendError, không gọi fetch', async () => {
    const { connector, calls } = setup();
    await expect(
      connector.sendSenderAction!({ ...account, credentials: {} }, { externalUserId: PSID }, 'typing_on'),
    ).rejects.toBeInstanceOf(PermanentSendError);
    expect(calls).toHaveLength(0);
  });
});
