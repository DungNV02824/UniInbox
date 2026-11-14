// "Nhật ký công trình": ghi (lọc trường, thứ tự, anchor, chống trùng theo aiRunId), đọc (mới nhất trước, giới hạn),
// xóa (quyền, 404, audit) — Postgres thật (Testcontainers).
import { aiRuns, auditLogs, projectLogs, type Conversation, type Db } from '@dezon/db';
import {
  CAPTURE_LIMITS,
  DEFAULT_PROJECT_LOG_CONFIG,
  PROJECT_LOG_LIMITS,
  type ProjectLogConfig,
} from '@dezon/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InboxForbiddenError, InboxNotFoundError } from '../src/inbox/errors';
import { getConversationDetail } from '../src/inbox/queries';
import {
  deleteProjectLog,
  listProjectLogs,
  projectLogFieldsOf,
  recordProjectLogs,
  type RecordProjectLogsInput,
} from '../src/project-logs/service';
import {
  addMessage,
  ago,
  createChannel,
  createConversation,
  HOUR,
  makeCtx,
  startTestDb,
  type TestDb,
} from './inbox-fixtures';

let t: TestDb;
let db: Db;
const ctx = makeCtx();

beforeAll(async () => {
  t = await startTestDb();
  db = t.db;
});

afterAll(async () => {
  await t?.stop();
});

/** Bật nhật ký; tắt 'ngay_chup'; thêm trường riêng 'hang_muc'. */
const CONFIG: ProjectLogConfig = {
  enabled: true,
  fields: [
    ...DEFAULT_PROJECT_LOG_CONFIG.fields.map((f) => (f.key === 'ngay_chup' ? { ...f, enabled: false } : f)),
    { key: 'hang_muc', label: 'Hạng mục', hint: '', enabled: true },
  ],
};

const IMAGE = { type: 'image' as const, storage_key: 'k/anh.jpg', mime: 'image/jpeg' };

async function newConversation(assignedUserId: string | null = null): Promise<Conversation> {
  const channel = await createChannel(db);
  return createConversation(db, { channel, assignedUserId });
}

function input(conv: Conversation, over: Partial<RecordProjectLogsInput> = {}): RecordProjectLogsInput {
  return {
    conversationId: conv.id,
    chatbotId: null,
    aiRunId: null,
    config: CONFIG,
    entries: [{ dia_chi: '252 Đ. Nguyễn Thái Bình' }],
    customerMessageIds: [],
    botMessageIds: [],
    now: new Date(),
    ...over,
  };
}

const rowsOf = (conversationId: string) =>
  db.select().from(projectLogs).where(eq(projectLogs.conversationId, conversationId));

describe('projectLogFieldsOf', () => {
  it('chỉ giữ trường bật, theo thứ tự cấu hình, nhãn cấu hình, gộp khoảng trắng, cắt độ dài, bỏ trống', () => {
    const long = 'x'.repeat(CAPTURE_LIMITS.valueMax + 50);
    expect(
      projectLogFieldsOf(CONFIG, {
        hang_muc: long,
        ngay_chup: '09/11/2026',
        la: 'khóa lạ',
        sdt_nha_thau: '   ',
        nha_thau: '  Công ty CP\n Xây dựng   TVL ',
        dia_chi: '252 Đ. Nguyễn Thái Bình',
        constructor: 'x',
      }),
    ).toEqual([
      { key: 'dia_chi', label: 'Địa chỉ công trình', value: '252 Đ. Nguyễn Thái Bình' },
      { key: 'nha_thau', label: 'Nhà thầu', value: 'Công ty CP Xây dựng TVL' },
      { key: 'hang_muc', label: 'Hạng mục', value: 'x'.repeat(CAPTURE_LIMITS.valueMax) },
    ]);
    expect(projectLogFieldsOf(CONFIG, { dia_chi: 12 as unknown as string })).toEqual([]);
  });
});

