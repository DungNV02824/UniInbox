import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps } from './_common';
import { users } from './users';

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    /** text để chứa cả id không phải uuid (vd. id phía nền tảng). */
    entityId: text('entity_id'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps(),
  },
  (t) => [
    index('audit_logs_entity_idx').on(t.entity, t.entityId),
    index('audit_logs_user_id_idx').on(t.userId),
    index('audit_logs_created_at_idx').on(t.createdAt),
  ],
);
