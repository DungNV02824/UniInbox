import { pgEnum } from 'drizzle-orm/pg-core';
import {
  AI_MODES,
  AI_RUN_DECISIONS,
  AI_SUGGESTION_STATUSES,
  CHANNEL_ACCOUNT_STATUSES,
  CHANNEL_TYPES,
  CONVERSATION_STATUSES,
  HANDOFF_REASON_CODES,
  KNOWLEDGE_SOURCE_TYPES,
  MESSAGE_STATUSES,
  SENDER_TYPES,
  USER_ROLES,
  WINDOW_SOURCES,
} from '@dezon/shared';

// Giá trị lấy từ @dezon/shared để DB và code luôn khớp. Thêm giá trị => phải sinh migration mới.
export const channelTypeEnum = pgEnum('channel_type', CHANNEL_TYPES);
export const senderTypeEnum = pgEnum('sender_type', SENDER_TYPES);
export const aiModeEnum = pgEnum('ai_mode', AI_MODES);
export const conversationStatusEnum = pgEnum('conversation_status', CONVERSATION_STATUSES);
export const messageStatusEnum = pgEnum('message_status', MESSAGE_STATUSES);
export const userRoleEnum = pgEnum('user_role', USER_ROLES);
export const channelAccountStatusEnum = pgEnum('channel_account_status', CHANNEL_ACCOUNT_STATUSES);
export const windowSourceEnum = pgEnum('window_source', WINDOW_SOURCES);
export const aiSuggestionStatusEnum = pgEnum('ai_suggestion_status', AI_SUGGESTION_STATUSES);
export const aiRunDecisionEnum = pgEnum('ai_run_decision', AI_RUN_DECISIONS);
export const handoffReasonCodeEnum = pgEnum('handoff_reason_code', HANDOFF_REASON_CODES);
export const knowledgeSourceTypeEnum = pgEnum('knowledge_source_type', KNOWLEDGE_SOURCE_TYPES);
