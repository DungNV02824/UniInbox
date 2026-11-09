// Hợp đồng Socket.IO (Giai đoạn 1A).
//
// Kết nối: io(API_URL, { path: '/socket.io', auth: { token: <access JWT> } }).
// Server xác thực JWT khi handshake rồi tự cho socket vào phòng theo quyền:
//   - admin  -> 'role:admin'
//   - agent  -> 'user:<id>' và 'pool:unassigned'
// Server phát sự kiện hội thoại/tin nhắn tới các phòng do roomsForConversation() tính,
// nên client chỉ nhận dữ liệu mình được xem. Client KHÔNG cần join phòng theo hội thoại.
import type { ConversationSummary, MessageDto } from './inbox';

export const SOCKET_PATH = '/socket.io';

export const REALTIME_EVENTS = {
  messageCreated: 'message.created',
  messageUpdated: 'message.updated',
  conversationUpdated: 'conversation.updated',
} as const;
export type RealtimeEventName = (typeof REALTIME_EVENTS)[keyof typeof REALTIME_EVENTS];

export const ROOM_ADMINS = 'role:admin';
export const ROOM_UNASSIGNED = 'pool:unassigned';
export const userRoom = (userId: string): string => `user:${userId}`;

export interface MessageCreatedPayload {
  message: MessageDto;
  /** Trạng thái hội thoại sau khi có tin (preview, unread, cửa sổ gửi). */
  conversation: ConversationSummary;
}

export interface MessageUpdatedPayload {
  message: MessageDto;
}

export interface ConversationUpdatedPayload {
  conversation: ConversationSummary;
}

export interface ServerToClientEvents {
  'message.created': (payload: MessageCreatedPayload) => void;
  'message.updated': (payload: MessageUpdatedPayload) => void;
  'conversation.updated': (payload: ConversationUpdatedPayload) => void;
}

/** Client không gửi sự kiện nào ở 1A (mọi thao tác đi qua REST). */
export type ClientToServerEvents = Record<string, never>;
