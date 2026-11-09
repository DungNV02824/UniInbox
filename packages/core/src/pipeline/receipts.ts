// Sự kiện đã giao / đã xem của khách cho tin gửi đi (Messenger: message_deliveries, message_reads).
import { contactIdentities, conversations, messages, type Db } from '@dezon/db';
import { and, eq, gt, inArray, lte, or, type SQL } from 'drizzle-orm';
import type { InboundEvent } from '../connectors/types';
import { emitMessageUpdated } from './helpers';
import type { PipelineDeps } from './types';

type DeliveryEvent = Extract<InboundEvent, { kind: 'delivery' }>;
type ReadEvent = Extract<InboundEvent, { kind: 'read' }>;

async function findConversation(db: Db, channelAccountId: string, externalUserId: string) {
  const [row] = await db
    .select({ id: conversations.id, assignedUserId: conversations.assignedUserId })
    .from(conversations)
    .innerJoin(contactIdentities, eq(contactIdentities.id, conversations.contactIdentityId))
    .where(
      and(
        eq(contactIdentities.channelAccountId, channelAccountId),
        eq(contactIdentities.externalUserId, externalUserId),
      ),
    )
    .limit(1);
  return row;
}

const outgoing = inArray(messages.senderType, ['agent', 'bot']);

/** Chỉ coi là "đua" với tin vừa gửi nếu tin queued được tạo trong khoảng này trước watermark. */
export const RECEIPT_RACE_WINDOW_MS = 5 * 60_000;

/**
 * Receipt (giao/xem) về trước khi worker ghi status 'sent' cho tin vừa gửi (Send API chưa trả kết quả).
 * processInboundJob xử lý xong các sự kiện khác rồi ném lỗi này để BullMQ chạy lại job (idempotent).
 */
export class ReceiptNotReadyError extends Error {
  override readonly name = 'ReceiptNotReadyError';
  constructor() {
    super('Receipt đến trước khi tin gửi đi được ghi nhận, sẽ thử lại');
  }
}

/** Có tin gửi đi đang queued, tạo ngay trước `at` (có thể chính là tin receipt nói tới). */
async function hasRecentQueued(db: Db, conversationId: string, at: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        outgoing,
        eq(messages.status, 'queued'),
        lte(messages.sentAt, at),
        gt(messages.sentAt, new Date(at.getTime() - RECEIPT_RACE_WINDOW_MS)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Các mid trong receipt chưa có trong DB (tin vừa gửi chưa kịp ghi external id). */
async function hasUnknownMids(db: Db, conversationId: string, mids: string[]): Promise<boolean> {
  if (mids.length === 0) return false;
  const known = await db
    .select({ mid: messages.externalMessageId })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), inArray(messages.externalMessageId, mids)));
  return known.length < new Set(mids).size;
}

/** sent → delivered cho tin có trong mids hoặc gửi trước watermark. */
export async function processDelivery(db: Db, deps: PipelineDeps, event: DeliveryEvent): Promise<void> {
  const conv = await findConversation(db, event.channelAccountId, event.externalUserId);
  if (!conv) return;
  const match: SQL[] = [];
  if (event.externalMessageIds.length > 0) {
    match.push(inArray(messages.externalMessageId, event.externalMessageIds));
  }
  if (event.watermark) match.push(lte(messages.sentAt, event.watermark));
  if (match.length === 0) return;

  const updated = await db
    .update(messages)
    .set({ status: 'delivered' })
    .where(and(eq(messages.conversationId, conv.id), outgoing, eq(messages.status, 'sent'), or(...match)))
    .returning({ id: messages.id });
  for (const row of updated) await emitMessageUpdated(db, deps, row.id, conv);

  // Đua với outbound: mid lạ (hoặc chỉ có watermark mà không khớp tin nào) trong khi có tin vừa gửi
  // còn queued => chạy lại sau, đến lúc đó tin đã 'sent'.
  const suspicious =
    event.externalMessageIds.length > 0
      ? await hasUnknownMids(db, conv.id, event.externalMessageIds)
      : updated.length === 0;
  if (suspicious && (await hasRecentQueued(db, conv.id, event.watermark ?? deps.ctx.now()))) {
    throw new ReceiptNotReadyError();
  }
}

/** sent/delivered → seen cho tin gửi trước hoặc đúng watermark. */
export async function processRead(db: Db, deps: PipelineDeps, event: ReadEvent): Promise<void> {
  const conv = await findConversation(db, event.channelAccountId, event.externalUserId);
  if (!conv) return;
  const updated = await db
    .update(messages)
    .set({ status: 'seen' })
    .where(
      and(
        eq(messages.conversationId, conv.id),
        outgoing,
        inArray(messages.status, ['sent', 'delivered']),
        lte(messages.sentAt, event.watermark),
      ),
    )
    .returning({ id: messages.id });
  // Không thử lại cho read như delivery: khách khó mở tin trong lúc Send API chưa trả kết quả, còn
  // thử lại có thể đánh dấu "đã xem" cho tin gửi sau watermark.
  for (const row of updated) await emitMessageUpdated(db, deps, row.id, conv);
}
