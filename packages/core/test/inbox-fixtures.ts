// Dữ liệu mẫu cho test tích hợp hộp thư/kênh: Postgres thật (Testcontainers) + insert trực tiếp.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  channelAccounts,
  contactIdentities,
  contacts,
  conversations,
  createDb,
  messages,
  runMigrations,
  seedUsers,
  users,
  type ChannelAccount,
  type Conversation,
  type Db,
  type DbHandle,
  type NewChannelAccount,
  type NewConversation,
  type NewMessage,
} from '@dezon/db';
import type { InboxContext, Viewer } from '../src/inbox/types';

export interface TestDb {
  container: StartedPostgreSqlContainer;
  handle: DbHandle;
  db: Db;
  admin: Viewer;
  agent: Viewer;
  agent2: Viewer;
  inactiveUserId: string;
  stop(): Promise<void>;
}

export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  const url = container.getConnectionUri();
  await runMigrations(url);
  const handle = createDb(url, { max: 4 });
  const db = handle.db;
  const seeded = await seedUsers(db, {
    admin: { email: 'admin@test.vn', password: 'matkhau-admin', name: 'Quản trị' },
    agent: { email: 'huong@test.vn', password: 'matkhau-agent', name: 'Hương' },
  });
  const [agent2, inactive] = await db
    .insert(users)
    .values([
      { email: 'lan@test.vn', passwordHash: 'x', name: 'Lan', role: 'agent' },
      { email: 'nghi@test.vn', passwordHash: 'x', name: 'Đã nghỉ', role: 'agent', isActive: false },
    ])
    .returning();
  const byRole = (role: 'admin' | 'agent') => seeded.find((u) => u.role === role)!;
  return {
    container,
    handle,
    db,
    admin: { id: byRole('admin').id, role: 'admin' },
    agent: { id: byRole('agent').id, role: 'agent' },
    agent2: { id: agent2!.id, role: 'agent' },
    inactiveUserId: inactive!.id,
    async stop() {
      await handle.close();
      await container.stop();
    },
  };
}

export function makeCtx(overrides: Partial<InboxContext> = {}): InboxContext {
  return {
    signUrl: async (key) => `https://signed.test/${key}`,
    now: () => new Date(),
    policy: { metaHumanAgentEnabled: false, zaloOaAllowPaidBot: false },
    ...overrides,
  };
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;

export async function createChannel(
  db: Db,
  values: Partial<NewChannelAccount> = {},
): Promise<ChannelAccount> {
  const [row] = await db
    .insert(channelAccounts)
    .values({
      type: 'messenger',
      displayName: 'Fanpage Dezon',
      externalId: nextId('page'),
      status: 'connected',
      credentials: { enc: 'fake' },
      ...values,
    })
    .returning();
  return row!;
}

export interface CreateConversationInput extends Partial<NewConversation> {
  channel: ChannelAccount;
  contactName?: string;
  avatarKey?: string | null;
}

export async function createConversation(db: Db, input: CreateConversationInput): Promise<Conversation> {
  const { channel, contactName, avatarKey, ...rest } = input;
  const [contact] = await db
    .insert(contacts)
    .values({ displayName: contactName ?? 'Khách', avatarUrl: avatarKey ?? null })
    .returning();
  const [identity] = await db
    .insert(contactIdentities)
    .values({ contactId: contact!.id, channelAccountId: channel.id, externalUserId: nextId('psid') })
    .returning();
  const [conv] = await db
    .insert(conversations)
    .values({
      contactId: contact!.id,
      channelAccountId: channel.id,
      contactIdentityId: identity!.id,
      ...rest,
    })
    .returning();
  return conv!;
}

export async function addMessage(
  db: Db,
  conv: Conversation,
  values: Partial<NewMessage> & { sentAt: Date },
): Promise<string> {
  const [row] = await db
    .insert(messages)
    .values({
      conversationId: conv.id,
      channelAccountId: conv.channelAccountId,
      senderType: 'customer',
      ...values,
    })
    .returning({ id: messages.id });
  return row!.id;
}

export const HOUR = 60 * 60 * 1000;
export const ago = (ms: number) => new Date(Date.now() - ms);
