// Hợp đồng Socket.IO (Giai đoạn 1A).
//
// Kết nối: io(API_URL, { path: '/socket.io', auth: { token: <access JWT> } }).
// Server xác thực JWT khi handshake rồi tự cho socket vào phòng theo quyền:
//   - admin  -> 'role:admin'
//   - agent  -> 'user:<id>' và 'pool:unassigned'
// Server phát sự kiện hội thoại/tin nhắn tới các phòng do roomsForConversation() tính,
// nên client chỉ nhận dữ liệu mình được xem. Client KHÔNG cần join phòng theo hội thoại.
import type { HandoffReasonCode } from './enums';
import type { ConversationSummary, MessageDto } from './inbox';

export const SOCKET_PATH = '/socket.io';

export const REALTIME_EVENTS = {
  messageCreated: 'message.created',
  messageUpdated: 'message.updated',
  conversationUpdated: 'conversation.updated',
  handoffCreated: 'handoff.created',
  aiTyping: 'ai.typing',
  contactTagsUpdated: 'contact_tags.updated',
} as const;
export type RealtimeEventName = (typeof REALTIME_EVENTS)[keyof typeof REALTIME_EVENTS];

export const ROOM_ADMINS = 'role:admin';
export const ROOM_UNASSIGNED = 'pool:unassigned';
export const userRoom = (userId: string): string => `user:${userId}`;
/** Mọi nhân viên đang nối: admin ở 'role:admin', mọi agent đều ở 'pool:unassigned'. */
export const ROOMS_ALL_STAFF: readonly string[] = [ROOM_ADMINS, ROOM_UNASSIGNED];

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

/**
 * AI chuyển hội thoại cho người thật (hoặc nhắc lại sau HANDOFF_ESCALATE_AFTER_MIN chưa ai nhận).
 * Phát tới roomsForConversation(); web phát âm thanh + toast + đổi tiêu đề tab.
 */
export interface HandoffCreatedPayload {
  conversationId: string;
  reasonCode: HandoffReasonCode;
  summary: string;
  contactName: string;
  channelName: string;
  /** true = sự kiện nhắc lại (chưa ai "Nhận xử lý"). */
  reminder?: boolean;
}

/**
 * Bot đang soạn tin (hiện "AI đang soạn tin…" trong khung chat). Worker phát tới roomsForConversation():
 * - typing: true  ngay khi job ai-reply qua hết điều kiện chạy và bắt đầu gọi Gemini;
 * - typing: false khi lượt kết thúc theo BẤT KỲ cách nào (đã tạo tin bot, escalate, no_reply, lỗi, hủy).
 * Client tự tắt chỉ báo sau AI_TYPING_TTL_MS nếu không nhận được typing:false (worker chết giữa chừng), và
 * tắt luôn khi nhận message.created có senderType 'bot' của hội thoại đó.
 */
export interface AiTypingPayload {
  conversationId: string;
  typing: boolean;
  /** Tên bot đang soạn (hiện "<tên bot> đang soạn tin…"); null = không rõ ⇒ "AI đang soạn tin…". */
  chatbotName: string | null;
}

/**
 * Danh sách nhãn khách hàng (Quản trị) vừa đổi: thêm/sửa/đổi tên/sắp xếp/xóa. Phát tới mọi nhân viên
 * (ROOMS_ALL_STAFF); web tải lại GET /contact-tags (và chi tiết khách đang mở nếu nhãn bị đổi tên/xóa).
 */
export type ContactTagsUpdatedPayload = Record<string, never>;

/** Client tự tắt "AI đang soạn tin…" sau thời gian này nếu không nhận typing:false. */
export const AI_TYPING_TTL_MS = 45_000;

export interface ServerToClientEvents {
  'message.created': (payload: MessageCreatedPayload) => void;
  'message.updated': (payload: MessageUpdatedPayload) => void;
  'conversation.updated': (payload: ConversationUpdatedPayload) => void;
  'handoff.created': (payload: HandoffCreatedPayload) => void;
  'ai.typing': (payload: AiTypingPayload) => void;
  'contact_tags.updated': (payload: ContactTagsUpdatedPayload) => void;
}

/** Client không gửi sự kiện nào ở 1A (mọi thao tác đi qua REST). */
export type ClientToServerEvents = Record<string, never>;
