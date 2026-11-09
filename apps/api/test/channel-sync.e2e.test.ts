// E2E: xếp lịch đồng bộ lịch sử Messenger (queue `channel-sync`). Không có worker: chỉ kiểm job được đẩy.
import {
  CHANNEL_SYNC_JOB_NAME,
  type ChannelSyncJobData,
  channelSyncJobId,
  type MessengerGraphApi,
} from '@dezon/core';
import { channelAccounts, createDb } from '@dezon/db';
import {
  type ChannelAccountDto,
  type ChannelSyncState,
  type LoginResponse,
  QUEUE_NAMES,
} from '@dezon/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { type Queue, Worker } from 'bullmq';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.factory';
import { CHANNEL_SYNC_QUEUE } from '../src/infra/queue/queue.constants';
import { ADMIN, AGENT, startInfra, type TestInfra } from './test-env';

// writeSyncState do core cài song song: thay bằng spy để test chỉ kiểm phần của api.
const { writeSyncState } = vi.hoisted(() => ({
  writeSyncState: vi.fn(async (_db: unknown, _id: string, _patch: Partial<ChannelSyncState>) => undefined),
}));
vi.mock('@dezon/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dezon/core')>()),
  writeSyncState,
}));

const PAGE_ID = '555000111222333';
const PAGE_TOKEN = 'EAAP-sync-page-token-secret';
const fakeGraph: MessengerGraphApi = {
  getPage: async (token) => {
    if (token !== PAGE_TOKEN) throw new Error('Page Access Token không hợp lệ');
    return { id: PAGE_ID, name: 'Trang đồng bộ' };
  },
  subscribeApp: async () => undefined,
  unsubscribeApp: async () => undefined,
};

let infra: TestInfra;
let app: NestFastifyApplication;
let queue: Queue<ChannelSyncJobData>;
let adminToken: string;
let agentToken: string;
let channelId: string;
let zaloChannelId: string;

beforeAll(async () => {
  infra = await startInfra();
  const { db, close } = createDb(infra.databaseUrl, { max: 1 });
  const [zalo] = await db
    .insert(channelAccounts)
    .values({ type: 'zalo_oa', displayName: 'OA thử', externalId: 'oa-1', status: 'connected' })
    .returning({ id: channelAccounts.id });
  zaloChannelId = zalo!.id;
  await close();
  app = await createApp(undefined, { mediaStorage: null, messengerGraph: fakeGraph });
  queue = app.get(CHANNEL_SYNC_QUEUE);
  adminToken = await login(ADMIN.email, ADMIN.password);
  agentToken = await login(AGENT.email, AGENT.password);
});

afterEach(async () => {
  writeSyncState.mockClear();
  await queue.obliterate({ force: true });
});

afterAll(async () => {
  await app?.close();
  await infra?.stop();
});

async function login(email: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return res.json<LoginResponse>().accessToken;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const connect = () =>
  app.inject({
    method: 'POST',
    url: '/channels/messenger',
    headers: bearer(adminToken),
    payload: { pageAccessToken: PAGE_TOKEN },
  });

const sync = (id: string, payload?: unknown, token = adminToken) =>
  app.inject({
    method: 'POST',
    url: `/channels/${id}/sync`,
    headers: bearer(token),
    ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
  });

async function backfillJobs() {
  return queue.getJobs(['waiting', 'delayed', 'active', 'prioritized']);
}

describe('Kết nối Page => tự đồng bộ lịch sử', () => {
  it('POST /channels/messenger đẩy job backfill đúng jobId/data (days = MESSENGER_HISTORY_DAYS)', async () => {
    const res = await connect();
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain(PAGE_TOKEN);
    channelId = res.json<ChannelAccountDto>().id;

    const jobs = await backfillJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.id).toBe(channelSyncJobId(channelId, 'backfill'));
    expect(jobs[0]!.id).toBe(`sync-backfill-${channelId}`);
    expect(jobs[0]!.name).toBe(CHANNEL_SYNC_JOB_NAME);
    expect(jobs[0]!.data).toEqual({ channelAccountId: channelId, mode: 'backfill', days: 30 });
    expect(jobs[0]!.opts).toMatchObject({ removeOnComplete: true, removeOnFail: true });
    expect(writeSyncState).toHaveBeenCalledWith(expect.anything(), channelId, { backfillRunning: true });
  });

  it('kết nối lại khi job còn chờ => không đẩy job thứ hai', async () => {
    expect((await connect()).statusCode).toBe(201);
    expect((await connect()).statusCode).toBe(201);
    expect(await backfillJobs()).toHaveLength(1);
  });

  it('đẩy job lỗi (Redis) => kết nối vẫn 201, ghi sync.lastError', async () => {
    const spy = vi.spyOn(queue, 'add').mockRejectedValueOnce(new Error('Redis mất kết nối'));
    try {
      const res = await connect();
      expect(res.statusCode).toBe(201);
      expect(res.json<ChannelAccountDto>().status).toBe('connected');
    } finally {
      spy.mockRestore();
    }
    expect(writeSyncState).toHaveBeenCalledWith(
      expect.anything(),
      channelId,
      expect.objectContaining({ backfillRunning: false, lastError: expect.any(String) }),
    );
    expect(await backfillJobs()).toHaveLength(0);
  });
});

