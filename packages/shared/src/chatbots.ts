// Hợp đồng tính năng "Chatbot AI" — dùng chung giữa api, worker, core và web.
// Ngày giờ trong DTO luôn là chuỗi ISO 8601 (UTC).
import { z } from 'zod';
import { HANDOFF_REASON_CODES, type AiRunDecision, type HandoffReasonCode } from './enums';

// ---------- Giới hạn ----------

export const CHATBOT_LIMITS = {
  nameMax: 100,
  descriptionMax: 500,
  instructionsMax: 20_000,
  knowledgeMax: 100_000,
  examplesMax: 50,
  exampleTextMax: 2000,
  keywordsMax: 100,
  keywordMax: 50,
  handoffMessageMax: 1000,
  modelMax: 100,
  testMessagesMax: 30,
  testTextMax: 2000,
  /** "Chat thử": số ảnh tối đa mỗi tin và tổng mỗi lần gọi (khớp CHATBOT_MAX_IMAGES của core). */
  testImagesMax: 10,
  /** "Chat thử": dung lượng tối đa một ảnh (byte sau khi giải mã base64). */
  testImageMaxBytes: 4 * 1024 * 1024,
} as const;

/** Mặc định khi tạo bot (khớp DEFAULT của bảng chatbots). */
export const CHATBOT_DEFAULTS = {
  temperature: 0.4,
  replyDelaySec: 10,
  maxWaitSec: 45,
  maxRepliesPerHour: 20,
  escalateWhenUnsure: true,
  responseSpeed: 'fast',
} as const;

// ---------- Tốc độ trả lời ----------

/**
 * "Tốc độ trả lời" của bot = mức "suy nghĩ" (thinking) của Gemini. Core ánh xạ sang LlmThinking bằng
 * thinkingForSpeed() (packages/core/src/ai/speed.ts). Đo thật gemini-3.5-flash (prompt bot thật + tool, mode ANY):
 * fast ≈ 1,6–1,9 s, balanced ≈ 1,9–4,3 s, thorough ≈ 9 s — cả ba đều gọi tool đúng.
 */
export const RESPONSE_SPEEDS = ['fast', 'balanced', 'thorough'] as const;
export type ResponseSpeed = (typeof RESPONSE_SPEEDS)[number];

/** Nhãn tiếng Việt cho ô chọn "Tốc độ trả lời" (tab Nâng cao). */
export const RESPONSE_SPEED_LABELS: Record<ResponseSpeed, string> = {
  fast: 'Nhanh nhất',
  balanced: 'Cân bằng',
  thorough: 'Suy nghĩ kỹ',
};

/** Gợi ý ngắn hiển thị dưới từng lựa chọn. */
export const RESPONSE_SPEED_HINTS: Record<ResponseSpeed, string> = {
  fast: 'Trả lời trong khoảng 1–2 giây. Đủ cho đếm ảnh, báo giá, hỏi đáp theo kiến thức đã nhập.',
  balanced: 'Khoảng 2–4 giây. AI cân nhắc thêm một chút trước khi trả lời.',
  thorough: 'Khoảng 5–10 giây. Dành cho câu hỏi phức tạp; khách phải chờ lâu hơn.',
};

export const responseSpeedSchema = z.enum(RESPONSE_SPEEDS);

/** Lý do chuyển người thật — nhãn tiếng Việt hiển thị cho nhân viên / tin system / Lark. */
export const HANDOFF_REASON_LABELS: Record<HandoffReasonCode, string> = {
  discount: 'Khách hỏi giảm giá / khuyến mãi',
  complaint: 'Khách phàn nàn / khiếu nại',
  human_request: 'Khách muốn gặp nhân viên',
  out_of_scope: 'Ngoài phạm vi kiến thức của bot',
  closing: 'Khách muốn đặt hàng / đặt lịch',
  low_confidence: 'AI không chắc câu trả lời',
  other: 'Lý do khác',
};

// ---------- Chatbot ----------

export interface ChatbotExampleDto {
  customer: string;
  reply: string;
}

