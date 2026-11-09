import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { EMBEDDING_DIM } from '@dezon/shared';
import { cosineDistance, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  channelAccounts,
  contactIdentities,
  contacts,
  conversations,
  createDb,
  customerMemories,
  type Db,
  type DbHandle,
  handoffs,
  knowledgeChunks,
  knowledgeDocuments,
  messages,
  runMigrations,
  seedUsers,
  users,
  verifyPassword,
} from '../src';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
let db: Db;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  const url = container.getConnectionUri();
  await runMigrations(url);
  handle = createDb(url, { max: 2 });
  db = handle.db;
});

afterAll(async () => {
  await handle?.close();
  await container?.stop();
});

/** Tạo channel account + contact + identity + conversation tối thiểu. */
async function createConversation(externalUserId: string) {
  const [account] = await db
    .insert(channelAccounts)
    .values({ type: 'messenger', displayName: 'Fanpage Dezon', externalId: `page-${externalUserId}` })
    .returning();
  const [contact] = await db.insert(contacts).values({ displayName: 'Chị Lan' }).returning();
  const [identity] = await db
    .insert(contactIdentities)
    .values({ contactId: contact!.id, channelAccountId: account!.id, externalUserId })
    .returning();
  const [conversation] = await db
    .insert(conversations)
    .values({ contactId: contact!.id, channelAccountId: account!.id, contactIdentityId: identity!.id })
    .returning();
  return { account: account!, contact: contact!, identity: identity!, conversation: conversation! };
}

