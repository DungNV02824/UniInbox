import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps } from './_common';
import { contacts } from './contacts';
import { messages } from './messages';

export const CUSTOMER_MEMORY_SUMMARY_MAX = 1200;

/** Hồ sơ dài hạn, mỗi contact một dòng (7.6). Schema chi tiết của `facts` làm ở Giai đoạn 3. */
export const customerMemories = pgTable(
  'customer_memories',
  {
    id: id(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    summary: text('summary').notNull().default(''),
    facts: jsonb('facts').$type<Record<string, unknown>>().notNull().default({}),
    updatedFromMessageId: uuid('updated_from_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    version: integer('version').notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('customer_memories_contact_id_unique').on(t.contactId),
    check('customer_memories_summary_length', sql`char_length(${t.summary}) <= 1200`),
  ],
);