export interface ChatbotDto {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  instructions: string;
  knowledge: string;
  examples: ChatbotExampleDto[];
  handoffKeywords: string[];
  /** null = im lặng khi chuyển người. */
  handoffMessage: string | null;
  /** null = dùng GEMINI_MODEL của server. */
  model: string | null;
  temperature: number;
  replyDelaySec: number;
  maxWaitSec: number;
  maxRepliesPerHour: number;
  /**
   * "Khi bot không chắc chắn": true = chuyển người thật (escalate low_confidence);
   * false = vẫn trả lời (không tự chuyển người vì độ tự tin thấp).
   */
  escalateWhenUnsure: boolean;
  /** "Tốc độ trả lời" (mức suy nghĩ của AI). Mặc định CHATBOT_DEFAULTS.responseSpeed = 'fast'. */
  responseSpeed: ResponseSpeed;
  /** Số hội thoại đang gắn bot này. */
  conversationCount: number;
  createdAt: string;
  updatedAt: string;
}

/** GET /chatbots — phần tử danh sách (nhân viên chỉ thấy bot đang bật; admin thấy cả bot tắt). */
export interface ChatbotSummary {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  conversationCount: number;
}

/** Bot rút gọn đi kèm hội thoại. */
export interface ChatbotRef {
  id: string;
  name: string;
}

const exampleSchema = z.object({
  customer: z.string().trim().min(1).max(CHATBOT_LIMITS.exampleTextMax),
  reply: z.string().trim().min(1).max(CHATBOT_LIMITS.exampleTextMax),
});

const chatbotFields = {
  name: z.string().trim().min(1, 'Tên bot không được trống').max(CHATBOT_LIMITS.nameMax),
  description: z.string().trim().max(CHATBOT_LIMITS.descriptionMax).nullable().optional(),
  isActive: z.boolean().optional(),
  instructions: z.string().max(CHATBOT_LIMITS.instructionsMax).optional(),
  knowledge: z.string().max(CHATBOT_LIMITS.knowledgeMax).optional(),
  examples: z.array(exampleSchema).max(CHATBOT_LIMITS.examplesMax).optional(),
  handoffKeywords: z
    .array(z.string().trim().min(1).max(CHATBOT_LIMITS.keywordMax))
    .max(CHATBOT_LIMITS.keywordsMax)
    .optional(),
  handoffMessage: z.string().trim().max(CHATBOT_LIMITS.handoffMessageMax).nullable().optional(),
  model: z.string().trim().min(1).max(CHATBOT_LIMITS.modelMax).nullable().optional(),
  temperature: z.number().min(0).max(1).optional(),
  replyDelaySec: z.number().int().min(0).max(120).optional(),
  maxWaitSec: z.number().int().min(5).max(300).optional(),
  maxRepliesPerHour: z.number().int().min(1).max(200).optional(),
  /** Bỏ trống khi tạo ⇒ DB mặc định true (CHATBOT_DEFAULTS.escalateWhenUnsure). */
  escalateWhenUnsure: z.boolean().optional(),
  /** Bỏ trống khi tạo ⇒ DB mặc định 'fast' (CHATBOT_DEFAULTS.responseSpeed). Draft "Chat thử" nhận luôn. */
  responseSpeed: responseSpeedSchema.optional(),
};

/** POST /chatbots (admin). Trường bỏ trống dùng mặc định của DB. */
export const createChatbotSchema = z.object(chatbotFields);
export type CreateChatbotRequest = z.infer<typeof createChatbotSchema>;

/** PATCH /chatbots/:id (admin). */
export const updateChatbotSchema = z
  .object({ ...chatbotFields, name: chatbotFields.name.optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Không có gì để cập nhật',
  });
export type UpdateChatbotRequest = z.infer<typeof updateChatbotSchema>;

// ---------- Chat thử ----------

export const CHATBOT_TEST_ROLES = ['customer', 'bot', 'agent'] as const;
export type ChatbotTestRole = (typeof CHATBOT_TEST_ROLES)[number];

/** Ảnh "Chat thử" nhận được. GIF (ảnh động) không nhận: core coi là định dạng không hỗ trợ. */
export const CHATBOT_TEST_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ChatbotTestImageMime = (typeof CHATBOT_TEST_IMAGE_MIMES)[number];

