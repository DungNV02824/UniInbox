// "Nhóm Lark theo chatbot": CRUD nhóm + chọn nơi gửi (getLarkTargets) + mọi chỗ gửi Lark của worker (chuyển người,
// nhắc lại, từ khóa báo nhân viên). Postgres thật (Testcontainers), Redis/scheduler/LLM/Lark giả.
import {
  auditLogs,
  chatbots,
  handoffs,
  larkGroupChatbots,
  larkGroups,
  type ChannelAccount,
  type Chatbot,
} from '@dezon/db';
import { LARK_GROUP_LIMITS } from '@dezon/shared';
import { eq, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  conversationChatbotId,
  createLarkGroup,
  deleteLarkGroup,
  getLarkGroupConfig,
  getLarkTargets,
  LARK_GROUP_LIMIT_REACHED,
  LARK_GROUP_UNKNOWN_CHATBOT,
  listLarkGroups,
  notifyConversationLark,
  updateLarkGroup,
} from '../src/ai/lark-groups';
import { buildHandoffLarkCard } from '../src/ai/lark';
import { escalateConversation, processHandoffReminderJob } from '../src/ai/runtime';
import { notifyStaffKeyword } from '../src/ai/notify-staff';
import { deleteChatbot } from '../src/ai/service';
import type { CredentialsCipher } from '../src/channels/service';
import { InboxNotFoundError, InboxValidationError } from '../src/inbox/errors';
import { createAiKit, LARK_URL, silentLogger, type AiTestKit } from './helpers/ai-fakes';
import { createChannel, createConversation, makeCtx, startTestDb, type TestDb } from './inbox-fixtures';

let t: TestDb;
let channel: ChannelAccount;
let kit: AiTestKit;
const ctx = makeCtx();

/** Cipher giả có tiền tố (để thấy secret không lưu dạng rõ); chuỗi không có tiền tố ⇒ giải mã lỗi. */
const cipher: CredentialsCipher = {
  encryptJson: (v) => `fake:${Buffer.from(JSON.stringify(v)).toString('base64')}`,
  decryptJson: <T>(p: string) => {
    if (!p.startsWith('fake:')) throw new Error('sai khóa');
    return JSON.parse(Buffer.from(p.slice(5), 'base64').toString()) as T;
  },
};

const HOOK_A = 'https://open.larksuite.com/open-apis/bot/v2/hook/nhom-a';
const HOOK_B = 'https://open.larksuite.com/open-apis/bot/v2/hook/nhom-b';
const HOOK_C = 'https://open.larksuite.com/open-apis/bot/v2/hook/nhom-c';

async function createBot(
  name?: string,
  values: Partial<typeof chatbots.$inferInsert> = {},
): Promise<Chatbot> {
  const [bot] = await t.db
    .insert(chatbots)
    .values({ name: name ?? `Bot ${Math.random().toString(36).slice(2, 8)}`, ...values })
    .returning();
  return bot!;
}

async function clearGroups() {
  await t.db.delete(larkGroups);
}

beforeAll(async () => {
  t = await startTestDb();
  channel = await createChannel(t.db, { displayName: 'Fanpage Nội Thất' });
});

afterAll(async () => {
  await t?.stop();
});

beforeEach(async () => {
  kit = createAiKit(ctx);
  kit.deps.cipher = cipher;
  await clearGroups();
});

