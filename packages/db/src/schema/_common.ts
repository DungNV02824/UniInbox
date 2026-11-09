import { sql } from 'drizzle-orm';
import { timestamp, uuid } from 'drizzle-orm/pg-core';

/** Khóa chính chuẩn: uuid sinh bởi Postgres. */
export const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);

/** created_at / updated_at bắt buộc cho mọi bảng (mục 5). */
export const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** Cột timestamptz (mặc định cho phép NULL). */
export const tstz = (name: string) => timestamp(name, { withTimezone: true });

/** Giá trị mặc định '{}' cho cột mảng text. */
export const emptyTextArray = sql`'{}'::text[]`;
