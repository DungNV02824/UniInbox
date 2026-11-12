// Gọi API "Chatbot AI" (admin) + khóa cache TanStack Query.
import type {
  ChatbotDto,
  ChatbotSummary,
  ChatbotTestRequest,
  ChatbotTestResult,
  CreateChatbotRequest,
  ReengagePreview,
  ReengagePreviewRequest,
  ReengageStartRequest,
  ReengageStartResult,
  UpdateChatbotRequest,
} from '@dezon/shared';
import { api } from '@/lib/api';

const enc = encodeURIComponent;

/** Khóa cache. `['chatbots']` là gốc: invalidate gốc làm mới cả danh sách lẫn chi tiết. */
export const chatbotKeys = {
  all: ['chatbots'] as const,
  list: () => ['chatbots', 'list'] as const,
  detail: (id: string) => ['chatbots', 'detail', id] as const,
  models: () => ['chatbots', 'models'] as const,
};

/** Bản nháp gửi kèm khi chat thử (POST /chatbots/test-draft yêu cầu có tên). */
export type ChatbotDraft = CreateChatbotRequest;

export const chatbotsApi = {
  /** Admin thấy cả bot đang tắt. */
  list() {
    return api.request<ChatbotSummary[]>('/chatbots');
  },
  get(id: string) {
    return api.request<ChatbotDto>(`/chatbots/${enc(id)}`);
  },
  /** 409 = trùng tên. */
  create(body: CreateChatbotRequest) {
    return api.request<ChatbotDto>('/chatbots', { method: 'POST', body });
  },
  /** 409 = trùng tên. */
  update(id: string, body: UpdateChatbotRequest) {
    return api.request<ChatbotDto>(`/chatbots/${enc(id)}`, { method: 'PATCH', body });
  },
  remove(id: string) {
    return api.request<unknown>(`/chatbots/${enc(id)}`, { method: 'DELETE' });
  },
  /** Chạy thử bot đã lưu (draft ghi đè các trường chưa lưu). Không gửi tin, không ghi DB hội thoại. */
  test(id: string, body: ChatbotTestRequest) {
    return api.request<ChatbotTestResult>(`/chatbots/${enc(id)}/test`, { method: 'POST', body });
  },
  /** Chạy thử bot chưa lưu. */
  testDraft(body: { draft: ChatbotDraft; messages: ChatbotTestRequest['messages'] }) {
    return api.request<ChatbotTestResult>('/chatbots/test-draft', { method: 'POST', body });
  },
  /** Tái chăm sóc: liệt kê khách bị bỏ sót trong N ngày (không gọi AI, không gửi tin). */
  reengagePreview(id: string, body: ReengagePreviewRequest) {
    return api.request<ReengagePreview>(`/chatbots/${enc(id)}/reengage/preview`, { method: 'POST', body });
  },
  /** Tái chăm sóc: xếp hàng bot trả lời các hội thoại đã chọn (mỗi hội thoại ≈ 1 lần gọi AI). */
  reengageStart(id: string, body: ReengageStartRequest) {
    return api.request<ReengageStartResult>(`/chatbots/${enc(id)}/reengage/start`, { method: 'POST', body });
  },
  /** Danh sách model chọn được (Gemini) + model mặc định của server. */
  async models(): Promise<ChatbotModels> {
    return normalizeModels(await api.request<unknown>('/chatbots/models'));
  },
};

export interface ChatbotModels {
  /** GEMINI_MODEL của server (bot để trống model dùng model này); null nếu API không trả. */
  defaultModel: string | null;
  models: string[];
}

/** Chấp nhận cả `{defaultModel, models}` lẫn `string[]`; bỏ phần tử không phải chuỗi, bỏ trùng. */
export function normalizeModels(raw: unknown): ChatbotModels {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const list = Array.isArray(raw) ? raw : Array.isArray(obj?.models) ? (obj.models as unknown[]) : [];
  const defaultModel =
    typeof obj?.defaultModel === 'string' && obj.defaultModel.trim() ? obj.defaultModel.trim() : null;
  const models = [...new Set(list.filter((m): m is string => typeof m === 'string' && !!m.trim()))];
  return { defaultModel, models };
}
