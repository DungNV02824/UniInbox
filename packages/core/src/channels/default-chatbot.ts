// "Áp dụng chatbot mặc định cho hội thoại đang có" của một kênh (trang admin Kênh).
import { auditLogs, channelAccounts, chatbots, conversations, type Db } from '@dezon/db';
import type { ApplyDefaultChatbotPreview, ApplyDefaultChatbotResult } from '@dezon/shared';
import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { InboxNotFoundError, InboxValidationError } from '../inbox/errors';
import type { InboxContext } from '../inbox/types';

export const DEFAULT_CHATBOT_MISSING_MESSAGE = 'Trang chưa có chatbot mặc định';
export const DEFAULT_CHATBOT_INACTIVE_MESSAGE = 'Chatbot mặc định đang tắt, hãy bật bot trước';
const CHANNEL_NOT_FOUND = 'Không tìm thấy kênh';

/** Kết quả lõi: thêm id các hội thoại vừa đổi bot (mới nhất trước) để API phát realtime có giới hạn. */
export interface ApplyDefaultChatbotOutcome extends ApplyDefaultChatbotResult {
  updatedConversationIds: string[];
}

/** Điều kiện "sẽ đổi": của kênh, đang gắn bot KHÁC bot mặc định, không "Cần người". */
const eligibleWhere = (channelId: string, chatbotId: string) =>
  and(
    eq(conversations.channelAccountId, channelId),
    isNotNull(conversations.chatbotId),
    ne(conversations.chatbotId, chatbotId),
    ne(conversations.status, 'pending_human'),
  );

/**
 * GET /channels/:id/default-chatbot/apply-preview (admin). Đếm hội thoại của kênh theo 4 nhóm rời nhau (cộng lại =
 * tổng hội thoại của kênh): chưa gắn bot (skippedNoBot) → đã dùng đúng bot mặc định (alreadyUsing, kể cả đang
 * "Cần người") → gắn bot khác nhưng đang "Cần người" (skippedPendingHuman) → còn lại (eligible). Kênh chưa có
 * chatbot mặc định ⇒ chỉ đếm skippedNoBot, các nhóm khác 0. Không kiểm bot bật/tắt (POST mới chặn).
 * Kênh không có ⇒ InboxNotFoundError.
 */
export async function previewApplyDefaultChatbot(
  db: Db,
  channelId: string,
): Promise<ApplyDefaultChatbotPreview> {
  const [channel] = await db
    .select({ defaultChatbotId: channelAccounts.defaultChatbotId })
    .from(channelAccounts)
    .where(eq(channelAccounts.id, channelId));
  if (!channel) throw new InboxNotFoundError(CHANNEL_NOT_FOUND);
  const chatbotId = channel.defaultChatbotId;
  const noBot = sql`${conversations.chatbotId} is null`;

  if (!chatbotId) {
    const [row] = await db
      .select({ skippedNoBot: sql<number>`count(*) filter (where ${noBot})`.mapWith(Number) })
      .from(conversations)
      .where(eq(conversations.channelAccountId, channelId));
    return {
      chatbotId: null,
      eligible: 0,
      alreadyUsing: 0,
      skippedPendingHuman: 0,
      skippedNoBot: row?.skippedNoBot ?? 0,
    };
  }

  const otherBot = sql`${conversations.chatbotId} is not null and ${conversations.chatbotId} <> ${chatbotId}`;
  const [row] = await db
    .select({
      skippedNoBot: sql<number>`count(*) filter (where ${noBot})`.mapWith(Number),
      alreadyUsing: sql<number>`count(*) filter (where ${conversations.chatbotId} = ${chatbotId})`.mapWith(
        Number,
      ),
      skippedPendingHuman:
        sql<number>`count(*) filter (where ${otherBot} and ${conversations.status} = 'pending_human')`.mapWith(
          Number,
        ),
      eligible:
        sql<number>`count(*) filter (where ${otherBot} and ${conversations.status} <> 'pending_human')`.mapWith(
          Number,
        ),
    })
    .from(conversations)
    .where(eq(conversations.channelAccountId, channelId));
  return {
    chatbotId,
    eligible: row?.eligible ?? 0,
    alreadyUsing: row?.alreadyUsing ?? 0,
    skippedPendingHuman: row?.skippedPendingHuman ?? 0,
    skippedNoBot: row?.skippedNoBot ?? 0,
  };
}

