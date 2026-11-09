// Luồng tin đến (6.1, bỏ bước 7 gọi AI ở Giai đoạn 1).
import {
  channelAccounts,
  conversations,
  messages,
  type ContactIdentity,
  type Conversation,
  type Db,
} from '@dezon/db';
import type { MessageAttachment, NormalizedInboundMessage } from '@dezon/shared';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { AccountResolver, InboundEvent } from '../connectors/types';
import type { InboundJobData } from '../jobs';
import { DEFAULT_MIME } from '../media/mime';
import { downloadToBuffer, storeMedia } from '../media/storage';
import { isOwnEcho, ownEchoMessageId } from './echo';
import { emitMessageCreated, errorMessage } from './helpers';
import { ensureContactIdentity } from './identity';
import { markSentFromEcho } from './outbound';
import { isOwnSentCopy, recordSentExternalId } from './own-sent';
import { processDelivery, processRead, ReceiptNotReadyError } from './receipts';
import type { InboundMessageResult, InboundProcessOptions, PipelineDeps } from './types';

export { isOwnEcho } from './echo';
export { ReceiptNotReadyError } from './receipts';

/** Tra channel_account theo (type, external_id). Bỏ qua tài khoản đã ngắt kết nối. */
export function createAccountResolver(db: Db): AccountResolver {
  return async (channelType, externalId) => {
    const [row] = await db
      .select({ id: channelAccounts.id })
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.type, channelType),
          eq(channelAccounts.externalId, externalId),
          ne(channelAccounts.status, 'disconnected'),
        ),
      )
      .limit(1);
    return row ?? null;
  };
}

/** Parse webhook bằng connector rồi xử lý từng sự kiện. */
export async function processInboundJob(db: Db, deps: PipelineDeps, data: InboundJobData): Promise<void> {
  const connector = deps.connectors[data.channelType];
  if (!connector) {
    throw new Error(`Chưa cấu hình connector cho kênh "${data.channelType}" trên worker`);
  }
  const events = await connector.parseWebhook(data.payload, createAccountResolver(db));
  // Tuần tự để giữ thứ tự tin trong cùng webhook; lỗi => ném lại cho BullMQ thử lại (xử lý idempotent).
  // Receipt đến trước khi worker ghi 'sent': xử lý hết các sự kiện khác rồi mới ném để job chạy lại.
  let notReady: ReceiptNotReadyError | undefined;
  for (const event of events) {
    try {
      await processInboundEvent(db, deps, event);
    } catch (error) {
      if (error instanceof ReceiptNotReadyError) {
        notReady = error;
        continue;
      }
      deps.logger.error(
        { channelType: data.channelType, kind: event.kind, err: errorMessage(error) },
        'Lỗi xử lý sự kiện webhook',
      );
      throw error;
    }
  }
  if (notReady) {
    deps.logger.debug(
      { channelType: data.channelType },
      'Receipt đến trước khi tin được ghi sent, thử lại sau',
    );
    throw notReady;
  }
}

/** Upsert contact/identity/conversation, chống trùng, tải media, lưu message, cập nhật hội thoại, phát realtime. */
export async function processInboundEvent(
  db: Db,
  deps: PipelineDeps,
  event: InboundEvent,
  opts: InboundProcessOptions = {},
): Promise<void> {
  switch (event.kind) {
    case 'message':
      await processInboundMessage(db, deps, event.message, opts);
      return;
    case 'delivery':
      return processDelivery(db, deps, event);
    case 'read':
      return processRead(db, deps, event);
  }
}

async function findMessageId(db: Db, channelAccountId: string, externalMessageId: string) {
  const [row] = await db
    .select({ id: messages.id, status: messages.status })
    .from(messages)
    .where(
      and(eq(messages.channelAccountId, channelAccountId), eq(messages.externalMessageId, externalMessageId)),
    )
    .limit(1);
  return row;
}

const NOT_STORED: InboundMessageResult = { stored: false };

/**
 * Xử lý một tin (webhook hoặc đồng bộ). Xem InboundSource: đồng bộ lịch sử không tăng unread, không mở lại
 * hội thoại đã xong, không phát message.created.
 */
