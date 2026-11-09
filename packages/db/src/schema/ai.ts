import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps } from './_common';
import { conversations } from './conversations';
import { aiRunDecisionEnum, aiSuggestionStatusEnum } from './enums';

/** Log mỗi lần AI xử lý (debug + đánh giá). */
export const aiRuns = pgTable(
  'ai_runs',
  {
    id: id(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** id các tin khách kích hoạt lần chạy (mảng nên không có FK). */
    triggerMessageIds: uuid('trigger_message_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    decision: aiRunDecisionEnum('decision').notNull(),
    toolCalls: jsonb('tool_calls').$type<unknown[]>().notNull().default([]),
    reasoningSummary: text('reasoning_summary'),
    error: text('error'),
    ...timestamps(),
  },
  (t) => [index('ai_runs_conversation_created_idx').on(t.conversationId, t.createdAt)],
);

/** Bản nháp AI cho chế độ `suggest`. */
export const aiSuggestions = pgTable(
  'ai_suggestions',
  {
    id: id(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    aiRunId: uuid('ai_run_id')
      .notNull()
      .references(() => aiRuns.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    status: aiSuggestionStatusEnum('status').notNull().default('pending'),
    ...timestamps(),
  },
  (t) => [
    index('ai_suggestions_conversation_id_idx').on(t.conversationId),
    index('ai_suggestions_ai_run_id_idx').on(t.aiRunId),
  ],
);
