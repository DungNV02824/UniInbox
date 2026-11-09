// E2E: kết nối Fanpage bằng Facebook Login. Graph API giả bằng fetch tiêm vào (không gọi Meta thật).
import { createDb, hashPassword, users } from '@dezon/db';
import {
  FACEBOOK_LOGIN_SCOPES,
  channelSyncJobId,
  createMessengerLoginApi,
  type MessengerGraphApi,
} from '@dezon/core';
import type {
  ChannelAccountDto,
  ConnectFacebookPagesResult,
  FacebookLoginSessionDto,
  FacebookLoginStartResponse,
  LoginResponse,
} from '@dezon/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { loadAppConfig } from '../src/config';
import { CHANNEL_SYNC_QUEUE } from '../src/infra/queue/queue.constants';
import { ADMIN, AGENT, META, startInfra, type TestInfra } from './test-env';

const ADMIN2 = { email: 'admin2@test.dezon.vn', password: 'Admin2@12345', name: 'Admin Hai' };
const CODE = 'AQD-fake-code-0123456789';
const SHORT = 'EAAU-short-user-token-secret';
const LONG = 'EAAU-long-user-token-secret';
/** Page token giả theo page id. */
const PAGE_TOKENS: Record<string, string> = {
  '700001': 'EAAP-page-token-700001-secret',
  '700002': 'EAAP-page-token-700002-secret',
  '700003': 'EAAP-page-token-700003-secret',
};
const SECRETS = [CODE, SHORT, LONG, ...Object.values(PAGE_TOKENS), META.appSecret];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Graph API giả cho luồng OAuth. */
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const q = url.searchParams;
  const auth = new Headers(init?.headers).get('authorization');
  if (url.pathname.endsWith('/oauth/access_token')) {
    if (q.get('client_secret') !== META.appSecret) return json({ error: { code: 1 } }, 400);
    if (q.get('code')) {
      return q.get('code') === CODE
        ? json({ access_token: SHORT, token_type: 'bearer', expires_in: 3600 })
        : json({ error: { message: 'Invalid verification code', code: 100 } }, 400);
    }
    if (q.get('fb_exchange_token') === SHORT) return json({ access_token: LONG, expires_in: 5_184_000 });
    return json({ error: { code: 190 } }, 400);
  }
  if (auth !== `Bearer ${LONG}` || !q.get('appsecret_proof')) return json({ error: { code: 190 } }, 400);
  if (url.pathname.endsWith('/me/accounts')) {
    return json({
      data: [
        {
          id: '700001',
          name: 'Demo app',
          access_token: PAGE_TOKENS['700001'],
          tasks: ['ADVERTISE', 'ANALYZE', 'CREATE_CONTENT', 'MESSAGING', 'MODERATE', 'MANAGE'],
          picture: { data: { url: 'https://cdn.test/700001.jpg' } },
        },
        { id: '700002', name: 'Chỉ xem số liệu', access_token: PAGE_TOKENS['700002'], tasks: ['ANALYZE'] },
        {
          id: '700003',
          name: 'Showroom',
          access_token: PAGE_TOKENS['700003'],
          tasks: ['MESSAGING', 'MODERATE'],
        },
      ],
    });
  }
  if (url.pathname.endsWith('/me')) return json({ id: '4242', name: 'Đúng Văn' });
  return json({ error: { code: 100 } }, 404);
}) as typeof fetch;

const pageNames: Record<string, string> = { '700001': 'Demo app', '700002': 'Chỉ xem', '700003': 'Showroom' };
const fakeGraph: MessengerGraphApi = {
  getPage: async (token) => {
    const id = Object.keys(PAGE_TOKENS).find((k) => PAGE_TOKENS[k] === token);
    if (!id) throw new Error('Page Access Token không hợp lệ');
    return { id, name: pageNames[id]! };
  },
  subscribeApp: async (pageId) => {
    if (pageId === '700003') throw new Error('token thiếu quyền (mã 200)');
  },
  unsubscribeApp: async () => undefined,
};

let infra: TestInfra;
let app: NestFastifyApplication;
let adminToken: string;
let admin2Token: string;
let agentToken: string;

beforeAll(async () => {
  infra = await startInfra();
  const { db, close } = createDb(infra.databaseUrl, { max: 1 });
  await db.insert(users).values({
    email: ADMIN2.email,
    name: ADMIN2.name,
    passwordHash: await hashPassword(ADMIN2.password),
    role: 'admin',
  });
  await close();
  const config = loadAppConfig();
  const login = createMessengerLoginApi({
    appId: META.appId,
    appSecret: META.appSecret,
    graphBaseUrl: 'https://graph.test',
    graphVersion: config.META_GRAPH_VERSION ?? 'v26.0',
    fetch: fakeFetch,
  });
  app = await createApp(config, { mediaStorage: null, messengerGraph: fakeGraph, messengerLogin: login });
  adminToken = await signIn(ADMIN.email, ADMIN.password);
  admin2Token = await signIn(ADMIN2.email, ADMIN2.password);
  agentToken = await signIn(AGENT.email, AGENT.password);
});