export async function processInboundMessage(
  db: Db,
  deps: PipelineDeps,
  msg: NormalizedInboundMessage,
  opts: InboundProcessOptions = {},
): Promise<InboundMessageResult> {
  const source = opts.source ?? 'webhook';
  const backfill = source === 'sync-backfill';
  const log = { channelAccountId: msg.channelAccountId, direction: msg.direction, source };

  // (4) Chống trùng TRƯỚC khi tải media: webhook lặp không tải lại.
  if (await findMessageId(db, msg.channelAccountId, msg.externalMessageId)) {
    deps.logger.debug(log, 'Tin đã xử lý, bỏ qua');
    return NOT_STORED;
  }
  // Echo của chính app: tin đã được outbound lưu (có external id) => đã dừng ở trên. Echo về trước
  // khi Send API trả kết quả: nếu metadata có id message thì đánh dấu sent ngay (lần thử lại do
  // timeout/5xx sẽ bỏ qua, không gửi trùng); không tạo tin mới.
  if (isOwnEcho(msg, deps)) {
    const messageId = ownEchoMessageId(msg.raw);
    // Ghi mid của mọi phần vào tin gốc để đồng bộ (không có app_id) nhận ra bản sao.
    if (messageId) await recordSentExternalId(db, messageId, msg.externalMessageId);
    if (
      messageId &&
      (await markSentFromEcho(db, deps, messageId, msg.channelAccountId, msg.externalMessageId))
    ) {
      deps.logger.debug(log, 'Echo của hệ thống: đánh dấu tin đã gửi');
      return NOT_STORED;
    }
    deps.logger.debug(log, 'Echo của hệ thống, bỏ qua');
    return NOT_STORED;
  }
  // Tin 'out' từ đồng bộ không có app_id: bỏ bản sao của tin hệ thống đã/đang gửi.
  if (source !== 'webhook' && (await isOwnSentCopy(db, msg))) {
    deps.logger.debug(log, 'Tin hệ thống đã gửi (đồng bộ), bỏ qua');
    return NOT_STORED;
  }

  const [account] = await db
    .select({ defaultAiMode: channelAccounts.defaultAiMode })
    .from(channelAccounts)
    .where(eq(channelAccounts.id, msg.channelAccountId))
    .limit(1);
  if (!account) throw new Error('Không tìm thấy channel_account của sự kiện');

  // (3) Khách + hội thoại.
  const identity = await ensureContactIdentity(db, deps, msg);
  const conversation = await upsertConversation(db, msg, identity, account.defaultAiMode);

  // (5) Media rồi mới lưu tin để tin hiện đủ ảnh.
  const attachments = await downloadAttachments(deps, msg);
  const isCustomer = msg.direction === 'in';

  const saved = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(messages)
      .values({
        conversationId: conversation.id,
        channelAccountId: msg.channelAccountId,
        senderType: isCustomer ? 'customer' : msg.senderType,
        senderUserId: null,
        externalMessageId: msg.externalMessageId,
        text: msg.text ?? null,
        attachments,
        status: isCustomer ? 'received' : 'sent',
        raw: msg.raw ?? null,
        sentAt: msg.sentAt,
      })
      .onConflictDoNothing({ target: [messages.channelAccountId, messages.externalMessageId] })
      .returning({ id: messages.id });
    if (!row) return null;

    // (6) Cập nhật hội thoại.
    const [updated] = await tx
      .update(conversations)
      .set(conversationUpdate(isCustomer, backfill, msg.sentAt))
      .where(eq(conversations.id, conversation.id))
      .returning({ id: conversations.id, assignedUserId: conversations.assignedUserId });
    return updated ? { messageId: row.id, conversation: updated } : null;
  });

  if (!saved) {
    // Job khác lưu cùng tin trước: bỏ tệp vừa tải.
    await Promise.allSettled(
      attachments.filter((a) => a.storage_key).map((a) => deps.storage.delete(a.storage_key)),
    );
    deps.logger.debug(log, 'Tin trùng (đua), bỏ qua');
    return NOT_STORED;
  }
  if (!backfill) await emitMessageCreated(db, deps, saved.messageId, saved.conversation);
  return { stored: true, conversation: saved.conversation };
}

