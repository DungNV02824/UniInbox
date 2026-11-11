// Kiểu dữ liệu thuần (không DB) dùng chung cho prompt/orchestrator/runtime.
import type {
  AiHandoffMode,
  ChatbotExampleDto,
  ChatbotTurnDecision,
  HandoffReasonCode,
  LlmUsage,
  ResponseSpeed,
} from '@dezon/shared';

/**
 * Cấu hình bot mà prompt/orchestrator cần. Dòng `Chatbot` của @dezon/db gán trực tiếp được;
 * "Chat thử" ghép bot đã lưu với draft (ChatbotTestRequest.draft) trước khi truyền vào.
 */
export interface ChatbotConfig {
  id: string | null;
  name: string;
  instructions: string;
  knowledge: string;
  examples: ChatbotExampleDto[];
  handoffKeywords: string[];
  handoffMessage: string | null;
  /** null = deps.defaultModel (GEMINI_MODEL). */
  model: string | null;
  temperature: number;
  /**
   * "Khi bot không chắc chắn": true = confidence < ngưỡng ⇒ escalate low_confidence;
   * false = vẫn gửi câu trả lời (prompt cũng bỏ dòng mặc định "không chắc ⇒ chuyển người").
   */
  escalateWhenUnsure: boolean;
  /**
   * "Tốc độ trả lời" ⇒ LlmRequest.thinking = thinkingForSpeed(responseSpeed). Tùy chọn để fixture test cũ vẫn
   * hợp lệ; thiếu ⇒ CHATBOT_DEFAULTS.responseSpeed ('fast'). toChatbotConfig PHẢI điền (draft ghi đè).
   */
  responseSpeed?: ResponseSpeed;
  /**
   * Từ khóa "Báo nhân viên, bot VẪN trả lời" — khớp (và không khớp handoffKeywords) ⇒ orchestrator đặt
   * ChatbotTurnResult.notifiedKeyword rồi vẫn chạy LLM bình thường. Tùy chọn để fixture cũ hợp lệ (thiếu ⇒ []).
   */
  notifyKeywords?: string[];
  /**
   * "Khi AI tự chuyển người thật" (AI_HANDOFF_MODES): 'continue' ⇒ sau khi AI escalate bot VẪN trả lời các tin sau
   * (prompt nói rõ; lượt có handoff mở thì được nói yêu cầu đã chuyển — xem ChatHistoryItem.handoffOpen). Tùy chọn để
   * fixture cũ hợp lệ (thiếu ⇒ 'stop').
   */
  aiHandoffMode?: AiHandoffMode;
}

/** Một tin trong lịch sử/tin mới, đã rút gọn cho prompt. */
export interface ChatHistoryItem {
  /** 'system' = dòng hệ thống (chuyển nhân viên / trả lại cho bot), prompt ghi [Hệ thống]. */
  role: 'customer' | 'bot' | 'agent' | 'system';
  /** null = tin chỉ có tệp. */
  text: string | null;
  /** Tên nhân viên (role 'agent') để gắn nhãn [NV <tên>]; thiếu ⇒ [NV]. */
  agentName?: string | null;
  /** Số tệp/ảnh đính kèm (prompt ghi "[gửi 2 ảnh/tệp]"). */
  attachmentCount?: number;
  /**
   * Tin MỚI có ảnh: vị trí (1-based, khớp "Ảnh k/N" của danh sách PromptImage) của ảnh đầu/cuối trong tin ⇒ prompt
   * ghi "[gửi 3 ảnh/tệp: ảnh 4–6]" để model biết ảnh nào thuộc tin (công trình) nào.
   */
  imageRange?: { first: number; last: number };
  sentAt?: Date;
  /**
   * Dòng role 'system' là tin "Đã báo nhân viên …" THẬT do notifyStaffKeyword ghi (từ khóa "Báo nhân viên, bot VẪN
   * trả lời"; loadTurnHistory nhận diện qua messages.raw.notifyStaff). Lượt sau có dòng này ⇒ bot được nói "em đã
   * báo nhân viên" (quy tắc 7) và bộ chặn "tự nói đã chuyển" bỏ qua đúng lời đó (claimsHandoffInReply
   * allowStaffNotified).
   */
  staffNotified?: boolean;
  /**
   * Dòng role 'system' "Hội thoại đã được chuyển cho nhân viên …" (loadTurnHistory, từ bảng handoffs) của handoff
   * CÒN MỞ (resolved_at null). Bot aiHandoffMode 'continue' + có dòng này ⇒ hội thoại đang chờ nhân viên mà bot vẫn
   * trả lời: prompt thêm ghi chú (handoffContinueTurnNote) và bộ chặn "tự nói đã chuyển" bỏ qua lời chuyển (nhân
   * viên ĐÃ thật sự nhận yêu cầu) — claimsHandoffInReply allowHandedOff.
   */
  handoffOpen?: boolean;
}

