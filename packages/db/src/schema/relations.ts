import { relations } from 'drizzle-orm';
import { aiRuns, aiSuggestions } from './ai';
import { channelAccounts } from './channel-accounts';
import { contactIdentities, contacts } from './contacts';
import { conversations } from './conversations';
import { customerMemories } from './customer-memories';
import { handoffs } from './handoffs';
import { knowledgeChunks, knowledgeDocuments } from './knowledge';
import { messages } from './messages';
import { users } from './users';

// Quan hệ cho query API của Drizzle (db.query.*). Không ảnh hưởng tới migration.

export const usersRelations = relations(users, ({ many }) => ({
  ownedChannelAccounts: many(channelAccounts),
  assignedConversations: many(conversations),
}));

export const channelAccountsRelations = relations(channelAccounts, ({ one, many }) => ({
  owner: one(users, { fields: [channelAccounts.ownerUserId], references: [users.id] }),
  identities: many(contactIdentities),
  conversations: many(conversations),
}));

export const contactsRelations = relations(contacts, ({ one, many }) => ({
  identities: many(contactIdentities),
  conversations: many(conversations),
  memory: one(customerMemories, { fields: [contacts.id], references: [customerMemories.contactId] }),
}));

export const contactIdentitiesRelations = relations(contactIdentities, ({ one }) => ({
  contact: one(contacts, { fields: [contactIdentities.contactId], references: [contacts.id] }),
  channelAccount: one(channelAccounts, {
    fields: [contactIdentities.channelAccountId],
    references: [channelAccounts.id],
  }),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  contact: one(contacts, { fields: [conversations.contactId], references: [contacts.id] }),
  channelAccount: one(channelAccounts, {
    fields: [conversations.channelAccountId],
    references: [channelAccounts.id],
  }),
  contactIdentity: one(contactIdentities, {
    fields: [conversations.contactIdentityId],
    references: [contactIdentities.id],
  }),
  assignedUser: one(users, { fields: [conversations.assignedUserId], references: [users.id] }),
  messages: many(messages),
  aiRuns: many(aiRuns),
  aiSuggestions: many(aiSuggestions),
  handoffs: many(handoffs),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, { fields: [messages.conversationId], references: [conversations.id] }),
  senderUser: one(users, { fields: [messages.senderUserId], references: [users.id] }),
  aiRun: one(aiRuns, { fields: [messages.aiRunId], references: [aiRuns.id] }),
}));

export const aiRunsRelations = relations(aiRuns, ({ one, many }) => ({
  conversation: one(conversations, { fields: [aiRuns.conversationId], references: [conversations.id] }),
  suggestions: many(aiSuggestions),
}));

export const aiSuggestionsRelations = relations(aiSuggestions, ({ one }) => ({
  conversation: one(conversations, {
    fields: [aiSuggestions.conversationId],
    references: [conversations.id],
  }),
  aiRun: one(aiRuns, { fields: [aiSuggestions.aiRunId], references: [aiRuns.id] }),
}));

export const handoffsRelations = relations(handoffs, ({ one }) => ({
  conversation: one(conversations, { fields: [handoffs.conversationId], references: [conversations.id] }),
}));

export const customerMemoriesRelations = relations(customerMemories, ({ one }) => ({
  contact: one(contacts, { fields: [customerMemories.contactId], references: [contacts.id] }),
}));

export const knowledgeDocumentsRelations = relations(knowledgeDocuments, ({ many }) => ({
  chunks: many(knowledgeChunks),
}));

export const knowledgeChunksRelations = relations(knowledgeChunks, ({ one }) => ({
  document: one(knowledgeDocuments, {
    fields: [knowledgeChunks.documentId],
    references: [knowledgeDocuments.id],
  }),
}));
