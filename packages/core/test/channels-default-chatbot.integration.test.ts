// Tích hợp: "Áp dụng chatbot mặc định cho hội thoại đang có" của một kênh (preview + apply).
import { auditLogs, channelAccounts, chatbots, conversations, type Chatbot, type Db } from '@dezon/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyDefaultChatbot,
  DEFAULT_CHATBOT_INACTIVE_MESSAGE,
  DEFAULT_CHATBOT_MISSING_MESSAGE,
  previewApplyDefaultChatbot,
} from '../src/channels/default-chatbot';
import { InboxNotFoundError, InboxValidationError } from '../src/inbox/errors';
import { ago, createChannel, createConversation, HOUR, startTestDb, type TestDb } from './inbox-fixtures';

let t: TestDb;
let db: Db;

beforeAll(async () => {
  t = await startTestDb();
  db = t.db;
});

afterAll(async () => {
  await t?.stop();
});

const MISSING_ID = '00000000-0000-4000-8000-000000000000';
let botSeq = 0;

async function makeBot(values: Partial<Chatbot> = {}): Promise<Chatbot> {
  const [bot] = await db
    .insert(chatbots)
    .values({ name: `Bot ${++botSeq}`, ...values })
    .returning();
  return bot!;
}

async function convRow(id: string) {
  const [row] = await db.select().from(conversations).where(eq(conversations.id, id));
  return row!;
}

