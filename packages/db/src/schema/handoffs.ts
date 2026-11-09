import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, tstz } from './_common';
import { conversations } from './conversations';
import { handoffReasonCodeEnum } from './enums';
import { users } from './users';

export const HANDOFF_CREATORS = ['ai', 'user'] as const;
export type HandoffCreator = (typeof HANDOFF_CREATORS)[number];

/**
 * Đặc tả: created_by ('ai' | user_id). Tách thành created_by ('ai'|'user') + created_by_user_id
 * để giữ FK thật và không nhầm "AI tạo" với "user đã bị xóa".
 */
export const handoffs = pgTable(
  'handoffs',
  {
    id: id(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    reasonCode: handoffReasonCodeEnum('reason_code').notNull(),
    summary: text('summary').notNull(),
    createdBy: text('created_by').$type<HandoffCreator>().notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    acknowledgedBy: uuid('acknowledged_by').references(() => users.id, { onDelete: 'set null' }),
    acknowledgedAt: tstz('acknowledged_at'),
    resolvedAt: tstz('resolved_at'),
    ...timestamps(),
  },
  (t) => [
    index('handoffs_conversation_id_idx').on(t.conversationId),
    check('handoffs_created_by_valid', sql`${t.createdBy} IN ('ai', 'user')`),
    check('handoffs_ai_has_no_user', sql`${t.createdBy} <> 'ai' OR ${t.createdByUserId} IS NULL`),
  ],
);
