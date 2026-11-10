import { roomsForConversation } from '@dezon/core';
import type { ConversationSummary } from '@dezon/shared';

/** Phòng nhận sự kiện của một hội thoại (kèm người phụ trách cũ khi đổi phân công). */
export const roomsOfSummary = (conversation: ConversationSummary, previousAssigneeId?: string | null) =>
  roomsForConversation({ assignedUserId: conversation.assignedUser?.id ?? null }, previousAssigneeId);
