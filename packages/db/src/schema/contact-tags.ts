import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { TagColor } from '@dezon/shared';
import { id, timestamps } from './_common';
import { users } from './users';

/**
 * Danh sách nhãn khách hàng do admin quản lý (tên + màu). contacts.tags vẫn lưu TÊN nhãn (text[]);
 * PATCH /contacts/:id chỉ cho thêm nhãn có trong bảng này. Tên unique không phân biệt hoa thường.
 */
export const contactTags = pgTable(
  'contact_tags',
  {
    id: id(),
    name: text('name').notNull(),
    /** TAG_COLORS của @dezon/shared. */
    color: text('color').$type<TagColor>().notNull().default('blue'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('contact_tags_name_lower_unique').on(sql`lower(${t.name})`),
    check(
      'contact_tags_color_check',
      sql`${t.color} IN ('gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink')`,
    ),
  ],
);