/**
 * Lý do một ảnh của lượt KHÔNG được đính kèm cho model (prompt ghi chú bằng chữ thay cho ảnh):
 * - 'too_large': ảnh > CHATBOT_MAX_IMAGE_BYTES;
 * - 'over_total': tổng dung lượng ảnh của lượt vượt CHATBOT_MAX_IMAGES_TOTAL_BYTES;
 * - 'unavailable': tải hỏng lúc nhận (storage_key '') hoặc không tải được từ kho lưu trữ (hoặc dữ liệu rỗng) —
 *   vẫn giữ chỗ trong đánh số "Ảnh k/N";
 * - 'unsupported': định dạng model không đọc được, vd. gif/svg (xem CHATBOT_IMAGE_MIMES);
 * - 'limit': cũ hơn CHATBOT_MAX_IMAGES ảnh mới nhất (prompt chỉ báo số lượng, không gắn nhãn từng ảnh).
 */
export type PromptImageSkipReason = 'too_large' | 'over_total' | 'unavailable' | 'unsupported' | 'limit';

/**
 * Một ảnh khách gửi trong các tin MỚI của lượt. Danh sách ảnh truyền cho prompt là MỌI ảnh của các tin mới theo
 * thứ tự thời gian (cũ ⇒ mới; trong một tin theo thứ tự đính kèm) — kể cả ảnh không đính kèm được (`skipped`,
 * `data` rỗng) — để prompt đánh số "Ảnh k/N" đúng với số ảnh khách thật sự gửi.
 */
export interface PromptImage {
  mime: string;
  /** base64, không có tiền tố data: ('' khi `skipped`). */
  data: string;
  /** Giờ gửi của tin chứa ảnh — nhãn ghi "thuộc tin lúc HH:MM:SS" theo múi giờ làm việc. Thiếu ⇒ không ghi giờ. */
  sentAt?: Date;
  /**
   * Thứ tự (1-based) của tin chứa ảnh trong các tin MỚI của lượt (cùng thứ tự dòng tin) — nhãn ghi "(tin thứ m
   * trong lượt này)" để ảnh không bị gán nhầm tin/công trình. Thiếu ⇒ không ghi.
   */
  messageIndex?: number;
  /** Có ⇒ không đính kèm ảnh, prompt ghi chú lý do. */
  skipped?: PromptImageSkipReason;
}

export interface ChatbotTurnResult {
  decision: ChatbotTurnDecision;
  /**
   * Tin bot GỬI người nhắn (CHƯA tách theo 1999 ký tự — runtime tách):
   * - decision 'reply': 1..3 bong bóng đã trim, bỏ rỗng;
   * - decision 'escalate': `messages_to_customer` của tool escalate (≤ 3), hoặc các bong bóng reply tự nói "đã chuyển
   *   nhân viên" mà hệ thống đổi thành escalate — runtime gửi THAY cho bot.handoffMessage. Thiếu ⇒ gửi handoffMessage
   *   (nếu bot có). Escalate low_confidence / từ khóa không có messages.
   */
  messages?: string[];
  /** decision 'escalate' (kể cả low_confidence và từ khóa pre-filter). decision 'error' ⇒ 'other'. */
  reasonCode?: HandoffReasonCode;
  /** Tóm tắt cho nhân viên (tiếng Việt). */
  summary?: string;
  /** decision 'no_reply': lý do của model; decision 'error': thông điệp lỗi (không chứa key). */
  reason?: string;
  /** Từ khóa chuyển người đã khớp (pre-filter, không gọi LLM). */
  matchedKeyword?: string;
  /**
   * Từ khóa "Báo nhân viên, bot VẪN trả lời" đã khớp ở lượt này (decision vẫn là kết quả LLM). Runtime báo nhân
   * viên (tin system + handoff.created botContinues + Lark) đúng một lần; Chat thử chỉ trả về cho giao diện.
   */
  notifiedKeyword?: string;
  /** Độ tự tin model báo trong reply (nếu có). */
  confidence?: number;
  usage: LlmUsage;
  model: string;
  latencyMs: number;
  /** Ghi thẳng vào ai_runs.tool_calls: [{ name, args }] của mọi lần model gọi tool / pre-filter. */
  toolCalls: unknown[];
}
