import type * as s from './schema';

export * from './schema';
export * as schema from './schema';
export { createDb, type Db, type DbHandle, type CreateDbOptions, type Schema } from './client';
export { runMigrations, rollbackMigrations, MIGRATIONS_FOLDER, DOWN_MIGRATIONS_FOLDER } from './migrate';
export { hashPassword, verifyPassword } from './passwords';
export {
  seedUsers,
  normalizeEmail,
  type SeedUserInput,
  type SeedUsersInput,
  type SeedUsersOptions,
  type SeededUser,
} from './seed';

// Kiểu dòng (select) và kiểu chèn (insert) cho từng bảng.
export type User = typeof s.users.$inferSelect;
export type NewUser = typeof s.users.$inferInsert;
export type ChannelAccount = typeof s.channelAccounts.$inferSelect;
export type NewChannelAccount = typeof s.channelAccounts.$inferInsert;
export type Contact = typeof s.contacts.$inferSelect;
export type NewContact = typeof s.contacts.$inferInsert;
export type ContactIdentity = typeof s.contactIdentities.$inferSelect;
export type NewContactIdentity = typeof s.contactIdentities.$inferInsert;
export type Conversation = typeof s.conversations.$inferSelect;
export type NewConversation = typeof s.conversations.$inferInsert;
export type Message = typeof s.messages.$inferSelect;
export type NewMessage = typeof s.messages.$inferInsert;
export type AiSuggestion = typeof s.aiSuggestions.$inferSelect;
export type NewAiSuggestion = typeof s.aiSuggestions.$inferInsert;
export type AiRun = typeof s.aiRuns.$inferSelect;
export type NewAiRun = typeof s.aiRuns.$inferInsert;
export type Handoff = typeof s.handoffs.$inferSelect;
export type NewHandoff = typeof s.handoffs.$inferInsert;
export type CustomerMemory = typeof s.customerMemories.$inferSelect;
export type NewCustomerMemory = typeof s.customerMemories.$inferInsert;
export type KnowledgeDocument = typeof s.knowledgeDocuments.$inferSelect;
export type NewKnowledgeDocument = typeof s.knowledgeDocuments.$inferInsert;
export type KnowledgeChunk = typeof s.knowledgeChunks.$inferSelect;
export type NewKnowledgeChunk = typeof s.knowledgeChunks.$inferInsert;
export type StyleExample = typeof s.styleExamples.$inferSelect;
export type NewStyleExample = typeof s.styleExamples.$inferInsert;
export type CatalogItem = typeof s.catalogItems.$inferSelect;
export type NewCatalogItem = typeof s.catalogItems.$inferInsert;
export type AuditLog = typeof s.auditLogs.$inferSelect;
export type NewAuditLog = typeof s.auditLogs.$inferInsert;
