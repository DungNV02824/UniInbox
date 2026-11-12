// Luồng tin đến (6.1). Bước 7 (AI): gọi PipelineDeps.onCustomerMessageStored để worker lên lịch chatbot.
import {
  channelAccounts,
  chatbots,
  conversations,
  messages,
  type ContactIdentity,
  type Conversation,
  type Db,
} from '@dezon/db';
import type { MessageAttachment, NormalizedInboundMessage } from '@dezon/shared';
import { and, eq, ne, sql } from 'drizzle-orm';
import { DEFAULT_AI_PAUSE_AFTER_AGENT_MIN, pauseAiAfterAgentMessage } from '../ai/agent-pause';
import type { AccountResolver, InboundEvent } from '../connectors/types';
import type { InboundJobData } from '../jobs';
import { downloadAndStoreAttachment, failedAttachment } from './attachment-download';
import {
  isAdReplyNoticeText,
  isLikelyAutomatedEcho,
  lockConversationEchoClassification,
  reclassifyEchoesAfterCustomer,
  reclassifyEchoesNearAdNotice,
  recordEchoPause,
  withAutomatedFlag,
} from './automation-echo';
import { isOwnEcho, ownEchoMessageId } from './echo';
import { emitMessageCreated, errorMessage } from './helpers';
import { ensureContactIdentity, type DeferredTasks } from './identity';
import { markSentFromEcho } from './outbound';
import { isOwnSentCopy, recordSentExternalId } from './own-sent';
import { processDelivery, processRead, ReceiptNotReadyError } from './receipts';
import type { InboundMessageResult, InboundProcessOptions, PipelineDeps } from './types';

export {
  AD_GREETING_ECHO_WINDOW_SEC,
  AUTOMATED_ECHO_RAW_KEY,
  AUTOMATION_ECHO_WINDOW_SEC,
  repairAdGreetingEchoes,
  type AdGreetingRepairResult,
} from './automation-echo';
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
    .select({ defaultAiMode: channelAccounts.defaultAiMode, defaultChatbotId: chatbots.id })
    .from(channelAccounts)
    .leftJoin(chatbots, and(eq(chatbots.id, channelAccounts.defaultChatbotId), eq(chatbots.isActive, true)))
    .where(eq(channelAccounts.id, msg.channelAccountId))
    .limit(1);
  if (!account) throw new Error('Không tìm thấy channel_account của sự kiện');

  const deferred: DeferredTasks = [];
  try {
    return await storeInboundMessage(db, deps, msg, { source, backfill, log, account }, deferred);
  } finally {
    // Đường ra sớm (tin trùng do đua, lỗi giữa chừng): việc đã xếp (avatar) vẫn chạy. Mỗi việc tự bắt lỗi.
    await runDeferred(deferred);
  }
}

async function runDeferred(deferred: DeferredTasks): Promise<void> {
  for (const task of deferred.splice(0)) await task();
}

interface StoreInboundInput {
  source: NonNullable<InboundProcessOptions['source']>;
  backfill: boolean;
  log: Record<string, unknown>;
  account: { defaultAiMode: Conversation['aiMode']; defaultChatbotId: string | null };
}