describe('schema constraints', () => {
  it('unique (channel_account_id, external_message_id) chặn tin trùng webhook', async () => {
    const { account, conversation } = await createConversation('psid-1');
    const base = {
      conversationId: conversation.id,
      channelAccountId: account.id,
      senderType: 'customer' as const,
      text: 'Chào shop',
    };
    await db.insert(messages).values({ ...base, externalMessageId: 'mid.1' });
    await expect(db.insert(messages).values({ ...base, externalMessageId: 'mid.1' })).rejects.toMatchObject({
      cause: { code: '23505' },
    });
    // NULL không bị coi là trùng (tin chưa lên nền tảng).
    await db.insert(messages).values([{ ...base }, { ...base }]);
    // onConflictDoNothing dùng được cho chống trùng.
    const inserted = await db
      .insert(messages)
      .values({ ...base, externalMessageId: 'mid.1' })
      .onConflictDoNothing({ target: [messages.channelAccountId, messages.externalMessageId] })
      .returning();
    expect(inserted).toHaveLength(0);
  });

  it('message phải cùng channel_account với conversation (FK ghép)', async () => {
    const { conversation } = await createConversation('psid-fk-1');
    const { account: otherAccount } = await createConversation('psid-fk-2');
    await expect(
      db.insert(messages).values({
        conversationId: conversation.id,
        channelAccountId: otherAccount.id,
        senderType: 'customer',
        externalMessageId: 'mid.fk',
      }),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('attachments mặc định là [] và updated_at tự cập nhật', async () => {
    const { account, conversation } = await createConversation('psid-2');
    const [msg] = await db
      .insert(messages)
      .values({ conversationId: conversation.id, channelAccountId: account.id, senderType: 'customer' })
      .returning();
    expect(msg!.attachments).toEqual([]);
    expect(msg!.status).toBe('received');
    expect(conversation.aiMode).toBe('off');
    expect(account.defaultAiMode).toBe('off');

    // $onUpdate dùng đồng hồ của client; so với mốc client (đồng hồ container Docker có thể lệch).
    const before = Date.now();
    const [updated] = await db
      .update(messages)
      .set({ status: 'seen' })
      .where(eq(messages.id, msg!.id))
      .returning();
    expect(updated!.status).toBe('seen');
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('customer_memories.summary tối đa 1200 ký tự', async () => {
    const [contact] = await db.insert(contacts).values({ displayName: 'Anh Minh' }).returning();
    await expect(
      db.insert(customerMemories).values({ contactId: contact!.id, summary: 'a'.repeat(1201) }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    await db.insert(customerMemories).values({ contactId: contact!.id, summary: 'ả'.repeat(1200) });
  });

  it('zalo_personal bắt buộc owner_user_id', async () => {
    await expect(
      db
        .insert(channelAccounts)
        .values({ type: 'zalo_personal', displayName: 'Zalo – Sale', externalId: 'uid-1' }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('handoff do AI tạo không được có created_by_user_id', async () => {
    const { conversation } = await createConversation('psid-3');
    await db.insert(handoffs).values({
      conversationId: conversation.id,
      reasonCode: 'discount',
      summary: 'Khách hỏi giảm giá',
      createdBy: 'ai',
    });
    const [admin] = await db
      .insert(users)
      .values({ email: 'handoff-admin@dezon.vn', passwordHash: 'x', name: 'A', role: 'admin' })
      .returning();
    await expect(
      db.insert(handoffs).values({
        conversationId: conversation.id,
        reasonCode: 'other',
        summary: 'x',
        createdBy: 'ai',
        createdByUserId: admin!.id,
      }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('xóa contact xóa luôn danh tính, hội thoại, tin nhắn, hồ sơ (mục 11)', async () => {
    const { account, contact, conversation } = await createConversation('psid-4');
    await db
      .insert(messages)
      .values({ conversationId: conversation.id, channelAccountId: account.id, senderType: 'customer' });
    await db.insert(customerMemories).values({ contactId: contact.id, summary: 'Khách cũ' });

    await db.delete(contacts).where(eq(contacts.id, contact.id));

    const count = async (table: string, col: string, id: string) =>
      (
        await db.execute<{ n: number }>(
          sql`select count(*)::int as n from ${sql.identifier(table)} where ${sql.identifier(col)} = ${id}`,
        )
      ).rows[0]?.n;
    expect(await count('contact_identities', 'contact_id', contact.id)).toBe(0);
    expect(await count('conversations', 'contact_id', contact.id)).toBe(0);
    expect(await count('messages', 'conversation_id', conversation.id)).toBe(0);
    expect(await count('customer_memories', 'contact_id', contact.id)).toBe(0);
    // Kênh vẫn còn.
    expect(await count('channel_accounts', 'id', account.id)).toBe(1);
  });

  it('lưu và tìm kiếm cosine trên knowledge_chunks', async () => {
    const [doc] = await db
      .insert(knowledgeDocuments)
      .values({ title: 'Bảng giá', sourceType: 'manual' })
      .returning();
    const vec = (hot: number) => Array.from({ length: EMBEDDING_DIM }, (_, i) => (i === hot ? 1 : 0));
    await db.insert(knowledgeChunks).values([
      { documentId: doc!.id, chunkIndex: 0, content: 'logo', embedding: vec(0) },
      { documentId: doc!.id, chunkIndex: 1, content: 'banner', embedding: vec(1) },
    ]);
    const distance = cosineDistance(knowledgeChunks.embedding, vec(1));
    const [best] = await db
      .select({ content: knowledgeChunks.content, distance })
      .from(knowledgeChunks)
      .orderBy(distance)
      .limit(1);
    expect(best?.content).toBe('banner');
  });
});

describe('seedUsers', () => {
  const input = {
    admin: { email: '  Admin@Dezon.VN ', password: 'Admin@2026', name: 'Admin' },
    agent: { email: 'sale@dezon.vn', password: 'Sale@2026' },
  };

  it('tạo user với email chữ thường và hash argon2id kiểm tra được', async () => {
    const seeded = await seedUsers(db, input);
    expect(seeded.map((u) => [u.email, u.role, u.created])).toEqual([
      ['admin@dezon.vn', 'admin', true],
      ['sale@dezon.vn', 'agent', true],
    ]);
    const [admin] = await db.select().from(users).where(eq(users.email, 'admin@dezon.vn'));
    expect(admin!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(admin!.passwordHash, 'Admin@2026')).toBe(true);
    expect(await verifyPassword(admin!.passwordHash, 'sai-mat-khau')).toBe(false);
  });

  it('idempotent: chạy lại không tạo trùng và không đổi mật khẩu', async () => {
    const [before] = await db.select().from(users).where(eq(users.email, 'admin@dezon.vn'));
    const seeded = await seedUsers(db, { admin: { ...input.admin, password: 'Khac@2026' } });
    expect(seeded[0]).toMatchObject({ id: before!.id, created: false });
    const rows = await db.select().from(users).where(eq(users.email, 'admin@dezon.vn'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.passwordHash).toBe(before!.passwordHash);
  });

  it('resetPasswords ghi đè mật khẩu', async () => {
    await seedUsers(db, { admin: { ...input.admin, password: 'Moi@20266' } }, { resetPasswords: true });
    const [admin] = await db.select().from(users).where(eq(users.email, 'admin@dezon.vn'));
    expect(await verifyPassword(admin!.passwordHash, 'Moi@20266')).toBe(true);
  });

  it('từ chối mật khẩu quá ngắn', async () => {
    await expect(seedUsers(db, { admin: { email: 'x@dezon.vn', password: 'short' } })).rejects.toThrow(
      /ít nhất 8/,
    );
  });

  it('CHECK chặn email viết hoa khi chèn trực tiếp', async () => {
    await expect(
      db.insert(users).values({ email: 'Upper@dezon.vn', passwordHash: 'x', name: 'U' }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});
