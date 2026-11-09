// Luồng gửi tin (6.6).
import { channelAccounts, contactIdentities, conversations, messages, type Db } from '@dezon/db';
import type { MessageAttachment } from '@dezon/shared';
import { and, eq, gt, inArray, lt, ne, or, sql } from 'drizzle-orm';
import { loadResolvedAccount } from '../channels/service';
import {
  PermanentSendError,
  type ChannelConnector,
  type OutboundFilePart,
  type OutboundPart,
  type ResolvedChannelAccount,
  type SendOptions,
} from '../connectors/types';
import { canSend } from '../policy';
import { emitConversationUpdated, emitMessageUpdated, isUniqueViolation } from './helpers';
import { recordSentExternalId } from './own-sent';
import { firstCustomerMessageAt } from './window-anchor';
import type { PipelineDeps } from './types';

type ConvRef = { assignedUserId: string | null };

/**
 * Giữ thứ tự gửi trong một hội thoại: tin chỉ được gửi khi không còn tin gửi đi nào trước nó
 * (tạo trong khoảng này) đang queued. Giới hạn để một tin queued "mồ côi" (không có job) không chặn mãi.
 */
export const OUTBOUND_ORDER_WINDOW_MS = 5 * 60_000;
/** Chờ bao lâu rồi thử lại khi tin trước chưa gửi xong. */
export const OUTBOUND_WAIT_RETRY_MS = 1_000;

export const MSG_BATCH_ABORTED = 'Không gửi vì phần trước của tin nhắn gửi thất bại';

/**
 * Còn tin trước trong cùng hội thoại chưa gửi xong. Worker hoãn job (không tính lượt thử) rồi chạy lại.
 */
export class OutboundNotReadyError extends Error {
  override readonly name = 'OutboundNotReadyError';
  constructor(readonly retryAfterMs = OUTBOUND_WAIT_RETRY_MS) {
    super('Còn tin trước trong hội thoại chưa gửi xong');
  }
}

const outgoing = inArray(messages.senderType, ['agent', 'bot']);

