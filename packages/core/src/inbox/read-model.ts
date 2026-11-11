// Truy vấn dùng chung cho phần đọc/ghi hộp thư: ghép summary, message, contact detail thành DTO.
// Một truy vấn cho cả danh sách (tin cuối và tin đầu của khách lấy bằng subquery tương quan) — không N+1.
import {
  aiRuns,
  channelAccounts,
  chatbots,
  contactIdentities,
  contacts,
  conversations,
  messages,
  users,
  type Schema,
} from '@dezon/db';
import type {
  ChannelBadge,
  ContactDetail,
  ConversationHandoff,
  ConversationSummary,
  HandoffReasonCode,
  LastMessagePreview,
  MessageAttachment,
  MessageAttachmentDto,
  MessageDto,
  SenderType,
  AttachmentType,
} from '@dezon/shared';
import { asc, eq, sql, type SQL } from 'drizzle-orm';
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { firstCustomerMessageAtSql } from '../pipeline/window-anchor';
import { sendWindowInfo } from '../policy';
import type { InboxContext } from './types';

/** Db hoặc transaction. */
export type DbLike = PgDatabase<NodePgQueryResultHKT, Schema>;

/** Nhãn cho tin echo của nhân viên gửi từ công cụ của nền tảng (không qua hệ thống). */
export const ECHO_SENDER_LABEL = 'Meta Business Suite';

