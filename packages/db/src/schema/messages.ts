import type { MessageAttachment } from '@dezon/shared';
import {
  type AnyPgColumn,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { id, timestamps, tstz } from './_common';
import { aiRuns } from './ai';
import { channelAccounts } from './channel-accounts';
import { conversations } from './conversations';
import { messageStatusEnum, senderTypeEnum } from './enums';
import { users } from './users';

export const messages = pgTable(
  'messages',
  {
    id: id(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /**
     * Bổ sung so với đặc tả: để unique(channel_account_id, external_message_id) là index thật.
     * FK ghép bên dưới buộc giá trị này trùng với conversations.channel_account_id.
     */
    channelAccountId: uuid('channel_account_id')
      .notNull()
      .references(() => channelAccounts.id, { onDelete: 'restrict' }),
    senderType: senderTypeEnum('sender_type').notNull(),
    /** Khi sender_type = 'agent'. */
    senderUserId: uuid('sender_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Chống trùng webhook. NULL khi tin chưa lên nền tảng (NULL không vi phạm unique). */
    externalMessageId: text('external_message_id'),
    text: text('text'),
    attachments: jsonb('attachments').$type<MessageAttachment[]>().notNull().default([]),
    status: messageStatusEnum('status').notNull().default('received'),
    error: text('error'),
    aiRunId: uuid('ai_run_id').references(() => aiRuns.id, { onDelete: 'set null' }),
    replyToMessageId: uuid('reply_to_message_id').references((): AnyPgColumn => messages.id, {
      onDelete: 'set null',
    }),
    /**
     * Bổ sung so với đặc tả: clientId của request gửi tin (web sinh), lưu trên mọi phần của một lần
     * gửi để "Gửi lại" sau khi mất phản hồi không tạo bản thứ hai. NULL với tin đến / echo.
     */
    clientId: varchar('client_id', { length: 100 }),
    /** Payload gốc; job sẽ set NULL sau 90 ngày. */
    raw: jsonb('raw').$type<unknown>(),
    /** Thời điểm theo nền tảng. */
    sentAt: tstz('sent_at').notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('messages_channel_external_id_unique').on(t.channelAccountId, t.externalMessageId),
    index('messages_conversation_sent_at_idx').on(t.conversationId, t.sentAt),
    // Không unique: một lần gửi có thể tách nhiều phần cùng clientId; chống trùng nhờ khóa dòng hội thoại.
    index('messages_conversation_client_id_idx')
      .on(t.conversationId, t.clientId)
      .where(sql`${t.clientId} IS NOT NULL`),
    foreignKey({
      name: 'messages_conversation_channel_account_fk',
      columns: [t.conversationId, t.channelAccountId],
      foreignColumns: [conversations.id, conversations.channelAccountId],
    }).onDelete('cascade'),
  ],
);
