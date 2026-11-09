// Phát sự kiện realtime. API cài đặt bằng Socket.IO server, worker bằng @socket.io/redis-emitter
// (cùng Redis adapter nên sự kiện từ worker tới được mọi client đang nối vào API).
import { ROOM_ADMINS, ROOM_UNASSIGNED, userRoom, type ServerToClientEvents } from '@dezon/shared';

export interface RealtimePublisher {
  emit<E extends keyof ServerToClientEvents>(
    rooms: string[],
    event: E,
    payload: Parameters<ServerToClientEvents[E]>[0],
  ): void;
}

/** Publisher không làm gì (test, script). */
export const noopPublisher: RealtimePublisher = { emit: () => undefined };

/**
 * Các phòng được nhận sự kiện của một hội thoại.
 * Quy tắc xem (Giai đoạn 1A, ghi ở DECISIONS.md): admin xem tất cả; agent xem hội thoại
 * được phân công cho mình và hội thoại chưa phân công.
 * `previousAssigneeId`: khi đổi người phụ trách, báo cả người cũ để UI của họ gỡ hội thoại.
 */
export function roomsForConversation(
  conversation: { assignedUserId: string | null },
  previousAssigneeId?: string | null,
): string[] {
  const rooms = new Set<string>([ROOM_ADMINS]);
  rooms.add(conversation.assignedUserId ? userRoom(conversation.assignedUserId) : ROOM_UNASSIGNED);
  if (previousAssigneeId !== undefined && previousAssigneeId !== conversation.assignedUserId) {
    rooms.add(previousAssigneeId ? userRoom(previousAssigneeId) : ROOM_UNASSIGNED);
  }
  return [...rooms];
}