/** Thời điểm dạng ISO micro giây (UTC) — dùng làm cursor để so sánh chính xác với Postgres. */
const isoMicros = (col: SQL | typeof conversations.lastMessageAt | typeof messages.sentAt) =>
  sql<string | null>`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

// Viết tên bảng tường minh trong subquery để không bị nhầm với cột của bảng `m`.
const lastMessageSql = sql<unknown>`(
  select json_build_object(
    'text', m.text,
    'senderType', m.sender_type,
    'hasAttachments', jsonb_array_length(m.attachments) > 0,
    'senderUserId', m.sender_user_id,
    'attachmentType', m.attachments->0->>'type',
    'sentAt', m.sent_at
  )
  from ${messages} m
  where m.conversation_id = "conversations"."id"
  order by m.sent_at desc, m.id desc
  limit 1
)`;

/** Handoff đang mở mới nhất (resolved_at null) kèm người đã "Nhận xử lý". */
const openHandoffSql = sql<unknown>`(
  select json_build_object(
    'reasonCode', h.reason_code,
    'summary', h.summary,
    'at', h.created_at,
    'ackId', h.acknowledged_by,
    'ackName', u.name
  )
  from "handoffs" h
  left join "users" u on u.id = h.acknowledged_by
  where h.conversation_id = "conversations"."id" and h.resolved_at is null
  order by h.created_at desc
  limit 1
)`;

/** Chỉ tính cho hội thoại từ quảng cáo (chỉ ở đó cửa sổ phụ thuộc tin đầu tiên). */
const firstCustomerMessageSql =
  sql`case when "conversations"."window_source" = 'ads' then ${firstCustomerMessageAtSql(
    sql`"conversations"."id"`,
  )} end`.mapWith(conversations.lastMessageAt);

const summaryFields = {
  id: conversations.id,
  status: conversations.status,
  aiMode: conversations.aiMode,
  assignedUserId: conversations.assignedUserId,
  assigneeName: users.name,
  unreadCount: conversations.unreadCount,
  lastMessageAt: conversations.lastMessageAt,
  lastCustomerMessageAt: conversations.lastCustomerMessageAt,
  windowSource: conversations.windowSource,
  cursorT: isoMicros(conversations.lastMessageAt),
  contactId: contacts.id,
  contactName: contacts.displayName,
  contactAvatar: contacts.avatarUrl,
  contactTags: contacts.tags,
  channelId: channelAccounts.id,
  channelType: channelAccounts.type,
  channelName: channelAccounts.displayName,
  channelColor: channelAccounts.color,
  channelStatus: channelAccounts.status,
  lastMessage: lastMessageSql,
  firstCustomerMessageAt: firstCustomerMessageSql,
  aiPausedUntil: conversations.aiPausedUntil,
  chatbotId: conversations.chatbotId,
  chatbotName: chatbots.name,
  chatbotAckLabel: chatbots.handoffAckLabel,
  chatbotResolveLabel: chatbots.handoffResolveLabel,
  chatbotAiHandoffMode: chatbots.aiHandoffMode,
  handoff: openHandoffSql,
};

export interface SummaryQueryOptions {
  orderBy?: SQL[];
  limit?: number;
}

export function selectSummaryRows(db: DbLike, where: SQL | undefined, opts: SummaryQueryOptions = {}) {
  const q = db
    .select(summaryFields)
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .innerJoin(channelAccounts, eq(channelAccounts.id, conversations.channelAccountId))
    .leftJoin(users, eq(users.id, conversations.assignedUserId))
    .leftJoin(chatbots, eq(chatbots.id, conversations.chatbotId))
    .where(where)
    .orderBy(...(opts.orderBy ?? []))
    .$dynamic();
  return opts.limit !== undefined ? q.limit(opts.limit) : q;
}

export type SummaryRow = Awaited<ReturnType<typeof selectSummaryRows>>[number];

/** URL ký của avatar (cột lưu storage key; URL http cũ thì trả nguyên). */
export async function signAvatar(value: string | null, ctx: InboxContext): Promise<string | null> {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return ctx.signUrl(value);
}

function parseLastMessage(value: unknown): LastMessagePreview | null {
  const v = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!v || typeof v !== 'object') return null;
  const o = v as {
    text: string | null;
    senderType: SenderType;
    hasAttachments: boolean;
    senderUserId: string | null;
    attachmentType: AttachmentType | null;
    sentAt: string;
  };
  return {
    text: o.text,
    senderType: o.senderType,
    hasAttachments: Boolean(o.hasAttachments),
    senderUserId: o.senderUserId ?? null,
    attachmentType: o.attachmentType ?? null,
    sentAt: new Date(o.sentAt).toISOString(),
  };
}

function parseHandoff(value: unknown): ConversationHandoff | null {
  const v = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!v || typeof v !== 'object') return null;
  const o = v as {
    reasonCode: HandoffReasonCode;
    summary: string;
    at: string;
    ackId: string | null;
    ackName: string | null;
  };
  return {
    reasonCode: o.reasonCode,
    summary: o.summary,
    at: new Date(o.at).toISOString(),
    acknowledgedBy: o.ackId && o.ackName ? { id: o.ackId, name: o.ackName } : null,
  };
}

export async function toSummary(row: SummaryRow, ctx: InboxContext): Promise<ConversationSummary> {
  const channel: ChannelBadge = {
    id: row.channelId,
    type: row.channelType,
    displayName: row.channelName,
    color: row.channelColor,
    status: row.channelStatus,
  };
  return {
    id: row.id,
    status: row.status,
    aiMode: row.aiMode,
    assignedUser:
      row.assignedUserId && row.assigneeName ? { id: row.assignedUserId, name: row.assigneeName } : null,
    unreadCount: row.unreadCount,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    lastCustomerMessageAt: row.lastCustomerMessageAt?.toISOString() ?? null,
    windowSource: row.windowSource,
    lastMessage: parseLastMessage(row.lastMessage),
    contact: {
      id: row.contactId,
      displayName: row.contactName,
      avatarUrl: await signAvatar(row.contactAvatar, ctx),
      tags: row.contactTags ?? [],
    },
    channel,
    sendWindow: sendWindowInfo(
      {
        channelType: row.channelType,
        lastCustomerMessageAt: row.lastCustomerMessageAt,
        windowSource: row.windowSource,
        firstCustomerMessageAt: row.firstCustomerMessageAt as Date | null,
      },
      ctx.now(),
      ctx.policy,
    ),
    chatbot:
      row.chatbotId && row.chatbotName
        ? {
            id: row.chatbotId,
            name: row.chatbotName,
            // Chỉ kèm khi bot đặt tên nút riêng (bot thường giữ nguyên dạng { id, name }).
            ...(row.chatbotAckLabel ? { handoffAckLabel: row.chatbotAckLabel } : {}),
            ...(row.chatbotResolveLabel ? { handoffResolveLabel: row.chatbotResolveLabel } : {}),
            // Bot vẫn trả lời sau khi AI tự chuyển người (banner Cần người ghi rõ). Chỉ kèm khi true.
            ...(row.chatbotAiHandoffMode === 'continue' ? { aiHandoffContinues: true } : {}),
          }
        : null,
    aiPausedUntil:
      row.aiPausedUntil && row.aiPausedUntil > ctx.now() ? row.aiPausedUntil.toISOString() : null,
    handoff: parseHandoff(row.handoff),
  };
}

/** Summary theo id, null nếu không có. */
export async function loadSummary(
  db: DbLike,
  conversationId: string,
  ctx: InboxContext,
): Promise<ConversationSummary | null> {
  const [row] = await selectSummaryRows(db, eq(conversations.id, conversationId));
  return row ? toSummary(row, ctx) : null;
}

// ---------- Tin nhắn ----------

const messageFields = {
  id: messages.id,
  conversationId: messages.conversationId,
  senderType: messages.senderType,
  senderUserId: messages.senderUserId,
  senderUserName: users.name,
  text: messages.text,
  attachments: messages.attachments,
  status: messages.status,
  error: messages.error,
  sentAt: messages.sentAt,
  createdAt: messages.createdAt,
  channelType: channelAccounts.type,
  /** Tên bot của lần chạy AI đã tạo tin (sender_type 'bot'). */
  botName: chatbots.name,
  /** Tin do hệ thống tạo khi nhân viên gửi (raw.outbound) — phân biệt với echo từ công cụ ngoài. */
  fromInbox: sql<boolean>`("messages"."raw" -> 'outbound') is not null`,
  cursorT: isoMicros(messages.sentAt),
};

export function selectMessageRows(db: DbLike, where: SQL | undefined, orderBy: SQL[], limit?: number) {
  const q = db
    .select(messageFields)
    .from(messages)
    .innerJoin(channelAccounts, eq(channelAccounts.id, messages.channelAccountId))
    .leftJoin(users, eq(users.id, messages.senderUserId))
    .leftJoin(aiRuns, eq(aiRuns.id, messages.aiRunId))
    .leftJoin(chatbots, eq(chatbots.id, aiRuns.chatbotId))
    .where(where)
    .orderBy(...orderBy)
    .$dynamic();
  return limit !== undefined ? q.limit(limit) : q;
}

export type MessageRow = Awaited<ReturnType<typeof selectMessageRows>>[number];

async function toAttachmentDto(a: MessageAttachment, ctx: InboxContext): Promise<MessageAttachmentDto> {
  return {
    type: a.type,
    mime: a.mime,
    url: a.storage_key ? await ctx.signUrl(a.storage_key) : null,
    ...(a.width !== undefined ? { width: a.width } : {}),
    ...(a.height !== undefined ? { height: a.height } : {}),
    ...(a.name !== undefined ? { name: a.name } : {}),
  };
}

/** Nhãn tin bot khi không biết tên bot (bot đã xóa / tin không gắn lần chạy). */
export const BOT_FALLBACK_LABEL = 'AI';

function senderLabel(row: MessageRow): string | null {
  if (row.senderType === 'bot') return row.botName ?? BOT_FALLBACK_LABEL;
  if (row.senderType !== 'agent' || row.senderUserId || row.fromInbox) return null;
  return row.channelType === 'messenger' ? ECHO_SENDER_LABEL : null;
}

export async function toMessageDto(row: MessageRow, ctx: InboxContext): Promise<MessageDto> {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderType: row.senderType,
    senderUser:
      row.senderUserId && row.senderUserName ? { id: row.senderUserId, name: row.senderUserName } : null,
    senderLabel: senderLabel(row),
    text: row.text,
    attachments: await Promise.all((row.attachments ?? []).map((a) => toAttachmentDto(a, ctx))),
    status: row.status,
    error: row.error,
    sentAt: row.sentAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------- Khách ----------

export async function loadContactDetail(
  db: DbLike,
  contactId: string,
  ctx: InboxContext,
): Promise<ContactDetail | null> {
  const [contact] = await db.select().from(contacts).where(eq(contacts.id, contactId));
  if (!contact) return null;
  const identities = await db
    .select({
      id: contactIdentities.id,
      externalUserId: contactIdentities.externalUserId,
      conversationId: conversations.id,
      channelId: channelAccounts.id,
      channelType: channelAccounts.type,
      channelName: channelAccounts.displayName,
      channelColor: channelAccounts.color,
      channelStatus: channelAccounts.status,
    })
    .from(contactIdentities)
    .innerJoin(channelAccounts, eq(channelAccounts.id, contactIdentities.channelAccountId))
    .leftJoin(conversations, eq(conversations.contactIdentityId, contactIdentities.id))
    .where(eq(contactIdentities.contactId, contactId))
    .orderBy(asc(contactIdentities.createdAt), asc(contactIdentities.id));

  return {
    id: contact.id,
    displayName: contact.displayName,
    avatarUrl: await signAvatar(contact.avatarUrl, ctx),
    phone: contact.phone,
    email: contact.email,
    tags: contact.tags,
    notes: contact.notes,
    identities: identities.map((i) => ({
      id: i.id,
      externalUserId: i.externalUserId,
      conversationId: i.conversationId,
      channel: {
        id: i.channelId,
        type: i.channelType,
        displayName: i.channelName,
        color: i.channelColor,
        status: i.channelStatus,
      },
    })),
  };
}
