import { EMBEDDING_DIM } from '@dezon/shared';
import { boolean, index, integer, pgTable, text, uniqueIndex, uuid, vector } from 'drizzle-orm/pg-core';
import { emptyTextArray, id, timestamps } from './_common';
import { knowledgeSourceTypeEnum } from './enums';
import { users } from './users';

export const knowledgeDocuments = pgTable('knowledge_documents', {
  id: id(),
  title: text('title').notNull(),
  sourceType: knowledgeSourceTypeEnum('source_type').notNull(),
  sourceRef: text('source_ref'),
  contentMd: text('content_md').notNull().default(''),
  isActive: boolean('is_active').notNull().default(true),
  tags: text('tags').array().notNull().default(emptyTextArray),
  ...timestamps(),
});

export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: id(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    /** NULL cho tới khi job embedding chạy xong. */
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }),
    tokens: integer('tokens').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('knowledge_chunks_document_chunk_unique').on(t.documentId, t.chunkIndex),
    index('knowledge_chunks_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

/** Mẫu hội thoại hay của đội sale (7.7). Chỉ dùng khi đã duyệt và is_active. */
export const styleExamples = pgTable(
  'style_examples',
  {
    id: id(),
    customerText: text('customer_text').notNull(),
    agentReply: text('agent_reply').notNull(),
    situationTag: text('situation_tag'),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }),
    /** NULL = chưa duyệt. */
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    isActive: boolean('is_active').notNull().default(false),
    ...timestamps(),
  },
  (t) => [index('style_examples_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops'))],
);
