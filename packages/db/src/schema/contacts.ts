import { index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { emptyTextArray, id, timestamps } from './_common';
import { channelAccounts } from './channel-accounts';

/** Một người khách; có thể có nhiều danh tính trên nhiều kênh. */
export const contacts = pgTable(
  'contacts',
  {
    id: id(),
    displayName: text('display_name').notNull(),
    phone: text('phone'),
    email: text('email'),
    avatarUrl: text('avatar_url'),
    tags: text('tags').array().notNull().default(emptyTextArray),
    notes: text('notes'),
    ...timestamps(),
  },
  // Dùng để gộp danh tính theo số điện thoại (7.6).
  (t) => [index('contacts_phone_idx').on(t.phone)],
);

/** Danh tính của khách trên một kênh cụ thể (Zalo user_id theo OA / PSID / uid Zalo). */
export const contactIdentities = pgTable(
  'contact_identities',
  {
    id: id(),
    // CASCADE: xóa khách => xóa mọi danh tính (mục 11).
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    // RESTRICT: không xóa kênh khi còn dữ liệu hội thoại (quy tắc 7) — ngắt kết nối bằng status.
    channelAccountId: uuid('channel_account_id')
      .notNull()
      .references(() => channelAccounts.id, { onDelete: 'restrict' }),
    externalUserId: text('external_user_id').notNull(),
    profile: jsonb('profile').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('contact_identities_channel_external_user_unique').on(t.channelAccountId, t.externalUserId),
    index('contact_identities_contact_id_idx').on(t.contactId),
  ],
);