/** Số byte thật của chuỗi base64 (không tiền tố data:) — không cần giải mã. */
export function base64DecodedBytes(data: string): number {
  const len = data.length;
  if (len === 0) return 0;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Ảnh đính kèm tin khách khi "Chat thử": base64 KHÔNG có tiền tố `data:`. */
export const chatbotTestImageSchema = z.object({
  mimeType: z.enum(CHATBOT_TEST_IMAGE_MIMES, { error: 'Chỉ nhận ảnh JPEG, PNG hoặc WebP' }),
  data: z
    .string()
    .min(1, 'Ảnh rỗng')
    // Chặn sớm theo độ dài chuỗi (base64 của testImageMaxBytes) trước khi chạy regex trên chuỗi lớn.
    .max(Math.ceil(CHATBOT_LIMITS.testImageMaxBytes / 3) * 4, 'Ảnh vượt quá 4 MB')
    .refine((d) => d.length % 4 === 0 && BASE64_RE.test(d), {
      message: 'Dữ liệu ảnh không phải base64 hợp lệ',
    })
    .refine((d) => base64DecodedBytes(d) <= CHATBOT_LIMITS.testImageMaxBytes, {
      message: 'Ảnh vượt quá 4 MB',
    }),
});
export type ChatbotTestImage = z.infer<typeof chatbotTestImageSchema>;

/**
 * Một tin của "Chat thử". `images` CHỈ cho role 'customer' (≤ testImagesMax ảnh). Tin khách có ảnh được để
 * trống `text` (khách chỉ gửi ảnh); mọi tin khác phải có chữ.
 */
export const chatbotTestMessageSchema = z
  .object({
    role: z.enum(CHATBOT_TEST_ROLES),
    text: z.string().trim().max(CHATBOT_LIMITS.testTextMax),
    images: z
      .array(chatbotTestImageSchema)
      .max(CHATBOT_LIMITS.testImagesMax, `Tối đa ${CHATBOT_LIMITS.testImagesMax} ảnh mỗi tin`)
      .optional(),
    /** Số ảnh thật của tin khách ở lượt cũ (ảnh không gửi lại, chỉ báo số lượng cho lịch sử). */
    imageCount: z.number().int().min(0).max(100).optional(),
  })
  .refine((m) => !m.images?.length || m.role === 'customer', {
    message: 'Chỉ tin của khách mới được gửi kèm ảnh',
    path: ['images'],
  })
  .refine((m) => m.text.length > 0 || (m.images?.length ?? 0) > 0 || (m.imageCount ?? 0) > 0, {
    message: 'Tin nhắn không được trống',
    path: ['text'],
  });
export type ChatbotTestMessage = z.infer<typeof chatbotTestMessageSchema>;

/** Danh sách tin của "Chat thử" (dùng chung cho /chatbots/:id/test và /chatbots/test-draft). */
export const chatbotTestMessagesSchema = z
  .array(chatbotTestMessageSchema)
  .min(1)
  .max(CHATBOT_LIMITS.testMessagesMax)
  .refine((msgs) => msgs.reduce((n, m) => n + (m.images?.length ?? 0), 0) <= CHATBOT_LIMITS.testImagesMax, {
    message: `Tối đa ${CHATBOT_LIMITS.testImagesMax} ảnh cho mỗi lần chat thử`,
  });

/** POST /chatbots/:id/test (admin): chạy orchestrator thật nhưng KHÔNG gửi, KHÔNG ghi DB hội thoại. */
export const chatbotTestSchema = z.object({
  messages: chatbotTestMessagesSchema,
  /** Bản nháp chưa lưu: ghi đè lên bot đã lưu khi chạy thử. */
  draft: createChatbotSchema.partial().optional(),
});
export type ChatbotTestRequest = z.infer<typeof chatbotTestSchema>;

export type ChatbotTurnDecision = 'reply' | 'escalate' | 'no_reply' | 'error';

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatbotTestResult {
  decision: ChatbotTurnDecision;
  /**
   * Các tin người nhắn THẬT SỰ sẽ nhận ở lượt này, với MỌI decision (API luôn điền, có thể []): 'reply' ⇒ các bong
   * bóng trả lời; 'escalate' ⇒ `messages_to_customer` của tool escalate (hoặc bong bóng reply tự nói "đã chuyển" mà
   * hệ thống đổi thành chuyển người), không có thì tin chuyển người của bot (handoffMessage — bản nháp hoặc đã lưu),
   * không có nữa ⇒ []; 'error' (chạy thật sẽ chuyển người) ⇒ handoffMessage hoặc []; 'no_reply' ⇒ [].
   */
  messages?: string[];
  reasonCode?: HandoffReasonCode;
  /** Tóm tắt cho nhân viên (decision = 'escalate'). */
  summary?: string;
  /** Lý do no_reply hoặc thông điệp lỗi (tiếng Việt). */
  reason?: string;
  latencyMs: number;
  model: string;
  usage?: LlmUsage;
}

// ---------- Gắn bot vào hội thoại ----------

/** PATCH /conversations/:id/chatbot — null = tắt bot (ai_mode 'off'). */
export const setConversationChatbotSchema = z.object({
  chatbotId: z.uuid().nullable(),
});
export type SetConversationChatbotRequest = z.infer<typeof setConversationChatbotSchema>;

// ---------- Cài đặt: giờ làm việc ----------

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: 'Thứ Hai',
  tue: 'Thứ Ba',
  wed: 'Thứ Tư',
  thu: 'Thứ Năm',
  fri: 'Thứ Sáu',
  sat: 'Thứ Bảy',
  sun: 'Chủ Nhật',
};

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Giờ phải có dạng HH:MM');
/** Giờ kết thúc: thêm '24:00' (hết ngày) — so sánh chuỗi 'HH:MM' vẫn đúng ('23:59' < '24:00'). */
const hhmmEnd = z
  .string()
  .regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, 'Giờ phải có dạng HH:MM (kết thúc tối đa 24:00)');

