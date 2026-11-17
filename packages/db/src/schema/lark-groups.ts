import { index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { chatbots } from './chatbots';
import { id, timestamps } from './_common';

/**
 * "Nhóm Lark theo chatbot" (Cài đặt → Thông báo Lark): mỗi nhóm một Webhook bot Lark (+ secret mã hóa). Thông báo
 * (chuyển người, nhắc lại, nút banner, báo nhân viên…) của hội thoại gắn chatbot X ⇒ gửi vào MỌI nhóm có X; X không
 * thuộc nhóm nào ⇒ gửi nhóm chung (app_settings.lark) như trước. Không gửi cả hai.
 */
export const larkGroups = pgTable('lark_groups', {
  id: id(),
  name: text('name').notNull(),
  webhookUrl: text('webhook_url').notNull(),
  /** Secret ký tin, mã hóa bằng CredentialsCipher (như app_settings.lark.secretEnc); null = không ký. */
  secretEnc: text('secret_enc'),
  ...timestamps(),
});

/** Chatbot gắn vào nhóm Lark (nhiều–nhiều). Xóa nhóm / xóa bot ⇒ xóa dòng gắn. */
export const larkGroupChatbots = pgTable(
  'lark_group_chatbots',
  {
    larkGroupId: uuid('lark_group_id')
      .notNull()
      .references(() => larkGroups.id, { onDelete: 'cascade' }),
    chatbotId: uuid('chatbot_id')
      .notNull()
      .references(() => chatbots.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.larkGroupId, t.chatbotId] }),
    index('lark_group_chatbots_chatbot_idx').on(t.chatbotId),
  ],
);
