// Lời gọi REST của hộp thư và trang Kênh (hợp đồng: @dezon/shared/inbox).
import type {
  AiRunDto,
  ChannelAccountDto,
  ChannelType,
  ChatbotSummary,
  ConnectFacebookPagesRequest,
  ConnectFacebookPagesResult,
  ConnectMessengerPageRequest,
  ContactDetail,
  ConversationDetail,
  ConversationStatus,
  ConversationSummary,
  FacebookLoginSessionDto,
  FacebookLoginStartResponse,
  MessageDto,
  Page,
  SendMessageRequest,
  SyncChannelRequest,
  UpdateChannelRequest,
  UpdateContactRequest,
  UpdateConversationRequest,
  UploadedMediaDto,
  UserDirectoryEntry,
} from '@dezon/shared';
import { api } from '@/lib/api';
import type { AiStateFilter } from '@/lib/inbox-ai';

/** Bộ lọc danh sách hội thoại (phía web). Chỉ chứa khóa có giá trị để query key ổn định. */
export interface ConversationFilters {
  channelType?: ChannelType;
  channelAccountId?: string;
  status?: ConversationStatus;
  /** 'me' | 'none' | id nhân viên (admin lọc theo người phụ trách). */
  assignee?: 'me' | 'none' | (string & {});
  unread?: boolean;
  /**
   * 'handled' = "AI đang lo". Máy chủ hiện CHƯA hỗ trợ tham số này (Zod bỏ qua khóa lạ) nên web lọc
   * thêm trên trang đã tải; khi API có `aiState=handled` thì kết quả đúng ngay từ máy chủ.
   */
  aiState?: AiStateFilter;
}

/** Bỏ khóa undefined/false để hai bộ lọc giống nhau luôn cho cùng query key. */
export function normalizeFilters(f: ConversationFilters): ConversationFilters {
  const out: ConversationFilters = {};
  if (f.channelType) out.channelType = f.channelType;
  if (f.channelAccountId) out.channelAccountId = f.channelAccountId;
  if (f.status) out.status = f.status;
  if (f.assignee) out.assignee = f.assignee;
  if (f.unread) out.unread = true;
  if (f.aiState) out.aiState = f.aiState;
  return out;
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') sp.set(key, String(value));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const enc = encodeURIComponent;

export const inboxApi = {
  listConversations(filters: ConversationFilters, cursor?: string, limit = 30) {
    return api.request<Page<ConversationSummary>>(
      `/conversations${query({ ...normalizeFilters(filters), limit, cursor })}`,
    );
  },
  getConversation(id: string) {
    return api.request<ConversationDetail>(`/conversations/${enc(id)}`);
  },
  listMessages(id: string, cursor?: string, limit = 50) {
    return api.request<Page<MessageDto>>(`/conversations/${enc(id)}/messages${query({ limit, cursor })}`);
  },
  sendMessage(id: string, body: SendMessageRequest) {
    return api.request<{ messages: MessageDto[] }>(`/conversations/${enc(id)}/messages`, {
      method: 'POST',
      body,
    });
  },
  markRead(id: string) {
    return api.request<unknown>(`/conversations/${enc(id)}/read`, { method: 'POST' });
  },
  updateConversation(id: string, body: UpdateConversationRequest) {
    return api.request<unknown>(`/conversations/${enc(id)}`, { method: 'PATCH', body });
  },
  updateContact(id: string, body: UpdateContactRequest) {
    return api.request<unknown>(`/contacts/${enc(id)}`, { method: 'PATCH', body });
  },
  userDirectory() {
    return api.request<UserDirectoryEntry[]>('/users/directory');
  },
  /** Bot cho ô chọn ở khung chat (nhân viên chỉ nhận bot đang bật; admin nhận cả bot tắt). */
  listChatbots() {
    return api.request<ChatbotSummary[]>('/chatbots');
  },
  setConversationChatbot(id: string, chatbotId: string | null) {
    return api.request<unknown>(`/conversations/${enc(id)}/chatbot`, {
      method: 'PATCH',
      body: { chatbotId },
    });
  },
  resumeAi(id: string) {
    return api.request<unknown>(`/conversations/${enc(id)}/ai/resume`, { method: 'POST' });
  },
  ackHandoff(id: string) {
    return api.request<unknown>(`/conversations/${enc(id)}/handoff/ack`, { method: 'POST' });
  },
  resolveHandoff(id: string) {
    return api.request<unknown>(`/conversations/${enc(id)}/handoff/resolve`, { method: 'POST' });
  },
  /** Nhật ký AI (admin): 20 lần chạy gần nhất. */
  listAiRuns(id: string) {
    return api.request<AiRunDto[]>(`/conversations/${enc(id)}/ai-runs`);
  },
  uploadMedia(file: File) {
    const form = new FormData();
    form.append('file', file, file.name);
    return api.request<UploadedMediaDto>('/media/uploads', { method: 'POST', body: form });
  },
};

export const channelsApi = {
  list() {
    return api.request<ChannelAccountDto[]>('/channels');
  },
  connectMessenger(body: ConnectMessengerPageRequest) {
    return api.request<ChannelAccountDto>('/channels/messenger', { method: 'POST', body });
  },
  update(id: string, body: UpdateChannelRequest) {
    return api.request<ChannelAccountDto>(`/channels/${enc(id)}`, { method: 'PATCH', body });
  },
  disconnect(id: string) {
    return api.request<unknown>(`/channels/${enc(id)}/disconnect`, { method: 'POST' });
  },
  /** Đồng bộ lịch sử N ngày (admin). 409 = đang đồng bộ; 422 = kênh không đồng bộ được. */
  sync(id: string, body: SyncChannelRequest) {
    return api.request<unknown>(`/channels/${enc(id)}/sync`, { method: 'POST', body });
  },
  /** Facebook Login: lấy URL dialog (state lưu phía máy chủ). */
  startFacebookLogin() {
    return api.request<FacebookLoginStartResponse>('/channels/messenger/oauth/start', { method: 'POST' });
  },
  facebookLoginSession(sessionId: string) {
    return api.request<FacebookLoginSessionDto>(`/channels/messenger/oauth/sessions/${enc(sessionId)}`);
  },
  connectFacebookPages(sessionId: string, body: ConnectFacebookPagesRequest) {
    return api.request<ConnectFacebookPagesResult>(
      `/channels/messenger/oauth/sessions/${enc(sessionId)}/connect`,
      { method: 'POST', body },
    );
  },
};

/** Phản hồi PATCH có thể là ConversationSummary/Detail; kiểm tra sơ bộ trước khi đưa vào cache. */
export function looksLikeConversation(value: unknown): value is ConversationSummary {
  return (
    !!value &&
    typeof value === 'object' &&
    'id' in value &&
    'contact' in value &&
    'channel' in value &&
    'sendWindow' in value
  );
}

export function looksLikeContactDetail(value: unknown): value is ContactDetail {
  return !!value && typeof value === 'object' && 'id' in value && 'identities' in value;
}
