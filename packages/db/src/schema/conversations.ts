import { index, integer, pgTable, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, tstz } from './_common';
import { channelAccounts } from './channel-accounts';
import { contactIdentities, contacts } from './contacts';
import { aiModeEnum, conversationStatusEnum, handoffReasonCodeEnum, windowSourceEnum } from './enums';
import { users } from './users';

/** Một luồng chat = một identity × một channel_account (unique theo contact_identity_id). */
export const conversations = pgTable(
  'conversations',
  {
    id: id(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    channelAccountId: uuid('channel_account_id')
      .notNull()
      .references(() => channelAccounts.id, { onDelete: 'restrict' }),
    contactIdentityId: uuid('contact_identity_id')
      .notNull()
      .references(() => contactIdentities.id, { onDelete: 'cascade' }),
    status: conversationStatusEnum('status').notNull().default('open'),
    aiMode: aiModeEnum('ai_mode').notNull().default('off'),
    aiPausedUntil: tstz('ai_paused_until'),
    assignedUserId: uuid('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Dùng để tính cửa sổ gửi (6.5). */
    lastCustomerMessageAt: tstz('last_customer_message_at'),
    lastMessageAt: tstz('last_message_at'),
    unreadCount: integer('unread_count').notNull().default(0),
    /** Chỉ dùng cho Messenger. */
    windowSource: windowSourceEnum('window_source'),
    handoffReason: handoffReasonCodeEnum('handoff_reason'),
    handoffAt: tstz('handoff_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('conversations_contact_identity_unique').on(t.contactIdentityId),
    /** Đích của FK ghép messages(conversation_id, channel_account_id). */
    unique('conversations_id_channel_account_unique').on(t.id, t.channelAccountId),
    index('conversations_channel_last_message_idx').on(t.channelAccountId, t.lastMessageAt),
    index('conversations_status_idx').on(t.status),
    index('conversations_assigned_user_id_idx').on(t.assignedUserId),
    index('conversations_contact_id_idx').on(t.contactId),
  ],
);