describe('recordProjectLogs', () => {
  it('cấu hình tắt hoặc không có công trình ⇒ không ghi gì', async () => {
    const conv = await newConversation();
    expect(await recordProjectLogs(db, input(conv, { config: DEFAULT_PROJECT_LOG_CONFIG }))).toEqual([]);
    expect(await recordProjectLogs(db, input(conv, { entries: [] }))).toEqual([]);
    expect(
      await recordProjectLogs(db, input(conv, { entries: [{ ngay_chup: '09/11/2026', la: 'x' }] })),
    ).toEqual([]);
    expect(await rowsOf(conv.id)).toHaveLength(0);
  });

  it('ghi mỗi công trình một dòng (bỏ công trình rỗng, tối đa maxEntriesPerTurn); message_ids bỏ trùng; anchor = tin khách có ảnh sớm nhất', async () => {
    const conv = await newConversation();
    const base = Date.now() - HOUR;
    const text1 = await addMessage(db, conv, { text: 'Em gửi ảnh ạ', sentAt: new Date(base) });
    const img2 = await addMessage(db, conv, { attachments: [IMAGE], sentAt: new Date(base + 2000) });
    const img1 = await addMessage(db, conv, {
      attachments: [{ type: 'file', storage_key: 'k/a.pdf', mime: 'application/pdf' }, IMAGE],
      sentAt: new Date(base + 1000),
    });
    const bot = await addMessage(db, conv, {
      senderType: 'bot',
      text: 'Dạ bên em tiếp nhận…',
      sentAt: new Date(base + 3000),
    });
    const entries: Array<Record<string, string>> = [
      { dia_chi: 'CT 1', nha_thau: 'TVL' },
      { ngay_chup: 'chỉ trường tắt' },
      ...Array.from({ length: 6 }, (_, i) => ({ dia_chi: `CT ${i + 2}` })),
    ];
    const now = new Date();
    const ids = await recordProjectLogs(
      db,
      input(conv, {
        entries,
        customerMessageIds: [text1, img2, img1, img2],
        botMessageIds: [bot, text1],
        now,
      }),
    );
    // 8 công trình ⇒ cắt còn 5 (công trình thứ 2 rỗng bị bỏ) ⇒ 4 dòng.
    expect(ids).toHaveLength(PROJECT_LOG_LIMITS.maxEntriesPerTurn - 1);
    const list = await listProjectLogs(db, conv.id);
    expect(list.map((l) => l.id)).toEqual(ids);
    expect(list.map((l) => l.fields[0]!.value)).toEqual(['CT 1', 'CT 2', 'CT 3', 'CT 4']);
    expect(list[0]).toMatchObject({
      conversationId: conv.id,
      fields: [
        { key: 'dia_chi', label: 'Địa chỉ công trình', value: 'CT 1' },
        { key: 'nha_thau', label: 'Nhà thầu', value: 'TVL' },
      ],
      messageIds: [text1, img2, img1, bot],
      anchorMessageId: img1,
      createdAt: now.toISOString(),
    });
  });

  it('anchor: không có ảnh ⇒ tin khách sớm nhất; không có tin khách ⇒ tin bot đầu; không có tin ⇒ null', async () => {
    const conv = await newConversation();
    const base = Date.now() - HOUR;
    const late = await addMessage(db, conv, { text: 'sau', sentAt: new Date(base + 1000) });
    const early = await addMessage(db, conv, { text: 'trước', sentAt: new Date(base) });
    const bot1 = await addMessage(db, conv, { senderType: 'bot', text: 'b1', sentAt: new Date(base + 2000) });
    const bot2 = await addMessage(db, conv, { senderType: 'bot', text: 'b2', sentAt: new Date(base + 3000) });

    const [a] = await recordProjectLogs(
      db,
      input(conv, { customerMessageIds: [late, early], botMessageIds: [bot1] }),
    );
    const [b] = await recordProjectLogs(db, input(conv, { botMessageIds: [bot2, bot1] }));
    const [c] = await recordProjectLogs(db, input(conv));
    // Tin khách không thuộc hội thoại này ⇒ không dùng làm anchor.
    const other = await newConversation();
    const foreign = await addMessage(db, other, { attachments: [IMAGE], sentAt: new Date(base) });
    const [d] = await recordProjectLogs(
      db,
      input(conv, { customerMessageIds: [foreign], botMessageIds: [bot1] }),
    );

    const byId = new Map((await listProjectLogs(db, conv.id)).map((l) => [l.id, l]));
    expect(byId.get(a!)?.anchorMessageId).toBe(early);
    expect(byId.get(b!)?.anchorMessageId).toBe(bot2);
    expect(byId.get(c!)?.anchorMessageId).toBeNull();
    expect(byId.get(c!)?.messageIds).toEqual([]);
    expect(byId.get(d!)?.anchorMessageId).toBe(bot1);
  });

  it('chống trùng theo aiRunId: gọi lại cùng lần chạy ⇒ trả id cũ, không ghi thêm', async () => {
    const conv = await newConversation();
    const [run] = await db
      .insert(aiRuns)
      .values({ conversationId: conv.id, model: 'm', decision: 'reply' })
      .returning({ id: aiRuns.id });
    const args = input(conv, {
      aiRunId: run!.id,
      entries: [{ dia_chi: 'CT A' }, { dia_chi: 'CT B' }],
    });
    const first = await db.transaction((tx) => recordProjectLogs(tx, args));
    expect(first).toHaveLength(2);
    const second = await db.transaction((tx) =>
      recordProjectLogs(tx, { ...args, entries: [{ dia_chi: 'CT C' }] }),
    );
    expect(second).toEqual(first);
    expect(await rowsOf(conv.id)).toHaveLength(2);
    const rows = await db.select().from(projectLogs).where(eq(projectLogs.aiRunId, run!.id));
    expect(rows.map((r) => r.fields[0]!.value).sort()).toEqual(['CT A', 'CT B']);
  });
});