/**
 * POST /channels/:id/default-chatbot/apply (admin). Trong một transaction (khóa dòng kênh để không đổi chatbot mặc
 * định giữa chừng): đọc lại chatbot mặc định HIỆN TẠI; chưa có ⇒ InboxValidationError DEFAULT_CHATBOT_MISSING_MESSAGE;
 * bot đang tắt ⇒ InboxValidationError DEFAULT_CHATBOT_INACTIVE_MESSAGE. Một lệnh UPDATE … RETURNING đổi chatbot_id
 * (+ updated_at) cho hội thoại "sẽ đổi" (như preview: gắn bot khác, không "Cần người"); GIỮ NGUYÊN ai_mode,
 * ai_paused_until, status, handoff; không gửi tin, không đánh thức bot. Job "Tái chăm sóc" đã xếp cho bot cũ sẽ tự bị
 * chặn ở runtime (AI_BLOCKED_REENGAGE_BOT_CHANGED); lượt AI đang chạy dở của bot cũ bị hủy bởi raceReason.
 * Audit 'channel.apply_default_chatbot' { chatbotId, updated, skippedPendingHuman } (không ghi nội dung hội thoại).
 * Kênh không có ⇒ InboxNotFoundError.
 */
export async function applyDefaultChatbot(
  db: Db,
  deps: { actorUserId: string },
  channelId: string,
  ctx?: Pick<InboxContext, 'now'>,
): Promise<ApplyDefaultChatbotOutcome> {
  const now = ctx?.now() ?? new Date();
  return db.transaction(async (tx) => {
    const [channel] = await tx
      .select({ defaultChatbotId: channelAccounts.defaultChatbotId })
      .from(channelAccounts)
      .where(eq(channelAccounts.id, channelId))
      .for('update');
    if (!channel) throw new InboxNotFoundError(CHANNEL_NOT_FOUND);
    const chatbotId = channel.defaultChatbotId;
    if (!chatbotId) throw new InboxValidationError(DEFAULT_CHATBOT_MISSING_MESSAGE);
    const [bot] = await tx
      .select({ isActive: chatbots.isActive })
      .from(chatbots)
      .where(eq(chatbots.id, chatbotId));
    // FK default_chatbot_id ON DELETE SET NULL nên bot luôn còn; phòng hờ coi như chưa có.
    if (!bot) throw new InboxValidationError(DEFAULT_CHATBOT_MISSING_MESSAGE);
    if (!bot.isActive) throw new InboxValidationError(DEFAULT_CHATBOT_INACTIVE_MESSAGE);

    const [pending] = await tx
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(conversations)
      .where(
        and(
          eq(conversations.channelAccountId, channelId),
          isNotNull(conversations.chatbotId),
          ne(conversations.chatbotId, chatbotId),
          eq(conversations.status, 'pending_human'),
        ),
      );
    const skippedPendingHuman = pending?.n ?? 0;

    const updatedRows = await tx
      .update(conversations)
      .set({ chatbotId, updatedAt: now })
      .where(eligibleWhere(channelId, chatbotId))
      .returning({ id: conversations.id, lastMessageAt: conversations.lastMessageAt });

    await tx.insert(auditLogs).values({
      userId: deps.actorUserId,
      action: 'channel.apply_default_chatbot',
      entity: 'channel_account',
      entityId: channelId,
      data: { chatbotId, updated: updatedRows.length, skippedPendingHuman },
    });

    const recentFirst = [...updatedRows].sort(
      (a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0),
    );
    return {
      chatbotId,
      updated: updatedRows.length,
      skippedPendingHuman,
      updatedConversationIds: recentFirst.map((r) => r.id),
    };
  });
}