export const timeRangeSchema = z
  .object({ start: hhmm, end: hhmmEnd })
  .refine((r) => r.start < r.end, { message: 'Giờ bắt đầu phải trước giờ kết thúc' });
export type TimeRange = z.infer<typeof timeRangeSchema>;

const dayRangesSchema = z.array(timeRangeSchema).max(4, 'Tối đa 4 khung giờ mỗi ngày');

/** GET/PUT /settings/business-hours (admin). Ngày rỗng = nghỉ. */
export const businessHoursSchema = z.object({
  timezone: z
    .string()
    .min(1)
    .max(64)
    .refine(
      (tz) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      },
      { message: 'Múi giờ không hợp lệ' },
    ),
  days: z.object({
    mon: dayRangesSchema,
    tue: dayRangesSchema,
    wed: dayRangesSchema,
    thu: dayRangesSchema,
    fri: dayRangesSchema,
    sat: dayRangesSchema,
    sun: dayRangesSchema,
  }),
});
export type BusinessHours = z.infer<typeof businessHoursSchema>;

export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  timezone: 'Asia/Ho_Chi_Minh',
  days: {
    mon: [{ start: '08:00', end: '17:30' }],
    tue: [{ start: '08:00', end: '17:30' }],
    wed: [{ start: '08:00', end: '17:30' }],
    thu: [{ start: '08:00', end: '17:30' }],
    fri: [{ start: '08:00', end: '17:30' }],
    sat: [{ start: '08:00', end: '17:30' }],
    sun: [],
  },
};

// ---------- Cài đặt: Lark ----------

/** GET/PUT /settings/lark — secret không bao giờ trả ra client. */
export interface LarkSettingsDto {
  webhookUrl: string | null;
  hasSecret: boolean;
}

/** PUT /settings/lark. `secret`: bỏ qua = giữ nguyên, null/'' = xóa, chuỗi = đặt mới. */
export const updateLarkSettingsSchema = z.object({
  webhookUrl: z
    .url({ protocol: /^https$/, error: 'Webhook phải là URL https' })
    .max(500)
    .nullable(),
  secret: z.string().max(200).nullable().optional(),
});
export type UpdateLarkSettingsRequest = z.infer<typeof updateLarkSettingsSchema>;

// ---------- Cài đặt: AI tổng ----------

export interface AiSettings {
  enabled: boolean;
}

/** PUT /settings/ai */
export const aiSettingsSchema = z.object({ enabled: z.boolean() });

export const DEFAULT_AI_SETTINGS: AiSettings = { enabled: true };

// ---------- Nhật ký AI ----------

/** GET /conversations/:id/ai-runs (admin) — 20 lần chạy gần nhất. */
export interface AiRunDto {
  id: string;
  createdAt: string;
  decision: AiRunDecision;
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  reasoningSummary?: string | null;
  error?: string | null;
  toolCalls?: unknown;
  chatbotName?: string | null;
}

// ---------- Handoff ----------

export const handoffReasonCodeSchema = z.enum(HANDOFF_REASON_CODES);