async function loadContext(db: Db, messageId: string) {
  const [row] = await db
    .select({
      message: messages,
      conversation: {
        id: conversations.id,
        assignedUserId: conversations.assignedUserId,
        lastCustomerMessageAt: conversations.lastCustomerMessageAt,
        windowSource: conversations.windowSource,
      },
      externalUserId: contactIdentities.externalUserId,
      account: { id: channelAccounts.id, type: channelAccounts.type, status: channelAccounts.status },
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(contactIdentities, eq(contactIdentities.id, conversations.contactIdentityId))
    .innerJoin(channelAccounts, eq(channelAccounts.id, conversations.channelAccountId))
    .where(eq(messages.id, messageId))
    .limit(1);
  return row;
}

type Context = NonNullable<Awaited<ReturnType<typeof loadContext>>>;

/** Có tin gửi đi nào xếp trước (sent_at, id) vẫn đang queued không. */
async function hasEarlierQueued(db: Db, message: Context['message']): Promise<boolean> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, message.conversationId),
        outgoing,
        eq(messages.status, 'queued'),
        ne(messages.id, message.id),
        gt(messages.sentAt, new Date(message.sentAt.getTime() - OUTBOUND_ORDER_WINDOW_MS)),
        or(
          lt(messages.sentAt, message.sentAt),
          and(eq(messages.sentAt, message.sentAt), lt(messages.id, message.id)),
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Đổi trạng thái tin đang queued; trả true nếu có cập nhật. */
async function setStatus(
  db: Db,
  messageId: string,
  set: { status: 'sent' | 'failed'; error?: string | null; externalMessageId?: string },
): Promise<boolean> {
  const rows = await db
    .update(messages)
    .set(set)
    .where(and(eq(messages.id, messageId), eq(messages.status, 'queued')))
    .returning({ id: messages.id });
  return rows.length > 0;
}

function batchIdOf(raw: unknown): string | undefined {
  const batchId = (raw as { outbound?: { batchId?: unknown } } | null)?.outbound?.batchId;
  return typeof batchId === 'string' && batchId !== '' ? batchId : undefined;
}

/** Phần trước lỗi hẳn: hủy các phần sau (còn queued) của cùng lần gửi để khách không nhận tin cụt. */
async function abortRestOfBatch(db: Db, deps: PipelineDeps, messageId: string, conv: ConvRef) {
  const [failed] = await db
    .select({ conversationId: messages.conversationId, sentAt: messages.sentAt, raw: messages.raw })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  const batchId = failed && batchIdOf(failed.raw);
  if (!failed || !batchId) return;
  const rows = await db
    .update(messages)
    .set({ status: 'failed', error: MSG_BATCH_ABORTED })
    .where(
      and(
        eq(messages.conversationId, failed.conversationId),
        eq(messages.status, 'queued'),
        gt(messages.sentAt, failed.sentAt),
        sql`${messages.raw} -> 'outbound' ->> 'batchId' = ${batchId}`,
      ),
    )
    .returning({ id: messages.id });
  for (const row of rows) await emitMessageUpdated(db, deps, row.id, conv);
}

async function fail(db: Db, deps: PipelineDeps, messageId: string, conv: ConvRef, error: string) {
  if (await setStatus(db, messageId, { status: 'failed', error })) {
    await emitMessageUpdated(db, deps, messageId, conv);
    await abortRestOfBatch(db, deps, messageId, conv);
  }
}

function rawTag(raw: unknown): SendOptions['tag'] | undefined {
  const tag = (raw as { outbound?: { tag?: unknown } } | null)?.outbound?.tag;
  return tag === 'HUMAN_AGENT' ? tag : undefined;
}

function fileType(type: MessageAttachment['type']): OutboundFilePart['type'] {
  return type === 'sticker' ? 'image' : type;
}

async function buildParts(
  deps: PipelineDeps,
  text: string | null,
  attachments: MessageAttachment[],
): Promise<OutboundPart[]> {
  const parts: OutboundPart[] = [];
  if (text && text.trim() !== '') parts.push({ kind: 'text', text });
  for (const att of attachments) {
    if (!att.storage_key) throw new PermanentSendError('Tệp đính kèm chưa được lưu, không gửi được');
    parts.push({
      kind: 'attachment',
      type: fileType(att.type),
      mime: att.mime,
      filename: att.name ?? att.storage_key.split('/').pop() ?? 'file',
      data: await deps.storage.get(att.storage_key),
    });
  }
  return parts;
}

interface SendTarget {
  connector: ChannelConnector;
  account: ResolvedChannelAccount;
  externalUserId: string;
  messageId: string;
  /** Gọi sau mỗi phần gửi thành công (ghi mid để đồng bộ nhận ra bản sao). */
  onSent?: (externalMessageId: string) => Promise<void>;
}

/** Gửi lần lượt từ phần `progress.sent`; tăng progress.sent sau mỗi phần thành công. */
async function sendParts(
  target: SendTarget,
  parts: OutboundPart[],
  tag: SendOptions['tag'],
  progress: { sent: number; externalMessageId?: string },
): Promise<void> {
  for (; progress.sent < parts.length; progress.sent++) {
    const result = await target.connector.send(
      target.account,
      { externalUserId: target.externalUserId },
      parts[progress.sent]!,
      { messageId: target.messageId, ...(tag ? { tag } : {}) },
    );
    progress.externalMessageId ??= result.externalMessageId;
    await target.onSent?.(result.externalMessageId);
  }
}

/**
 * Nền tảng báo ngoài cửa sổ (docs/research §6-7): hội thoại từ quảng cáo thì bỏ giả định 7 ngày
 * (window_source -> organic) và báo UI; trả 'HUMAN_AGENT' nếu tin của nhân viên được gửi lại kèm tag.
 */
async function onOutsideWindow(
  db: Db,
  deps: PipelineDeps,
  row: Context,
  by: 'bot' | 'agent',
  usedTag: SendOptions['tag'],
): Promise<'HUMAN_AGENT' | undefined> {
  const { conversation: conv, account } = row;
  if (conv.windowSource === 'ads') {
    await db
      .update(conversations)
      .set({ windowSource: 'organic', updatedAt: deps.ctx.now() })
      .where(eq(conversations.id, conv.id));
    await emitConversationUpdated(db, deps, conv);
  }
  if (usedTag || by !== 'agent') return undefined;
  const check = canSend(
    {
      channelType: account.type,
      lastCustomerMessageAt: conv.lastCustomerMessageAt,
      windowSource: conv.windowSource === 'ads' ? 'organic' : conv.windowSource,
      firstCustomerMessageAt: null,
    },
    'agent',
    deps.ctx.now(),
    deps.ctx.policy,
  );
  return check.allowed && check.tag === 'HUMAN_AGENT' ? 'HUMAN_AGENT' : undefined;
}

/**
 * Gửi một message status=queued. Thành công: status=sent + external_message_id, phát message.updated.
 * Ném TransientSendError để BullMQ thử lại; PermanentSendError thì đánh dấu failed ngay (và kênh lỗi
 * nếu credentialsInvalid). Bỏ qua nếu message không còn ở trạng thái queued (idempotent).
 * Ném OutboundNotReadyError nếu còn tin trước trong hội thoại đang queued (giữ thứ tự, 1 tin/lần).
 */
export async function processOutboundMessage(db: Db, deps: PipelineDeps, messageId: string): Promise<void> {
  const row = await loadContext(db, messageId);
  if (!row) {
    deps.logger.warn({ messageId }, 'Không tìm thấy tin cần gửi');
    return;
  }
  const { message, conversation: conv, account } = row;
  if (message.status !== 'queued') {
    deps.logger.debug({ messageId, status: message.status }, 'Tin không còn ở trạng thái queued, bỏ qua');
    return;
  }
  if (await hasEarlierQueued(db, message)) throw new OutboundNotReadyError();

  const connector = deps.connectors[account.type];
  if (!connector) {
    return fail(db, deps, messageId, conv, 'Máy chủ chưa cấu hình kết nối cho kênh này');
  }
  if (account.status !== 'connected') {
    return fail(db, deps, messageId, conv, 'Kênh đã mất kết nối, vui lòng kết nối lại trong trang Kênh');
  }
  const resolved = await loadResolvedAccount(db, deps.cipher, account.id);
  if (!resolved) {
    return fail(db, deps, messageId, conv, 'Kênh chưa có thông tin xác thực, vui lòng kết nối lại');
  }

  // Kiểm lại cửa sổ gửi ngay trước khi gửi (tin có thể chờ trong hàng đợi lâu).
  const by = message.senderType === 'bot' ? 'bot' : 'agent';
  const check = canSend(
    {
      channelType: account.type,
      lastCustomerMessageAt: conv.lastCustomerMessageAt,
      windowSource: conv.windowSource,
      firstCustomerMessageAt: await firstCustomerMessageAt(db, conv.id),
    },
    by,
    deps.ctx.now(),
    deps.ctx.policy,
  );
  if (!check.allowed) {
    return fail(db, deps, messageId, conv, check.reason ?? 'Đã hết thời gian được phép trả lời khách');
  }
  // Tag do policy quyết định; tag lưu lúc tạo tin chỉ dùng cho nhân viên (bot không bao giờ có tag).
  const tag = check.tag ?? (by === 'agent' ? rawTag(message.raw) : undefined);

  const target: SendTarget = {
    connector,
    account: resolved,
    externalUserId: row.externalUserId,
    messageId,
    // Lỗi ghi mid chỉ log: tin đã gửi, không được ném để BullMQ gửi lại.
    onSent: (mid) =>
      recordSentExternalId(db, messageId, mid).catch((error: unknown) => {
        deps.logger.warn({ messageId, err: String(error) }, 'Không ghi được mid của phần đã gửi');
      }),
  };
  const progress: { sent: number; externalMessageId?: string } = { sent: 0 };
  try {
    const parts = await buildParts(deps, message.text, message.attachments);
    if (parts.length === 0) throw new PermanentSendError('Tin nhắn rỗng, không có gì để gửi');
    try {
      await sendParts(target, parts, tag, progress);
    } catch (error) {
      if (!(error instanceof PermanentSendError) || error.reason !== 'outside_window') throw error;
      const retryTag = await onOutsideWindow(db, deps, row, by, tag);
      if (!retryTag) throw error;
      deps.logger.info({ messageId }, 'Ngoài cửa sổ: gửi lại kèm tag HUMAN_AGENT');
      await sendParts(target, parts, retryTag, progress);
    }
  } catch (error) {
    if (!(error instanceof PermanentSendError)) throw error; // Transient/khác: để BullMQ thử lại.
    deps.logger.warn(
      { messageId, platformCode: error.platformCode, credentialsInvalid: error.credentialsInvalid },
      'Gửi tin thất bại vĩnh viễn',
    );
    if (error.credentialsInvalid) {
      await db
        .update(channelAccounts)
        .set({ status: 'expired', lastError: error.message })
        .where(eq(channelAccounts.id, account.id));
    }
    return fail(db, deps, messageId, conv, error.message);
  }

  await markSent(db, deps, messageId, conv, progress.externalMessageId);
}

async function markSent(
  db: Db,
  deps: PipelineDeps,
  messageId: string,
  conv: ConvRef,
  externalMessageId: string | undefined,
): Promise<boolean> {
  let changed: boolean;
  try {
    changed = await setStatus(db, messageId, {
      status: 'sent',
      error: null,
      ...(externalMessageId ? { externalMessageId } : {}),
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Đã có tin khác giữ external id này (echo lưu trước): vẫn đánh dấu sent, không gửi lại.
    deps.logger.warn({ messageId }, 'external_message_id đã tồn tại, đánh dấu sent không kèm id');
    changed = await setStatus(db, messageId, { status: 'sent', error: null });
  }
  if (changed) await emitMessageUpdated(db, deps, messageId, conv);
  return changed;
}

/**
 * Echo của chính app mang id message trong metadata: nếu tin còn queued (Send API chậm/timeout,
 * worker chưa kịp ghi kết quả) thì đánh dấu sent + external id ngay, để lần thử lại không gửi trùng.
 * Trả true nếu có cập nhật.
 */
export async function markSentFromEcho(
  db: Db,
  deps: PipelineDeps,
  messageId: string,
  channelAccountId: string,
  externalMessageId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ assignedUserId: conversations.assignedUserId })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.channelAccountId, channelAccountId),
        eq(messages.status, 'queued'),
        outgoing,
      ),
    )
    .limit(1);
  if (!row) return false;
  return markSent(db, deps, messageId, row, externalMessageId);
}

/** Gọi khi hết lượt thử lại: status=failed + error, phát message.updated. */
export async function markOutboundFailed(
  db: Db,
  deps: PipelineDeps,
  messageId: string,
  error: string,
): Promise<void> {
  const [conv] = await db
    .select({ assignedUserId: conversations.assignedUserId })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!conv) return;
  await fail(db, deps, messageId, conv, error);
}
