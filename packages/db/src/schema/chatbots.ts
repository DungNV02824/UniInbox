import { sql } from 'drizzle-orm';
import { boolean, check, integer, jsonb, pgTable, real, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { ResponseSpeed } from '@dezon/shared';
import { emptyTextArray, id, timestamps } from './_common';
import { users } from './users';

/** Một cặp hỏi/đáp mẫu do chủ sản phẩm viết cho bot. */
export interface ChatbotExample {
  customer: string;
  reply: string;
}

/**
 * Chatbot do chủ sản phẩm tự soạn (hướng dẫn + kiến thức + ví dụ), gắn vào từng hội thoại
 * (conversations.chatbot_id) hoặc làm mặc định cho kênh (channel_accounts.default_chatbot_id).
 */
export const chatbots = pgTable(
  'chatbots',
  {
    id: id(),
    name: text('name').notNull(),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    /** Hướng dẫn / giọng văn / quy tắc. */
    instructions: text('instructions').notNull().default(''),
    /** Kiến thức tự do (≤ ~100.000 ký tự, kiểm ở tầng Zod), đưa thẳng vào prompt. */
    knowledge: text('knowledge').notNull().default(''),
    examples: jsonb('examples').$type<ChatbotExample[]>().notNull().default([]),
    /** So khớp không dấu, không phân biệt hoa thường. */
    handoffKeywords: text('handoff_keywords').array().notNull().default(emptyTextArray),
    /** null = im lặng khi chuyển người (mặc định). */
    handoffMessage: text('handoff_message'),
    /** null = dùng GEMINI_MODEL. */
    model: text('model'),
    temperature: real('temperature').notNull().default(0.4),
    replyDelaySec: integer('reply_delay_sec').notNull().default(10),
    maxWaitSec: integer('max_wait_sec').notNull().default(45),
    maxRepliesPerHour: integer('max_replies_per_hour').notNull().default(20),
    /** true = bot không chắc (confidence thấp) thì chuyển người; false = vẫn trả lời. */
    escalateWhenUnsure: boolean('escalate_when_unsure').notNull().default(true),
    /** "Tốc độ trả lời" = mức suy nghĩ của Gemini ('fast' | 'balanced' | 'thorough', RESPONSE_SPEEDS). */
    responseSpeed: text('response_speed').$type<ResponseSpeed>().notNull().default('fast'),
    /** Tên nút "nhận" trên banner Cần người; null = "Nhận xử lý" (vd. "Nghiệm thu"). */
    handoffAckLabel: text('handoff_ack_label'),
    /** Tên nút "xong" trên banner Cần người; null = "Đã xong, trả lại cho AI" (vd. "Đã chuyển tiền"). */
    handoffResolveLabel: text('handoff_resolve_label'),
    /** true = bấm hai nút trên thì gửi thông báo Lark (kèm tóm tắt yêu cầu chuyển người). */
    handoffActionLark: boolean('handoff_action_lark').notNull().default(false),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('chatbots_name_unique').on(t.name),
    check('chatbots_name_length', sql`char_length(${t.name}) BETWEEN 1 AND 100`),
    check('chatbots_response_speed_check', sql`${t.responseSpeed} IN ('fast', 'balanced', 'thorough')`),
  ],
);
