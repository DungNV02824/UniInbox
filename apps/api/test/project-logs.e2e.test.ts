// E2E "Nhật ký công trình": GET /conversations/:id kèm projectLogs; DELETE /conversations/:id/project-logs/:logId
// (401 / 400 / 403 / 404 / 200 + nhật ký còn lại, phát conversation.updated).
import { recordProjectLogs } from '@dezon/core';
import { createDb, type Db } from '@dezon/db';
import {
  type ConversationDetail,
  type ConversationUpdatedPayload,
  DEFAULT_PROJECT_LOG_CONFIG,
  type LoginResponse,
  type ProjectLogDto,
  REALTIME_EVENTS,
} from '@dezon/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.factory';
import { RealtimeService } from '../src/modules/realtime/realtime.service';
import { type InboxSeed, seedInbox } from './inbox-seed';
import { ADMIN, AGENT, startInfra, type TestInfra } from './test-env';

let infra: TestInfra;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;
let seed: InboxSeed;
let realtime: RealtimeService;
let adminToken: string;
let agentToken: string;

beforeAll(async () => {
  infra = await startInfra();
  seed = await seedInbox(infra.databaseUrl);
  ({ db, close: closeDb } = createDb(infra.databaseUrl, { max: 2 }));
  app = await createApp(undefined, { mediaStorage: null, llm: null, geminiModels: null });
  realtime = app.get(RealtimeService);
  adminToken = await login(ADMIN.email, ADMIN.password);
  agentToken = await login(AGENT.email, AGENT.password);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  await infra?.stop();
});

async function login(email: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
  expect(res.statusCode).toBe(200);
  return res.json<LoginResponse>().accessToken;
}

const call = (token: string | null, method: 'GET' | 'DELETE', url: string) =>
  app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {} });

async function addLog(conversationId: string, diaChi: string, now = new Date()): Promise<string> {
  const [id] = await recordProjectLogs(db, {
    conversationId,
    chatbotId: null,
    aiRunId: null,
    config: { ...DEFAULT_PROJECT_LOG_CONFIG, enabled: true },
    entries: [{ dia_chi: diaChi, nha_thau: 'Công ty CP Xây dựng TVL' }],
    customerMessageIds: [],
    botMessageIds: [],
    now,
  });
  return id!;
}

const MISSING = '00000000-0000-4000-8000-000000000000';

describe('Nhật ký công trình', () => {
  it('GET /conversations/:id trả projectLogs mới nhất trước', async () => {
    const older = await addLog(seed.unassignedConversationId, 'CT cũ', new Date(Date.now() - 60_000));
    const newer = await addLog(seed.unassignedConversationId, 'CT mới');
    const res = await call(agentToken, 'GET', `/conversations/${seed.unassignedConversationId}`);
    expect(res.statusCode).toBe(200);
    const detail = res.json<ConversationDetail>();
    expect(detail.projectLogs.map((l) => l.id)).toEqual([newer, older]);
    expect(detail.projectLogs[0]).toMatchObject({
      conversationId: seed.unassignedConversationId,
      fields: [
        { key: 'dia_chi', label: 'Địa chỉ công trình', value: 'CT mới' },
        { key: 'nha_thau', label: 'Nhà thầu', value: 'Công ty CP Xây dựng TVL' },
      ],
      messageIds: [],
      anchorMessageId: null,
    });
  });

  it('DELETE: 401 khi chưa đăng nhập, 400 khi mã sai, 403 khi không xem được hội thoại, 404 khi không có dòng', async () => {
    const logId = await addLog(seed.adminConversationId, 'CT admin');
    const url = `/conversations/${seed.adminConversationId}/project-logs/${logId}`;
    expect((await call(null, 'DELETE', url)).statusCode).toBe(401);
    expect(
      (await call(adminToken, 'DELETE', `/conversations/${seed.adminConversationId}/project-logs/abc`))
        .statusCode,
    ).toBe(400);
    expect((await call(adminToken, 'DELETE', `/conversations/abc/project-logs/${logId}`)).statusCode).toBe(
      400,
    );
    expect((await call(agentToken, 'DELETE', url)).statusCode).toBe(403);
    expect(
      (await call(adminToken, 'DELETE', `/conversations/${seed.adminConversationId}/project-logs/${MISSING}`))
        .statusCode,
    ).toBe(404);
    // Dòng của hội thoại khác ⇒ 404.
    expect(
      (await call(adminToken, 'DELETE', `/conversations/${seed.agentConversationId}/project-logs/${logId}`))
        .statusCode,
    ).toBe(404);
    expect(
      (await call(adminToken, 'DELETE', `/conversations/${MISSING}/project-logs/${logId}`)).statusCode,
    ).toBe(404);
  });

  it('DELETE: 200 + nhật ký còn lại, phát conversation.updated; xóa lại ⇒ 404', async () => {
    const keep = await addLog(seed.agentConversationId, 'Giữ', new Date(Date.now() - 60_000));
    const drop = await addLog(seed.agentConversationId, 'Xóa');
    const emit = vi.spyOn(realtime, 'emit');
    const url = `/conversations/${seed.agentConversationId}/project-logs/${drop}`;
    const res = await call(agentToken, 'DELETE', url);
    expect(res.statusCode).toBe(200);
    expect(res.json<ProjectLogDto[]>().map((l) => l.id)).toEqual([keep]);
    const updated = emit.mock.calls.filter(([, event]) => event === REALTIME_EVENTS.conversationUpdated);
    expect(updated).toHaveLength(1);
    expect((updated[0]![2] as ConversationUpdatedPayload).conversation.id).toBe(seed.agentConversationId);

    expect((await call(agentToken, 'DELETE', url)).statusCode).toBe(404);
    const detail = (
      await call(adminToken, 'GET', `/conversations/${seed.agentConversationId}`)
    ).json<ConversationDetail>();
    expect(detail.projectLogs.map((l) => l.id)).toEqual([keep]);
  });
});
