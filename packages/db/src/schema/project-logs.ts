import { index, jsonb, pgTable, uuid } from 'drizzle-orm/pg-core';
import { aiRuns } from './ai';
import { chatbots } from './chatbots';
import { conversations } from './conversations';
import { id, timestamps } from './_common';

/** Một trường của dòng nhật ký (project_logs.fields), theo thứ tự cấu hình lúc ghi. */
export interface ProjectLogField {
  key: string;
  label: string;
  value: string;
}

/**
 * "Nhật ký công trình": AI ghi một dòng khi bot xác nhận tiếp nhận một công trình người nhắn gửi (bot bật
 * capture.projectLog). message_ids = tin khách của lượt đó + tin bot trả lời; anchor_message_id = tin để cuộn tới.
 * Không FK tới messages (mảng uuid) — tin bị xóa thì web bỏ qua id không thấy.
 */
export const projectLogs = pgTable(
  'project_logs',
  {
    id: id(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    chatbotId: uuid('chatbot_id').references(() => chatbots.id, { onDelete: 'set null' }),
    aiRunId: uuid('ai_run_id').references(() => aiRuns.id, { onDelete: 'set null' }),
    fields: jsonb('fields').$type<ProjectLogField[]>().notNull().default([]),
    messageIds: uuid('message_ids').array().notNull().default([]),
    anchorMessageId: uuid('anchor_message_id'),
    ...timestamps(),
  },
  (t) => [index('project_logs_conversation_created_idx').on(t.conversationId, t.createdAt)],
);