describe('previewApplyDefaultChatbot / applyDefaultChatbot', () => {
  it('đếm theo nhóm; chỉ đổi hội thoại đủ điều kiện, giữ ai_mode/status/tạm dừng; kênh khác không đổi; audit', async () => {
    const oldBot = await makeBot();
    const otherBot = await makeBot();
    const defaultBot = await makeBot();
    const channel = await createChannel(db, { defaultChatbotId: defaultBot.id });
    const otherChannel = await createChannel(db, { defaultChatbotId: defaultBot.id });
    const pausedUntil = new Date(Date.now() + HOUR);

    const autoOld = await createConversation(db, {
      channel,
      chatbotId: oldBot.id,
      aiMode: 'auto',
      lastMessageAt: ago(2 * HOUR),
    });
    const offOther = await createConversation(db, {
      channel,
      chatbotId: otherBot.id,
      aiMode: 'off',
      status: 'resolved',
      aiPausedUntil: pausedUntil,
      lastMessageAt: ago(HOUR),
    });
    const pendingOld = await createConversation(db, {
      channel,
      chatbotId: oldBot.id,
      aiMode: 'auto',
      status: 'pending_human',
      handoffReason: 'human_request',
    });
    const noBot = await createConversation(db, { channel, chatbotId: null, aiMode: 'off' });
    const noBotPending = await createConversation(db, { channel, chatbotId: null, status: 'pending_human' });
    const already = await createConversation(db, { channel, chatbotId: defaultBot.id, aiMode: 'auto' });
    const alreadyPending = await createConversation(db, {
      channel,
      chatbotId: defaultBot.id,
      status: 'pending_human',
    });
    const foreign = await createConversation(db, { channel: otherChannel, chatbotId: oldBot.id });

    expect(await previewApplyDefaultChatbot(db, channel.id)).toEqual({
      chatbotId: defaultBot.id,
      eligible: 2,
      alreadyUsing: 2,
      skippedPendingHuman: 1,
      skippedNoBot: 2,
    });

    const result = await applyDefaultChatbot(db, { actorUserId: t.admin.id }, channel.id);
    expect(result).toEqual({
      chatbotId: defaultBot.id,
      updated: 2,
      skippedPendingHuman: 1,
      // Mới nhất (last_message_at) trước.
      updatedConversationIds: [offOther.id, autoOld.id],
    });

    const a = await convRow(autoOld.id);
    expect(a).toMatchObject({ chatbotId: defaultBot.id, aiMode: 'auto', status: 'open' });
    expect(a.updatedAt.getTime()).toBeGreaterThan(autoOld.updatedAt.getTime());
    expect(await convRow(offOther.id)).toMatchObject({
      chatbotId: defaultBot.id,
      aiMode: 'off',
      status: 'resolved',
      aiPausedUntil: pausedUntil,
    });
    expect(await convRow(pendingOld.id)).toMatchObject({
      chatbotId: oldBot.id,
      status: 'pending_human',
      handoffReason: 'human_request',
    });
    expect((await convRow(noBot.id)).chatbotId).toBeNull();
    expect((await convRow(noBotPending.id)).chatbotId).toBeNull();
    expect((await convRow(already.id)).updatedAt).toEqual(already.updatedAt);
    expect((await convRow(alreadyPending.id)).updatedAt).toEqual(alreadyPending.updatedAt);
    expect(await convRow(foreign.id)).toMatchObject({ chatbotId: oldBot.id, updatedAt: foreign.updatedAt });

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, channel.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      userId: t.admin.id,
      action: 'channel.apply_default_chatbot',
      entity: 'channel_account',
      data: { chatbotId: defaultBot.id, updated: 2, skippedPendingHuman: 1 },
    });

    // Áp dụng lại: không còn gì để đổi.
    expect(await previewApplyDefaultChatbot(db, channel.id)).toEqual({
      chatbotId: defaultBot.id,
      eligible: 0,
      alreadyUsing: 4,
      skippedPendingHuman: 1,
      skippedNoBot: 2,
    });
    const again = await applyDefaultChatbot(db, { actorUserId: t.admin.id }, channel.id);
    expect(again).toMatchObject({ updated: 0, skippedPendingHuman: 1, updatedConversationIds: [] });
  });

  it('kênh chưa có chatbot mặc định: preview chỉ đếm hội thoại chưa gắn bot; apply ⇒ 400, không đổi gì', async () => {
    const bot = await makeBot();
    const channel = await createChannel(db);
    const withBot = await createConversation(db, { channel, chatbotId: bot.id });
    await createConversation(db, { channel, chatbotId: null });

    expect(await previewApplyDefaultChatbot(db, channel.id)).toEqual({
      chatbotId: null,
      eligible: 0,
      alreadyUsing: 0,
      skippedPendingHuman: 0,
      skippedNoBot: 1,
    });
    const err = await applyDefaultChatbot(db, { actorUserId: t.admin.id }, channel.id).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InboxValidationError);
    expect((err as Error).message).toBe(DEFAULT_CHATBOT_MISSING_MESSAGE);
    expect((await convRow(withBot.id)).chatbotId).toBe(bot.id);
  });

  it('chatbot mặc định đang tắt: preview vẫn đếm; apply ⇒ 400, không đổi, không audit', async () => {
    const oldBot = await makeBot();
    const offBot = await makeBot({ isActive: false });
    const channel = await createChannel(db, { defaultChatbotId: offBot.id });
    const conv = await createConversation(db, { channel, chatbotId: oldBot.id });

    expect(await previewApplyDefaultChatbot(db, channel.id)).toMatchObject({
      chatbotId: offBot.id,
      eligible: 1,
    });
    const err = await applyDefaultChatbot(db, { actorUserId: t.admin.id }, channel.id).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InboxValidationError);
    expect((err as Error).message).toBe(DEFAULT_CHATBOT_INACTIVE_MESSAGE);
    expect((await convRow(conv.id)).chatbotId).toBe(oldBot.id);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(inArray(auditLogs.entityId, [channel.id]));
    expect(audits).toHaveLength(0);
  });

  it('kênh không tồn tại ⇒ InboxNotFoundError (preview và apply)', async () => {
    await expect(previewApplyDefaultChatbot(db, MISSING_ID)).rejects.toBeInstanceOf(InboxNotFoundError);
    await expect(applyDefaultChatbot(db, { actorUserId: t.admin.id }, MISSING_ID)).rejects.toBeInstanceOf(
      InboxNotFoundError,
    );
  });

  it('dùng ctx.now cho updated_at', async () => {
    const oldBot = await makeBot();
    const defaultBot = await makeBot();
    const channel = await createChannel(db, { defaultChatbotId: defaultBot.id });
    const conv = await createConversation(db, { channel, chatbotId: oldBot.id });
    const fixed = new Date('2030-01-02T03:04:05.000Z');
    await applyDefaultChatbot(db, { actorUserId: t.admin.id }, channel.id, { now: () => fixed });
    expect((await convRow(conv.id)).updatedAt).toEqual(fixed);
    const [ch] = await db.select().from(channelAccounts).where(eq(channelAccounts.id, channel.id));
    expect(ch!.defaultChatbotId).toBe(defaultBot.id);
  });
});
