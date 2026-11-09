// Đồng bộ hội thoại qua Conversations API của Messenger (bổ sung cho webhook).
export * from './types';
export { readSyncState, syncTickPlan, writeSyncState, type SyncTickPlan } from './state';
export { isRateLimitError, pauseAfter, SYNC_PERMANENT_PAUSE_MS, SYNC_RATE_LIMIT_PAUSE_MS } from './pause';
export {
  BACKFILL_MISSED_MAX_MS,
  DEFAULT_BACKFILL_DAYS,
  DEFAULT_MAX_CONVERSATIONS,
  DEFAULT_MAX_MESSAGES_PER_CONVERSATION,
  INCREMENTAL_FIRST_WINDOW_MS,
  INCREMENTAL_OVERLAP_MS,
  MSG_SYNC_FAILED,
  MSG_SYNC_NOT_CONFIGURED,
  syncMessengerAccount,
} from './messenger';