/**
 * Cột cần cập nhật của hội thoại khi lưu tin. Tin của khách: mốc cửa sổ + (trừ đồng bộ lịch sử) unread++
 * và mở lại hội thoại đã xong. Tin gửi đi: chỉ last_message_at.
 */
function conversationUpdate(isCustomer: boolean, backfill: boolean, sentAt: Date) {
  const lastMessageAt = sql`GREATEST(${conversations.lastMessageAt}, ${sentAt})`;
  if (!isCustomer) return { lastMessageAt };
  const lastCustomerMessageAt = sql`GREATEST(${conversations.lastCustomerMessageAt}, ${sentAt})`;
  if (backfill) return { lastMessageAt, lastCustomerMessageAt };
  return {
    lastMessageAt,
    lastCustomerMessageAt,
    unreadCount: sql`${conversations.unreadCount} + 1`,
    status: sql`CASE WHEN ${conversations.status} = 'resolved' THEN 'open'::conversation_status ELSE ${conversations.status} END`,
  };
}

/**
 * Upsert hội thoại theo contact_identity_id. window_source (chỉ Messenger): 'ads' khi gặp
 * referral.source = 'ADS' (kể cả đến sau tin đầu), còn lại 'organic'.
 */
async function upsertConversation(
  db: Db,
  msg: NormalizedInboundMessage,
  identity: ContactIdentity,
  defaultAiMode: Conversation['aiMode'],
): Promise<Pick<Conversation, 'id' | 'windowSource'>> {
  const fromAds = msg.referral?.source?.toUpperCase() === 'ADS';
  const windowSource = msg.channelType === 'messenger' ? (fromAds ? 'ads' : 'organic') : null;
  const [inserted] = await db
    .insert(conversations)
    .values({
      contactId: identity.contactId,
      channelAccountId: msg.channelAccountId,
      contactIdentityId: identity.id,
      aiMode: defaultAiMode,
      windowSource,
    })
    .onConflictDoNothing({ target: conversations.contactIdentityId })
    .returning({ id: conversations.id, windowSource: conversations.windowSource });
  if (inserted) return inserted;

  const [existing] = await db
    .select({ id: conversations.id, windowSource: conversations.windowSource })
    .from(conversations)
    .where(eq(conversations.contactIdentityId, identity.id))
    .limit(1);
  if (!existing) throw new Error('Không tìm thấy hội thoại sau khi upsert');
  if (fromAds && msg.channelType === 'messenger' && existing.windowSource !== 'ads') {
    await db.update(conversations).set({ windowSource: 'ads' }).where(eq(conversations.id, existing.id));
    return { ...existing, windowSource: 'ads' };
  }
  return existing;
}

/**
 * Tải từng tệp về S3 (prefix media). Tệp lỗi vẫn giữ trong tin với storage_key = '' và original_url
 * (DTO trả url = null) để nhân viên biết khách có gửi tệp.
 */
async function downloadAttachments(
  deps: PipelineDeps,
  msg: NormalizedInboundMessage,
): Promise<MessageAttachment[]> {
  return Promise.all(
    msg.attachments.map(async (att): Promise<MessageAttachment> => {
      try {
        const file = await downloadToBuffer(att.url, {
          maxBytes: deps.maxMediaBytes,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        });
        const mime = file.mime && file.mime !== DEFAULT_MIME ? file.mime : (att.mime ?? file.mime);
        const stored = await storeMedia(deps.storage, {
          data: file.data,
          ...(mime ? { mime } : {}),
          ...(att.name ? { filename: att.name } : {}),
          type: att.type,
          prefix: 'media',
          originalUrl: att.url,
        });
        return stored;
      } catch (error) {
        deps.logger.warn(
          { channelAccountId: msg.channelAccountId, type: att.type, err: errorMessage(error) },
          'Không tải được tệp đính kèm',
        );
        return {
          type: att.type,
          storage_key: '',
          mime: att.mime ?? DEFAULT_MIME,
          original_url: att.url,
          ...(att.name ? { name: att.name } : {}),
        };
      }
    }),
  );
}
