import { jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps } from './_common';
import { users } from './users';

/**
 * Cài đặt toàn hệ thống dạng key/value (jsonb). Khóa đang dùng:
 * - `business_hours`: { timezone, days: { mon..sun: [{ start: 'HH:MM', end: 'HH:MM' }] } }
 * - `lark`: { webhookUrl: string|null, secretEnc: string|null } (secret mã hóa, không trả client)
 * - `ai`: { enabled: boolean } (công tắc AI tổng)
 * Không có cột id (khóa chính là `key`).
 */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps(),
});

export const APP_SETTING_KEYS = ['business_hours', 'lark', 'ai'] as const;
export type AppSettingKey = (typeof APP_SETTING_KEYS)[number];