describe('listProjectLogs', () => {
  it('mới nhất trước (created_at desc), giới hạn limit; getConversationDetail kèm projectLogs', async () => {
    const conv = await newConversation();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const [id] = await recordProjectLogs(
        db,
        input(conv, { entries: [{ dia_chi: `CT ${i}` }], now: ago((4 - i) * 60_000) }),
      );
      ids.push(id!);
    }
    const all = await listProjectLogs(db, conv.id);
    expect(all.map((l) => l.id)).toEqual([...ids].reverse());
    expect((await listProjectLogs(db, conv.id, 2)).map((l) => l.id)).toEqual([ids[3], ids[2]]);

    const detail = await getConversationDetail(db, t.admin, conv.id, ctx);
    expect(detail.projectLogs.map((l) => l.id)).toEqual([...ids].reverse());
    const empty = await newConversation();
    expect((await getConversationDetail(db, t.admin, empty.id, ctx)).projectLogs).toEqual([]);
  });
});

describe('deleteProjectLog', () => {
  it('xóa dòng, ghi audit (không ghi giá trị), trả nhật ký còn lại + summary', async () => {
    const conv = await newConversation(t.agent.id);
    const [keep] = await recordProjectLogs(
      db,
      input(conv, { entries: [{ dia_chi: 'Giữ' }], now: ago(60_000) }),
    );
    const [drop] = await recordProjectLogs(db, input(conv, { entries: [{ dia_chi: 'Xóa' }] }));
    const result = await deleteProjectLog(db, t.agent, conv.id, drop!, ctx);
    expect(result.projectLogs.map((l) => l.id)).toEqual([keep]);
    expect(result.conversation.id).toBe(conv.id);
    expect((await rowsOf(conv.id)).map((r) => r.id)).toEqual([keep]);
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'project_log.delete'), eq(auditLogs.entityId, conv.id)));
    expect(audit).toMatchObject({ userId: t.agent.id, entity: 'conversation', data: { logId: drop } });
    expect(JSON.stringify(audit!.data)).not.toContain('Xóa');
  });

  it('không xem được hội thoại ⇒ Forbidden; dòng của hội thoại khác / không tồn tại ⇒ NotFound', async () => {
    const conv = await newConversation(t.agent2.id);
    const [id] = await recordProjectLogs(db, input(conv));
    await expect(deleteProjectLog(db, t.agent, conv.id, id!, ctx)).rejects.toBeInstanceOf(
      InboxForbiddenError,
    );

    const other = await newConversation();
    await expect(deleteProjectLog(db, t.admin, other.id, id!, ctx)).rejects.toBeInstanceOf(
      InboxNotFoundError,
    );
    await expect(
      deleteProjectLog(db, t.admin, conv.id, '00000000-0000-4000-8000-000000000000', ctx),
    ).rejects.toBeInstanceOf(InboxNotFoundError);
    await expect(
      deleteProjectLog(db, t.admin, '00000000-0000-4000-8000-000000000000', id!, ctx),
    ).rejects.toBeInstanceOf(InboxNotFoundError);
    expect(await rowsOf(conv.id)).toHaveLength(1);
  });
});
