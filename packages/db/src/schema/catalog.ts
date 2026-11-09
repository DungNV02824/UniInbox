import { EMBEDDING_DIM } from '@dezon/shared';
import { bigint, index, pgTable, text, uniqueIndex, vector } from 'drizzle-orm/pg-core';
import { emptyTextArray, id, timestamps, tstz } from './_common';

/** Bản đệm dữ liệu từ dezon.vn, đồng bộ định kỳ (7.5). Giá tính bằng VND. */
export const catalogItems = pgTable(
  'catalog_items',
  {
    id: id(),
    externalId: text('external_id').notNull(),
    sku: text('sku'),
    name: text('name').notNull(),
    url: text('url').notNull(),
    category: text('category'),
    tags: text('tags').array().notNull().default(emptyTextArray),
    priceText: text('price_text'),
    priceMin: bigint('price_min', { mode: 'number' }),
    priceMax: bigint('price_max', { mode: 'number' }),
    availability: text('availability').notNull().default('unknown'),
    imageUrls: text('image_urls').array().notNull().default(emptyTextArray),
    /** AI mô tả sẵn, cùng thứ tự với image_urls. */
    imageCaptions: text('image_captions').array().notNull().default(emptyTextArray),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }),
    syncedAt: tstz('synced_at').notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('catalog_items_external_id_unique').on(t.externalId),
    index('catalog_items_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);