/** Phần lưu của processInboundMessage (sau chống trùng/echo): khách, hội thoại, media, tin, hook chatbot, realtime. */
async function storeInboundMessage(
  db: Db,
  deps: PipelineDeps,
  msg: NormalizedInboundMessage,
  { source, backfill, log, account }: StoreInboundInput,
  deferred: DeferredTasks,
): Promise<InboundMessageResult> {
  // (3) Khách + hội thoại. Hội thoại MỚI (không tính đồng bộ lịch sử) tự gắn chatbot mặc định của kênh.
  const identity = await ensureContactIdentity(db, deps, msg, deferred);
  const defaults: ConversationDefaults =
    account.defaultChatbotId && !backfill
      ? { aiMode: 'auto', chatbotId: account.defaultChatbotId }
      : { aiMode: account.defaultAiMode, chatbotId: null };
  const conversation = await upsertConversation(db, msg, identity, defaults);

  // (5) Media rồi mới lưu tin để tin hiện đủ ảnh.
  const attachments = await downloadAttachments(deps, msg);
  const isCustomer = msg.direction === 'in';

  const saved = await db.transaction(async (tx) => {
    // Echo từ nền tảng gửi ngay sau tin khách (Instant Reply/Away...) hoặc ngay trước tin khách vào từ quảng cáo
    // (lời chào của quảng cáo) ⇒ tin tự động của Page, xem automation-echo.ts.
    const isPlatformEcho = !isCustomer && msg.senderType === 'agent';
    // Echo và tin khách của cùng hội thoại phân loại lần lượt (hai job inbound chạy song song).
    if (isPlatformEcho || isCustomer) await lockConversationEchoClassification(tx, conversation.id);
    const automatedEcho =
      isPlatformEcho && (await isLikelyAutomatedEcho(tx, conversation.id, msg.sentAt, msg.text));
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
        raw: automatedEcho ? withAutomatedFlag(msg.raw) : (msg.raw ?? null),
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
    // Nhân viên trả lời từ công cụ của nền tảng (Business Suite) ⇒ áp "Khi nhân viên vào nhắn tin" của bot như
    // tin từ hệ thống (tiếp tục / tạm nghỉ / dừng hẳn). Đồng bộ định kỳ tính từ lúc tin được gửi (tin cũ không
    // kéo dài pause). Echo tự động thì không.
    if (updated && isPlatformEcho && !automatedEcho && !backfill) {
      const pauseMin = deps.ctx.aiPauseAfterAgentMin ?? DEFAULT_AI_PAUSE_AFTER_AGENT_MIN;
      const from = source === 'webhook' ? deps.ctx.now() : msg.sentAt;
      const pause = await pauseAiAfterAgentMessage(tx, conversation.id, from, pauseMin);
      // Echo này "sở hữu" pause hiện tại (chính nó vừa đặt, kể cả mốc "dừng hẳn") ⇒ ghi lại để gỡ nếu tin khách
      // (đến sau, do chạy song song) cho thấy đây là tin tự động. 'continue' không đặt gì ⇒ không ghi.
      if (pause?.applied && pause.requestedUntil) await recordEchoPause(tx, row.id, pause.requestedUntil);
    }
    // Tin khách đến sau echo tự động (thứ tự xử lý đảo) ⇒ đánh dấu lại echo, gỡ pause echo đã đặt.
    if (updated && isCustomer) await reclassifyEchoesAfterCustomer(tx, conversation.id, msg.sentAt);
    // Echo "… đã trả lời một quảng cáo." tới sau cùng ⇒ lời chào quảng cáo lưu trước đó (bị coi là nhân viên) được
    // đánh dấu lại; có đánh dấu thì hẹn chatbot sau commit (lượt của tin khách có thể đã bị pause chặn/hủy).
    const greetingsReclassified =
      updated && isPlatformEcho && automatedEcho && isAdReplyNoticeText(msg.text)
        ? await reclassifyEchoesNearAdNotice(tx, conversation.id, msg.sentAt)
        : 0;
    return updated
      ? { messageId: row.id, conversation: updated, reschedule: greetingsReclassified > 0 }
      : null;
  });

  if (!saved) {
    // Job khác lưu cùng tin trước: bỏ tệp vừa tải.
    await Promise.allSettled(
      attachments.filter((a) => a.storage_key).map((a) => deps.storage.delete(a.storage_key)),
    );
    deps.logger.debug(log, 'Tin trùng (đua), bỏ qua');
    return NOT_STORED;
  }
  // Lên lịch chatbot TRƯỚC (đường trễ của câu trả lời bot), rồi mới tới việc chậm (avatar) và phát realtime.
  // Avatar chạy trước message.created để summary của tin đầu tiên đã có ảnh đại diện (như trước).
  if ((isCustomer || saved.reschedule) && !backfill && deps.onCustomerMessageStored) {
    try {
      await deps.onCustomerMessageStored({
        conversationId: saved.conversation.id,
        messageId: saved.messageId,
        source,
      });
    } catch (error) {
      deps.logger.warn(
        { conversationId: saved.conversation.id, err: errorMessage(error) },
        'Không lên lịch được chatbot cho tin khách',
      );
    }
  }
  await runDeferred(deferred);
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
interface ConversationDefaults {
  aiMode: Conversation['aiMode'];
  chatbotId: string | null;
}

async function upsertConversation(
  db: Db,
  msg: NormalizedInboundMessage,
  identity: ContactIdentity,
  defaults: ConversationDefaults,
): Promise<Pick<Conversation, 'id' | 'windowSource'>> {
  const fromAds = msg.referral?.source?.toUpperCase() === 'ADS';
  const windowSource = msg.channelType === 'messenger' ? (fromAds ? 'ads' : 'organic') : null;
  const [inserted] = await db
    .insert(conversations)
    .values({
      contactId: identity.contactId,
      channelAccountId: msg.channelAccountId,
      contactIdentityId: identity.id,
      aiMode: defaults.aiMode,
      chatbotId: defaults.chatbotId,
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
 * (DTO trả url = null) để nhân viên biết khách có gửi tệp; worker tự tải lại sau (attachment-retry.ts).
 */
async function downloadAttachments(
  deps: PipelineDeps,
  msg: NormalizedInboundMessage,
): Promise<MessageAttachment[]> {
  return Promise.all(
    msg.attachments.map(async (att): Promise<MessageAttachment> => {
      try {
        return await downloadAndStoreAttachment(deps, att);
      } catch (error) {
        deps.logger.warn(
          { channelAccountId: msg.channelAccountId, type: att.type, err: errorMessage(error) },
          'Không tải được tệp đính kèm',
        );
        return failedAttachment(att);
      }
    }),
  );
}