describe('POST /channels/:id/sync', () => {
  it('agent => 403; chưa đăng nhập => 401; id sai định dạng => 400', async () => {
    expect((await sync(channelId, {}, agentToken)).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/channels/${channelId}/sync` })).statusCode).toBe(401);
    expect((await sync('khong-phai-uuid', {})).statusCode).toBe(400);
    expect(await backfillJobs()).toHaveLength(0);
  });

  it('days ngoài 1..365 hoặc sai kiểu => 400', async () => {
    for (const days of [0, 400, 1.5, '30']) {
      expect((await sync(channelId, { days })).statusCode).toBe(400);
    }
    expect(await backfillJobs()).toHaveLength(0);
  });

  it('không có kênh => 404; kênh không phải Messenger => 422', async () => {
    expect((await sync('00000000-0000-4000-8000-000000000000', {})).statusCode).toBe(404);
    expect((await sync(zaloChannelId, {})).statusCode).toBe(422);
  });

  it('thành công => 202 + DTO, job có days từ body; không có body => days mặc định', async () => {
    const res = await sync(channelId, { days: 7 });
    expect(res.statusCode).toBe(202);
    expect(res.json<ChannelAccountDto>()).toMatchObject({ id: channelId, status: 'connected' });
    expect(res.body).not.toContain(PAGE_TOKEN);
    let jobs = await backfillJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.id).toBe(channelSyncJobId(channelId, 'backfill'));
    expect(jobs[0]!.data).toEqual({ channelAccountId: channelId, mode: 'backfill', days: 7 });
    expect(writeSyncState).toHaveBeenCalledWith(expect.anything(), channelId, { backfillRunning: true });

    await queue.obliterate({ force: true });
    expect((await sync(channelId)).statusCode).toBe(202);
    jobs = await backfillJobs();
    expect(jobs[0]!.data.days).toBe(30);
  });

  it('đang có job đồng bộ lịch sử chờ/chạy => 409', async () => {
    expect((await sync(channelId, { days: 3 })).statusCode).toBe(202);
    const res = await sync(channelId, { days: 3 });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ message: string }>().message).toContain('đang đồng bộ');
    expect(await backfillJobs()).toHaveLength(1);
  });

  it('job cũ đã xong mà còn lưu (removeOnComplete=false) => xóa và đẩy job mới', async () => {
    const jobId = channelSyncJobId(channelId, 'backfill');
    const old = await queue.add(
      CHANNEL_SYNC_JOB_NAME,
      { channelAccountId: channelId, mode: 'backfill' },
      { jobId, removeOnComplete: false },
    );
    const worker = new Worker(QUEUE_NAMES.channelSync, async () => undefined, {
      connection: { url: infra.redisUrl },
    });
    try {
      await vi.waitFor(async () => expect(await old.getState()).toBe('completed'), { timeout: 10_000 });
    } finally {
      await worker.close();
    }
    expect((await sync(channelId, { days: 2 })).statusCode).toBe(202);
    const jobs = await backfillJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data.days).toBe(2);
  });

  it('kênh đã ngắt kết nối => 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/disconnect`,
      headers: bearer(adminToken),
    });
    expect(res.statusCode).toBe(200);
    expect((await sync(channelId, {})).statusCode).toBe(422);
    expect(await backfillJobs()).toHaveLength(0);
  });
});
