// Tiện ích dùng chung của runtime chatbot: tạo tin bot, xếp hàng gửi (giãn bong bóng), kiểm cửa sổ gửi
// cho bot, phát realtime.
import { randomUUID } from 'node:crypto';
import { channelAccounts, conversations, messages, type Db, type NewMessage } from '@dezon/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import { getConversationSummary, getMessageDto } from '../inbox/queries';
import type { DbLike } from '../inbox/read-model';
import { splitOutboundText } from '../inbox/split-text';
import type { InboxContext } from '../inbox/types';
import { BOT_BUBBLE_GAP_MAX_MS, BOT_BUBBLE_GAP_MIN_MS } from '../jobs';
import type { PipelineLogger } from '../pipeline/types';
import { firstCustomerMessageAt } from '../pipeline/window-anchor';
import { canSend, type CanSendResult } from '../policy';
import { roomsForConversation, type RealtimePublisher } from '../realtime';

export interface EmitDeps {
  publisher: RealtimePublisher;
  ctx: InboxContext;
  logger: PipelineLogger;
}

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** raw.outbound của tin bot: batchId chung + vị trí trong lượt (worker gửi typing_on trước phần kế tiếp). */
export interface BotOutboundRaw {
  batchId: string;
  /** Vị trí 0-based của bong bóng trong lượt trả lời. */
  part: number;
  /** Tổng số bong bóng của lượt. */
  parts: number;
}

/**
 * Còn bong bóng bot nào sau tin này trong cùng lượt không (đọc raw.outbound.part/parts; tin cũ không có ⇒ false).
 */
export function hasNextBotBubble(raw: unknown): boolean {
  const out = (raw as { outbound?: Partial<BotOutboundRaw> } | null)?.outbound;
  return (
    typeof out?.part === 'number' &&
    typeof out.parts === 'number' &&
    out.part >= 0 &&
    out.part < out.parts - 1
  );
}

/**
 * Tạo tin bot (status 'queued', sender 'bot', ai_run_id) — mỗi bong bóng tách ≤ 1999 ký tự, sent_at tăng
 * 1 ms mỗi phần để giữ thứ tự; cùng batchId để phần trước lỗi hẳn thì worker hủy phần sau (raw.outbound kèm
 * part/parts — BotOutboundRaw). Cập nhật last_message_at. Trả id theo thứ tự gửi.
 */
