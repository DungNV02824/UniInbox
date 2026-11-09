import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps } from './_common';
import { aiModeEnum, channelAccountStatusEnum, channelTypeEnum } from './enums';
import { users } from './users';

/**
 * Credentials đã mã hóa AES-256-GCM (encryptJson của @dezon/shared/server).
 * `enc` là chuỗi "v1:iv:tag:ciphertext". Không bao giờ trả về client hay ghi log.
 */
export interface EncryptedCredentials {
  enc: string;
}

/** Một dòng cho mỗi OA, mỗi Fanpage, mỗi tài khoản Zalo cá nhân. */
export const channelAccounts = pgTable(
  'channel_accounts',
  {
    id: id(),
    type: channelTypeEnum('type').notNull(),
    displayName: text('display_name').notNull(),
    /** oa_id / page_id / zalo uid */
    externalId: text('external_id').notNull(),
    /** Bắt buộc với zalo_personal (CHECK). RESTRICT: phải gỡ kênh trước khi xóa user sở hữu. */
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'restrict' }),
    credentials: jsonb('credentials').$type<EncryptedCredentials>(),
    status: channelAccountStatusEnum('status').notNull().default('disconnected'),
    lastError: text('last_error'),
    /** Giai đoạn 1 mặc định 'off'; zalo_personal => 'suggest' do code ứng dụng đặt khi tạo. */
    defaultAiMode: aiModeEnum('default_ai_mode').notNull().default('off'),
    color: text('color').notNull().default('#2563eb'),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('channel_accounts_type_external_id_unique').on(t.type, t.externalId),
    index('channel_accounts_owner_user_id_idx').on(t.ownerUserId),
    check(
      'channel_accounts_zalo_personal_owner',
      sql`${t.type} <> 'zalo_personal' OR ${t.ownerUserId} IS NOT NULL`,
    ),
  ],
);