afterAll(async () => {
  await app?.close();
  await infra?.stop();
});

async function signIn(email: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return res.json<LoginResponse>().accessToken;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function start(token = adminToken): Promise<URL> {
  const res = await app.inject({
    method: 'POST',
    url: '/channels/messenger/oauth/start',
    headers: bearer(token),
  });
  expect(res.statusCode).toBe(200);
  return new URL(res.json<FacebookLoginStartResponse>().authorizeUrl);
}

async function callback(query: Record<string, string>): Promise<URL> {
  const res = await app.inject({
    method: 'GET',
    url: `/channels/messenger/oauth/callback?${new URLSearchParams(query).toString()}`,
  });
  expect(res.statusCode).toBe(302);
  expect(res.headers['cache-control']).toBe('no-store');
  const location = new URL(String(res.headers.location));
  expect(location.origin + location.pathname).toBe('http://localhost:3100/admin/channels');
  for (const s of SECRETS) expect(location.toString()).not.toContain(s);
  return location;
}

const expectNoSecrets = (body: string) => {
  for (const s of SECRETS) expect(body).not.toContain(s);
};

describe('Facebook Login — start', () => {
  it('admin nhận authorizeUrl có state ngẫu nhiên + redirect_uri callback; agent bị 403', async () => {
    const url = await start();
    expect(url.origin).toBe('https://www.facebook.com');
    expect(url.pathname).toMatch(/^\/v\d+\.\d+\/dialog\/oauth$/);
    expect(url.searchParams.get('client_id')).toBe(META.appId);
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:4000/channels/messenger/oauth/callback',
    );
    expect(url.searchParams.get('scope')).toBe(FACEBOOK_LOGIN_SCOPES.join(','));
    expect(url.searchParams.get('scope')).toContain('pages_messaging');
    expect(url.searchParams.get('scope')).toContain('business_management');
    const state = url.searchParams.get('state')!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await start()).searchParams.get('state')).not.toBe(state);

    const forbidden = await app.inject({
      method: 'POST',
      url: '/channels/messenger/oauth/start',
      headers: bearer(agentToken),
    });
    expect(forbidden.statusCode).toBe(403);
    const anonymous = await app.inject({ method: 'POST', url: '/channels/messenger/oauth/start' });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('Facebook Login — callback', () => {
  it('state sai/thiếu => fbError=state', async () => {
    expect((await callback({ code: CODE, state: 'x'.repeat(43) })).searchParams.get('fbError')).toBe('state');
    expect((await callback({ code: CODE })).searchParams.get('fbError')).toBe('state');
  });

  it('người dùng từ chối => fbError=denied; state đã dùng không dùng lại được', async () => {
    const state = (await start()).searchParams.get('state')!;
    const denied = await callback({ state, error: 'access_denied', error_reason: 'user_denied' });
    expect(denied.searchParams.get('fbError')).toBe('denied');
    expect((await callback({ state, code: CODE })).searchParams.get('fbError')).toBe('state');
  });

  it('code sai => fbError=exchange', async () => {
    const state = (await start()).searchParams.get('state')!;
    expect((await callback({ state, code: 'AQD-sai' })).searchParams.get('fbError')).toBe('exchange');
  });
});

describe('Facebook Login — phiên chọn Trang và kết nối', () => {
  let sessionId: string;

  it('code đúng => redirect ?fbSession=...; state chỉ dùng một lần', async () => {
    const state = (await start()).searchParams.get('state')!;
    const location = await callback({ state, code: CODE });
    expect(location.searchParams.has('fbError')).toBe(false);
    sessionId = location.searchParams.get('fbSession')!;
    expect(sessionId).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect((await callback({ state, code: CODE })).searchParams.get('fbError')).toBe('state');
  });

  it('chỉ admin tạo phiên đọc được; DTO không chứa token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/channels/messenger/oauth/sessions/${sessionId}`,
      headers: bearer(adminToken),
    });
    expect(res.statusCode).toBe(200);
    expectNoSecrets(res.body);
    const dto = res.json<FacebookLoginSessionDto>();
    expect(dto.fbUser).toEqual({ id: '4242', name: 'Đúng Văn' });
    expect(dto.pages.map((p) => [p.id, p.canMessage, p.alreadyConnected])).toEqual([
      ['700001', true, false],
      ['700002', false, false],
      ['700003', true, false],
    ]);
    expect(dto.pages[0]!.pictureUrl).toBe('https://cdn.test/700001.jpg');
    expect(dto.pages[1]!.cannotMessageReason).toContain('MESSAGING');

    const other = await app.inject({
      method: 'GET',
      url: `/channels/messenger/oauth/sessions/${sessionId}`,
      headers: bearer(admin2Token),
    });
    expect(other.statusCode).toBe(404);
    const agent = await app.inject({
      method: 'GET',
      url: `/channels/messenger/oauth/sessions/${sessionId}`,
      headers: bearer(agentToken),
    });
    expect(agent.statusCode).toBe(403);
    const otherConnect = await app.inject({
      method: 'POST',
      url: `/channels/messenger/oauth/sessions/${sessionId}/connect`,
      headers: bearer(admin2Token),
      payload: { pageIds: ['700001'] },
    });
    expect(otherConnect.statusCode).toBe(404);
  });

  it('connect: validate body; kết quả từng Trang, lỗi không chặn Trang khác; phiên bị xóa', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: `/channels/messenger/oauth/sessions/${sessionId}/connect`,
      headers: bearer(adminToken),
      payload: { pageIds: [] },
    });
    expect(bad.statusCode).toBe(400);

    const res = await app.inject({
      method: 'POST',
      url: `/channels/messenger/oauth/sessions/${sessionId}/connect`,
      headers: bearer(adminToken),
      payload: { pageIds: ['700001', '700002', '700003', '799999'] },
    });
    expect(res.statusCode).toBe(200);
    expectNoSecrets(res.body);
    const { results } = res.json<ConnectFacebookPagesResult>();
    expect(results.map((r) => [r.pageId, r.ok])).toEqual([
      ['700001', true],
      ['700002', false],
      ['700003', false],
      ['799999', false],
    ]);
    expect(results[0]!.channel).toMatchObject({
      externalId: '700001',
      displayName: 'Demo app',
      status: 'connected',
      pictureUrl: 'https://cdn.test/700001.jpg',
      connectedBy: { provider: 'facebook_login', fbUserId: '4242', fbUserName: 'Đúng Văn' },
    });
    expect(results[2]!.error).toContain('webhook');

    // Trang kết nối thành công => tự đẩy job đồng bộ lịch sử (chỉ Trang đó).
    const syncJobs = await app.get<Queue>(CHANNEL_SYNC_QUEUE).getJobs(['waiting']);
    expect(syncJobs.map((j) => [j.id, j.data])).toEqual([
      [
        channelSyncJobId(results[0]!.channel!.id, 'backfill'),
        { channelAccountId: results[0]!.channel!.id, mode: 'backfill', days: 30 },
      ],
    ]);

    const again = await app.inject({
      method: 'GET',
      url: `/channels/messenger/oauth/sessions/${sessionId}`,
      headers: bearer(adminToken),
    });
    expect(again.statusCode).toBe(404);

    const list = await app.inject({ method: 'GET', url: '/channels', headers: bearer(agentToken) });
    expectNoSecrets(list.body);
    const channel = list.json<ChannelAccountDto[]>().find((c) => c.externalId === '700001');
    expect(channel?.connectedBy).toEqual({
      provider: 'facebook_login',
      fbUserId: '4242',
      fbUserName: 'Đúng Văn',
    });
  });

  it('phiên mới: Trang đã kết nối => alreadyConnected + channelAccountId', async () => {
    const state = (await start()).searchParams.get('state')!;
    const id = (await callback({ state, code: CODE })).searchParams.get('fbSession')!;
    const res = await app.inject({
      method: 'GET',
      url: `/channels/messenger/oauth/sessions/${id}`,
      headers: bearer(adminToken),
    });
    const page = res.json<FacebookLoginSessionDto>().pages.find((p) => p.id === '700001')!;
    expect(page.alreadyConnected).toBe(true);
    expect(page.channelAccountId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('kết nối bằng token dán => connectedBy.provider = token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/channels/messenger',
      headers: bearer(adminToken),
      payload: { pageAccessToken: PAGE_TOKENS['700001'] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<ChannelAccountDto>().connectedBy).toEqual({ provider: 'token' });
  });
});

describe('Facebook Login — thiếu cấu hình Meta', () => {
  it('start => 503', async () => {
    const bare = await createApp({ ...loadAppConfig(), META_APP_ID: undefined }, { mediaStorage: null });
    try {
      const login = await bare.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: ADMIN.email, password: ADMIN.password },
      });
      const token = login.json<LoginResponse>().accessToken;
      const res = await bare.inject({
        method: 'POST',
        url: '/channels/messenger/oauth/start',
        headers: bearer(token),
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await bare.close();
    }
  });
});