export async function insertBotMessages(
  tx: DbLike,
  conv: { id: string; channelAccountId: string },
  bubbles: readonly string[],
  aiRunId: string | null,
  now: Date,
): Promise<string[]> {
  const texts = bubbles.flatMap((b) => splitOutboundText(b));
  if (texts.length === 0) return [];
  const batchId = randomUUID();
  const rows: NewMessage[] = texts.map((text, i) => ({
    conversationId: conv.id,
    channelAccountId: conv.channelAccountId,
    senderType: 'bot',
    text,
    attachments: [],
    status: 'queued',
    aiRunId,
    raw: { outbound: { batchId, part: i, parts: texts.length } satisfies BotOutboundRaw },
    sentAt: new Date(now.getTime() + i),
  }));
  const inserted = await tx.insert(messages).values(rows).returning({ id: messages.id });
  const last = new Date(now.getTime() + rows.length - 1).toISOString();
  await tx
    .update(conversations)
    .set({
      lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${last}::timestamptz)`,
      updatedAt: now,
    })
    .where(eq(conversations.id, conv.id));
  return inserted.map((r) => r.id);
}

/** Tin bot 'queued' quá lâu chưa gửi (job outbound mất do worker chết sau commit) được xếp hàng lại. */
export const BOT_REQUEUE_MAX_AGE_SEC = 60 * 60;

/**
 * Xếp hàng lại (enqueueOutbound delay 0) các tin bot còn 'queued' tạo trong khoảng
 * sent_at > now − maxAgeSec, created_at < now − minAgeSec (lọc theo hội thoại nếu có). An toàn khi lặp: jobId outbound cố định
 * (outboundJobId) nên job còn tồn tại thì BullMQ bỏ qua; worker outbound tự giữ thứ tự trong hội thoại.
 * Trả số tin đã xếp hàng lại.
 */
export async function requeueQueuedBotMessages(
  db: DbLike,
  scheduler: { enqueueOutbound(messageId: string, delayMs: number): Promise<void> },
  opts: { conversationId?: string; minAgeSec: number; maxAgeSec?: number; limit?: number },
): Promise<number> {
  const maxAgeSec = opts.maxAgeSec ?? BOT_REQUEUE_MAX_AGE_SEC;
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.senderType, 'bot'),
        eq(messages.status, 'queued'),
        // Không lọc hội thoại (sweeper): chỉ xét hội thoại có tin trong cửa sổ để dùng index
        // (conversation_id, sent_at) thay vì quét cả bảng messages.
        opts.conversationId
          ? eq(messages.conversationId, opts.conversationId)
          : sql`${messages.conversationId} in (select c.id from ${conversations} c
              where c.last_message_at > now() - make_interval(secs => ${maxAgeSec}))`,
        // Tuổi tối thiểu theo created_at (đồng hồ DB, cùng now()); sent_at là giờ JS của worker.
        sql`${messages.createdAt} < now() - make_interval(secs => ${opts.minAgeSec})`,
        sql`${messages.sentAt} > now() - make_interval(secs => ${maxAgeSec})`,
      ),
    )
    .orderBy(asc(messages.sentAt), asc(messages.id))
    .limit(opts.limit ?? 200);
  for (const row of rows) await scheduler.enqueueOutbound(row.id, 0);
  return rows.length;
}

/** Giãn cách cộng dồn cho từng bong bóng: 0, gap1, gap1+gap2, ... (gap ∈ [MIN, MAX]). */
export function bubbleDelays(count: number, random: () => number = Math.random): number[] {
  const delays: number[] = [];
  let acc = 0;
  for (let i = 0; i < count; i++) {
    if (i > 0) {
      acc += Math.round(BOT_BUBBLE_GAP_MIN_MS + random() * (BOT_BUBBLE_GAP_MAX_MS - BOT_BUBBLE_GAP_MIN_MS));
    }
    delays.push(acc);
  }
  return delays;
}

/** Bot có được gửi tin trong hội thoại lúc này không (kênh connected + ChannelPolicy by 'bot'). */
export async function botCanSend(
  db: DbLike,
  conv: {
    id: string;
    channelType: (typeof channelAccounts.$inferSelect)['type'];
    channelStatus: (typeof channelAccounts.$inferSelect)['status'];
    lastCustomerMessageAt: Date | null;
    windowSource: (typeof conversations.$inferSelect)['windowSource'];
  },
  ctx: InboxContext,
): Promise<CanSendResult> {
  if (conv.channelStatus !== 'connected') {
    return { allowed: false, reason: 'Kênh đang mất kết nối', expiresAt: null };
  }
  return canSend(
    {
      channelType: conv.channelType,
      lastCustomerMessageAt: conv.lastCustomerMessageAt,
      windowSource: conv.windowSource,
      firstCustomerMessageAt: conv.windowSource === 'ads' ? await firstCustomerMessageAt(db, conv.id) : null,
    },
    'bot',
    ctx.now(),
    ctx.policy,
  );
}

/** Phát message.created cho từng tin (kèm summary mới nhất). Lỗi realtime chỉ log. */
export async function emitMessagesCreated(
  db: Db,
  deps: EmitDeps,
  messageIds: readonly string[],
  conversationId: string,
): Promise<void> {
  if (messageIds.length === 0) return;
  try {
    const summary = await getConversationSummary(db, conversationId, deps.ctx);
    const rooms = roomsForConversation({ assignedUserId: summary.assignedUser?.id ?? null });
    for (const id of messageIds) {
      const message = await getMessageDto(db, id, deps.ctx);
      deps.publisher.emit(rooms, 'message.created', { message, conversation: summary });
    }
  } catch (error) {
    deps.logger.error({ conversationId, err: errorText(error) }, 'Không phát được message.created (AI)');
  }
}

/** Phát conversation.updated; trả summary (null nếu lỗi). */
export async function emitConversationUpdated(db: Db, deps: EmitDeps, conversationId: string) {
  try {
    const summary = await getConversationSummary(db, conversationId, deps.ctx);
    deps.publisher.emit(
      roomsForConversation({ assignedUserId: summary.assignedUser?.id ?? null }),
      'conversation.updated',
      { conversation: summary },
    );
    return summary;
  } catch (error) {
    deps.logger.error({ conversationId, err: errorText(error) }, 'Không phát được conversation.updated (AI)');
    return null;
  }
}