describe('CRUD nhóm Lark', () => {
  it('tạo / liệt kê (theo tên) / sửa / xóa; secret mã hóa, không bao giờ trả ra; audit không có secret', async () => {
    const botB = await createBot('Bot Bình');
    const botA = await createBot('Bot An');
    const g = await createLarkGroup(
      t.db,
      t.admin.id,
      {
        name: '  Nhóm thợ  ',
        webhookUrl: HOOK_A,
        secret: ' bi-mat-nhom ',
        chatbotIds: [botB.id, botA.id, botB.id],
      },
      cipher,
    );
    expect(g).toMatchObject({
      name: 'Nhóm thợ',
      webhookUrl: HOOK_A,
      hasSecret: true,
      chatbotIds: [botA.id, botB.id],
    });
    expect(JSON.stringify(g)).not.toContain('bi-mat');
    const [row] = await t.db.select().from(larkGroups).where(eq(larkGroups.id, g.id));
    expect(row!.secretEnc).toMatch(/^fake:/);
    expect(row!.secretEnc).not.toContain('bi-mat');
    expect(await getLarkGroupConfig(t.db, cipher, g.id)).toEqual({
      webhookUrl: HOOK_A,
      secret: 'bi-mat-nhom',
    });

    const g2 = await createLarkGroup(t.db, t.admin.id, { name: 'An toàn', webhookUrl: HOOK_B }, cipher);
    expect(g2).toMatchObject({ hasSecret: false, chatbotIds: [] });
    expect((await listLarkGroups(t.db)).map((x) => x.name)).toEqual(['An toàn', 'Nhóm thợ']);

    // secret bỏ qua ⇒ giữ; chatbotIds ⇒ thay toàn bộ.
    const u1 = await updateLarkGroup(
      t.db,
      t.admin.id,
      g.id,
      { name: 'Nhóm thợ 2', chatbotIds: [botA.id] },
      cipher,
    );
    expect(u1).toMatchObject({
      name: 'Nhóm thợ 2',
      webhookUrl: HOOK_A,
      hasSecret: true,
      chatbotIds: [botA.id],
    });
    // không có chatbotIds ⇒ giữ danh sách bot.
    const u2 = await updateLarkGroup(t.db, t.admin.id, g.id, { webhookUrl: HOOK_C, secret: 'moi' }, cipher);
    expect(u2).toMatchObject({ webhookUrl: HOOK_C, hasSecret: true, chatbotIds: [botA.id] });
    expect((await getLarkGroupConfig(t.db, cipher, g.id)).secret).toBe('moi');
    // '' ⇒ xóa secret; [] ⇒ gỡ hết bot.
    const u3 = await updateLarkGroup(t.db, t.admin.id, g.id, { secret: '', chatbotIds: [] }, cipher);
    expect(u3).toMatchObject({ hasSecret: false, chatbotIds: [] });
    expect(await getLarkGroupConfig(t.db, cipher, g.id)).toEqual({ webhookUrl: HOOK_C, secret: null });
    const u4 = await updateLarkGroup(t.db, t.admin.id, g.id, { secret: 'lai' }, cipher);
    expect((await updateLarkGroup(t.db, t.admin.id, g.id, { secret: null }, cipher)).hasSecret).toBe(false);
    expect(u4.hasSecret).toBe(true);

    await deleteLarkGroup(t.db, t.admin.id, g.id);
    expect((await listLarkGroups(t.db)).map((x) => x.id)).toEqual([g2.id]);
    expect(
      await t.db.select().from(larkGroupChatbots).where(eq(larkGroupChatbots.larkGroupId, g.id)),
    ).toEqual([]);

    const audits = await t.db.select().from(auditLogs).where(like(auditLogs.action, 'settings.lark_group.%'));
    expect(audits.map((a) => a.action).sort()).toEqual([
      'settings.lark_group.create',
      'settings.lark_group.create',
      'settings.lark_group.delete',
      'settings.lark_group.update',
      'settings.lark_group.update',
      'settings.lark_group.update',
      'settings.lark_group.update',
      'settings.lark_group.update',
    ]);
    const auditText = JSON.stringify(audits.map((a) => a.data));
    expect(auditText).not.toContain('bi-mat');
    expect(auditText).not.toContain('moi');
    expect(auditText).not.toContain('nhom-a');
    expect(audits.map((a) => a.data)).toContainEqual(
      expect.objectContaining({ fields: ['name', 'chatbotIds'], hasSecret: true, chatbotIds: [botA.id] }),
    );
  });

  it('không có nhóm ⇒ 404; chatbot không tồn tại ⇒ 400; quá số nhóm ⇒ 400', async () => {
    const missing = '7f1c2a9e-3b4d-4c5e-8f60-112233445566';
    await expect(updateLarkGroup(t.db, t.admin.id, missing, { name: 'X' }, cipher)).rejects.toBeInstanceOf(
      InboxNotFoundError,
    );
    await expect(deleteLarkGroup(t.db, t.admin.id, missing)).rejects.toBeInstanceOf(InboxNotFoundError);
    await expect(getLarkGroupConfig(t.db, cipher, missing)).rejects.toBeInstanceOf(InboxNotFoundError);

    await expect(
      createLarkGroup(t.db, t.admin.id, { name: 'X', webhookUrl: HOOK_A, chatbotIds: [missing] }, cipher),
    ).rejects.toThrow(new InboxValidationError(LARK_GROUP_UNKNOWN_CHATBOT));
    expect(await listLarkGroups(t.db)).toEqual([]);
    const g = await createLarkGroup(t.db, t.admin.id, { name: 'X', webhookUrl: HOOK_A }, cipher);
    await expect(updateLarkGroup(t.db, t.admin.id, g.id, { chatbotIds: [missing] }, cipher)).rejects.toThrow(
      LARK_GROUP_UNKNOWN_CHATBOT,
    );
    // Dữ liệu sai (qua thẳng core) ⇒ InboxValidationError.
    await expect(
      createLarkGroup(t.db, t.admin.id, { name: ' ', webhookUrl: 'http://x.test' }, cipher),
    ).rejects.toBeInstanceOf(InboxValidationError);

    await t.db.insert(larkGroups).values(
      Array.from({ length: LARK_GROUP_LIMITS.maxGroups - 1 }, (_, i) => ({
        name: `G${i}`,
        webhookUrl: HOOK_B,
      })),
    );
    await expect(
      createLarkGroup(t.db, t.admin.id, { name: 'Thừa', webhookUrl: HOOK_C }, cipher),
    ).rejects.toThrow(LARK_GROUP_LIMIT_REACHED);
  });

  it('xóa chatbot ⇒ tự gỡ khỏi nhóm (cascade); secret hỏng ⇒ Gửi thử báo 400', async () => {
    const bot = await createBot();
    const keep = await createBot();
    const g = await createLarkGroup(
      t.db,
      t.admin.id,
      { name: 'Nhóm', webhookUrl: HOOK_A, chatbotIds: [bot.id, keep.id] },
      cipher,
    );
    await deleteChatbot(t.db, t.admin.id, bot.id);
    expect((await listLarkGroups(t.db))[0]!.chatbotIds).toEqual([keep.id]);
    expect(await t.db.select().from(larkGroups).where(eq(larkGroups.id, g.id))).toHaveLength(1);

    await t.db.update(larkGroups).set({ secretEnc: 'hong:abc' }).where(eq(larkGroups.id, g.id));
    await expect(getLarkGroupConfig(t.db, cipher, g.id)).rejects.toBeInstanceOf(InboxValidationError);
  });

  it('bot bị xóa đúng lúc đang lưu nhóm ⇒ 400 LARK_GROUP_UNKNOWN_CHATBOT (không vỡ FK ⇒ 500)', async () => {
    const existing = await createLarkGroup(t.db, t.admin.id, { name: 'Có sẵn', webhookUrl: HOOK_A }, cipher);
    const saves: ((botId: string) => Promise<unknown>)[] = [
      (botId) =>
        createLarkGroup(t.db, t.admin.id, { name: 'Mới', webhookUrl: HOOK_B, chatbotIds: [botId] }, cipher),
      (botId) => updateLarkGroup(t.db, t.admin.id, existing.id, { chatbotIds: [botId] }, cipher),
    ];
    for (const save of saves) {
      const bot = await createBot();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let markDeleted!: () => void;
      const deleted = new Promise<void>((r) => (markDeleted = r));
      // Admin B: xóa bot nhưng chưa commit.
      const deleting = t.db.transaction(async (tx) => {
        await tx.delete(chatbots).where(eq(chatbots.id, bot.id));
        markDeleted();
        await gate;
      });
      await deleted;
      // Admin A: lưu nhóm có bot đó — phải chờ khóa dòng của B.
      const saving = save(bot.id).then(
        () => null,
        (e: unknown) => e,
      );
      for (let i = 0; i < 100; i++) {
        const res = await t.db.execute<{ n: number }>(
          sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`,
        );
        if ((res.rows[0]?.n ?? 0) > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      release();
      await deleting;
      const err = await saving;
      expect(err).toBeInstanceOf(InboxValidationError);
      expect((err as Error).message).toBe(LARK_GROUP_UNKNOWN_CHATBOT);
    }
    expect((await listLarkGroups(t.db)).map((g) => [g.name, g.chatbotIds])).toEqual([['Có sẵn', []]]);
  });
});

describe('getLarkTargets', () => {
  const ENV = { webhookUrl: LARK_URL, secret: null };

  it('bot trong nhóm ⇒ chỉ các nhóm đó; bot không trong nhóm / không có bot ⇒ nhóm chung; không có nhóm chung ⇒ []', async () => {
    const inGroups = await createBot();
    const free = await createBot();
    const a = await createLarkGroup(
      t.db,
      t.admin.id,
      { name: 'A', webhookUrl: HOOK_A, secret: 'sa', chatbotIds: [inGroups.id] },
      cipher,
    );
    const b = await createLarkGroup(
      t.db,
      t.admin.id,
      { name: 'B', webhookUrl: HOOK_B, chatbotIds: [inGroups.id] },
      cipher,
    );
    await createLarkGroup(t.db, t.admin.id, { name: 'C', webhookUrl: HOOK_C }, cipher);

    expect(await getLarkTargets(t.db, cipher, { chatbotId: inGroups.id }, ENV)).toEqual([
      { larkGroupId: a.id, webhookUrl: HOOK_A, secret: 'sa' },
      { larkGroupId: b.id, webhookUrl: HOOK_B, secret: null },
    ]);
    expect(await getLarkTargets(t.db, cipher, { chatbotId: free.id }, ENV)).toEqual([
      { larkGroupId: null, ...ENV },
    ]);
    expect(await getLarkTargets(t.db, cipher, { chatbotId: null }, ENV)).toEqual([
      { larkGroupId: null, ...ENV },
    ]);
    expect(await getLarkTargets(t.db, cipher, { chatbotId: free.id })).toEqual([]);
    // Bot trong nhóm KHÔNG cần nhóm chung.
    expect(await getLarkTargets(t.db, cipher, { chatbotId: inGroups.id })).toHaveLength(2);
  });

  it('hai nhóm cùng webhook ⇒ một nơi; nhóm secret hỏng ⇒ bỏ qua (log), không rơi về nhóm chung', async () => {
    const bot = await createBot();
    const a = await createLarkGroup(
      t.db,
      t.admin.id,
      { name: 'A', webhookUrl: HOOK_A, chatbotIds: [bot.id] },
      cipher,
    );
    await createLarkGroup(t.db, t.admin.id, { name: 'A2', webhookUrl: HOOK_A, chatbotIds: [bot.id] }, cipher);
    const broken = await createLarkGroup(
      t.db,
      t.admin.id,
      { name: 'Z', webhookUrl: HOOK_B, secret: 'x', chatbotIds: [bot.id] },
      cipher,
    );
    await t.db.update(larkGroups).set({ secretEnc: 'hong' }).where(eq(larkGroups.id, broken.id));
    const warns: unknown[] = [];
    const logger = { warn: (obj: object) => void warns.push(obj) };
    expect(await getLarkTargets(t.db, cipher, { chatbotId: bot.id }, ENV, logger)).toEqual([
      { larkGroupId: a.id, webhookUrl: HOOK_A, secret: null },
    ]);
    expect(warns).toEqual([{ larkGroupId: broken.id, chatbotId: bot.id }]);

    await t.db.update(larkGroups).set({ webhookUrl: HOOK_C }).where(eq(larkGroups.id, a.id));
    await t.db.delete(larkGroups).where(eq(larkGroups.webhookUrl, HOOK_A));
    expect(await getLarkTargets(t.db, cipher, { chatbotId: bot.id }, ENV, logger)).toEqual([
      { larkGroupId: a.id, webhookUrl: HOOK_C, secret: null },
    ]);
  });

  it('notifyConversationLark: đọc bot từ hội thoại; một nhóm lỗi không chặn nhóm khác', async () => {
    const bot = await createBot();
    await createLarkGroup(t.db, t.admin.id, { name: 'A', webhookUrl: HOOK_A, chatbotIds: [bot.id] }, cipher);
    await createLarkGroup(t.db, t.admin.id, { name: 'B', webhookUrl: HOOK_B, chatbotIds: [bot.id] }, cipher);
    const conv = await createConversation(t.db, { channel, contactName: 'Chị Mai', chatbotId: bot.id });
    expect(await conversationChatbotId(t.db, conv.id)).toBe(bot.id);

    const calls: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      calls.push(String(input));
      const ok = String(input) !== HOOK_A;
      return new Response(JSON.stringify(ok ? { code: 0 } : { code: 9499, msg: 'sai' }), { status: 200 });
    }) as typeof fetch;
    const card = buildHandoffLarkCard({
      contactName: 'Chị Mai',
      channelName: 'Fanpage',
      reasonLabel: 'Khác',
      summary: 'Thử',
      conversationUrl: 'https://inbox.test/inbox/x',
    });
    expect(
      await notifyConversationLark(t.db, cipher, { conversationId: conv.id }, card, {
        fetch: fetchFn,
        fallback: { webhookUrl: LARK_URL },
        logger: silentLogger,
      }),
    ).toEqual({ sent: 1, targets: 2 });
    expect(calls.sort()).toEqual([HOOK_A, HOOK_B]);
  });
});

describe('các chỗ gửi Lark của worker', () => {
  it('chuyển người + nhắc lại + từ khóa báo nhân viên ⇒ gửi webhook của nhóm (không gửi nhóm chung)', async () => {
    const bot = await createBot(undefined, { handoffReminderMin: 5, notifyKeywords: ['gọi lại'] });
    await createLarkGroup(
      t.db,
      t.admin.id,
      { name: 'Nhóm riêng', webhookUrl: HOOK_A, chatbotIds: [bot.id] },
      kit.deps.cipher,
    );
    const conv = await createConversation(t.db, {
      channel,
      contactName: 'Chị Mai',
      chatbotId: bot.id,
      aiMode: 'auto',
      lastCustomerMessageAt: new Date(),
    });

    const res = await escalateConversation(t.db, kit.deps, conv.id, {
      reasonCode: 'other',
      summary: 'Khách cần báo giá',
      createdBy: 'ai',
    });
    expect(res.created).toBe(true);
    expect(kit.lark.calls.map((c) => c.url)).toEqual([HOOK_A]);

    const [h] = await t.db.select().from(handoffs).where(eq(handoffs.conversationId, conv.id));
    expect(
      await processHandoffReminderJob(t.db, kit.deps, { conversationId: conv.id, handoffId: h!.id }),
    ).toBe(true);
    expect(kit.lark.calls.map((c) => c.url)).toEqual([HOOK_A, HOOK_A]);

    const conv2 = await createConversation(t.db, {
      channel,
      contactName: 'Anh Nam',
      chatbotId: bot.id,
      aiMode: 'auto',
      lastCustomerMessageAt: new Date(),
    });
    expect(await notifyStaffKeyword(t.db, kit.deps, conv2.id, { keyword: 'gọi lại' })).toBe(true);
    expect(kit.lark.calls.map((c) => c.url)).toEqual([HOOK_A, HOOK_A, HOOK_A]);
  });

  it('bot không thuộc nhóm nào ⇒ vẫn gửi nhóm chung như trước', async () => {
    const bot = await createBot();
    const other = await createBot();
    await createLarkGroup(
      t.db,
      t.admin.id,
      { name: 'Khác', webhookUrl: HOOK_A, chatbotIds: [other.id] },
      cipher,
    );
    const conv = await createConversation(t.db, {
      channel,
      contactName: 'Chị Lan',
      chatbotId: bot.id,
      aiMode: 'auto',
      lastCustomerMessageAt: new Date(),
    });
    await escalateConversation(t.db, kit.deps, conv.id, {
      reasonCode: 'other',
      summary: 'x',
      createdBy: 'ai',
    });
    expect(kit.lark.calls.map((c) => c.url)).toEqual([LARK_URL]);
  });
});
