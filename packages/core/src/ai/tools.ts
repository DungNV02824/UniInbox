// Ba tool bot BẮT BUỘC gọi đúng một (mục 7.3): reply / escalate / no_reply. Khai báo + Zod parse args.
import {
  CAPTURE_KEY_PATTERN,
  CAPTURE_LIMITS,
  HANDOFF_REASON_CODES,
  PROJECT_LOG_LIMITS,
  type CaptureConfig,
  type CaptureField,
  type HandoffReasonCode,
} from '@dezon/shared';
import { z } from 'zod';
import type { LlmFunctionDeclaration } from './llm';
import type { ChatbotConfig } from './types';

export const CHATBOT_TOOL_NAMES = ['reply', 'escalate', 'no_reply'] as const;
export type ChatbotToolName = (typeof CHATBOT_TOOL_NAMES)[number];

/** Tối đa số bong bóng mỗi lượt trả lời (thừa thì cắt, không coi là lỗi). */
export const CHATBOT_MAX_BUBBLES = 3;
/** Độ dài tối đa mỗi bong bóng (cắt ở ranh giới từ, thêm '…'). */
export const CHATBOT_MAX_BUBBLE_CHARS = 1000;
/** Tối đa số tin `messages_to_customer` của escalate (thừa thì cắt). */
export const CHATBOT_MAX_HANDOFF_MESSAGES = 3;
/** Độ dài tối đa summary_for_agent (banner trong hệ thống + thẻ Lark). */
export const CHATBOT_MAX_SUMMARY_CHARS = 500;
/** Độ dài tối đa lý do no_reply. */
export const CHATBOT_MAX_REASON_CHARS = 500;

/** Cắt chuỗi còn tối đa `max` ký tự (đếm theo ký tự Unicode, không cắt đôi cặp surrogate). */
function clipChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('').trimEnd();
}

/**
 * Chuẩn hóa `captured` model trả (xem buildChatbotTools): CHỈ nhận object; khóa phải đúng CAPTURE_KEY_PATTERN;
 * giá trị phải là chuỗi (khác chuỗi ⇒ bỏ), gộp khoảng trắng/xuống dòng thành một dấu cách, trim, bỏ rỗng,
 * ≤ CAPTURE_LIMITS.valueMax ký tự; tối đa CAPTURE_LIMITS.maxFields khóa. Không có gì dùng được ⇒ undefined.
 * KHÔNG BAO GIỜ ném / làm hỏng lời gọi tool. Lọc theo trường bật của bot làm ở orchestrator (filterCaptured).
 */
export function normalizeCapturedArg(value: unknown): Record<string, string> | undefined {
  return normalizeStringRecord(value, CAPTURE_LIMITS.maxFields);
}

/** Lõi của normalizeCapturedArg / normalizeProjectLogsArg: object ⇒ { khóa hợp lệ: chuỗi đã gọn }, ≤ maxKeys khóa. */
function normalizeStringRecord(value: unknown, maxKeys: number): Record<string, string> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (count >= maxKeys) break;
    if (!CAPTURE_KEY_PATTERN.test(key)) continue;
    if (typeof raw !== 'string') continue;
    const cleaned = clipChars(raw.replace(/\s+/g, ' ').trim(), CAPTURE_LIMITS.valueMax);
    if (!cleaned) continue;
    out[key] = cleaned;
    count++;
  }
  return count > 0 ? out : undefined;
}

/** Thuộc tính tùy chọn `captured` của 3 tool: lỏng tuyệt đối (sai dạng ⇒ undefined, không làm args không hợp lệ). */
const capturedArgSchema = z.unknown().transform(normalizeCapturedArg).optional();

/**
 * Chuẩn hóa `project_logs` model trả (Nhật ký công trình — xem buildChatbotTools): mảng các object (object đơn ⇒ coi
 * như mảng một phần tử); mỗi phần tử chuẩn hóa như `captured` (khóa đúng CAPTURE_KEY_PATTERN, giá trị chuỗi đã gọn,
 * bỏ rỗng, ≤ PROJECT_LOG_LIMITS.maxFields khóa); phần tử sai dạng / rỗng ⇒ bỏ; tối đa
 * PROJECT_LOG_LIMITS.maxEntriesPerTurn phần tử. Không có gì dùng được ⇒ undefined. KHÔNG BAO GIỜ ném. Lọc theo
 * trường bật của bot làm ở orchestrator (filterProjectLogs).
 */
export function normalizeProjectLogsArg(value: unknown): Array<Record<string, string>> | undefined {
  const items = Array.isArray(value) ? value : value !== null && typeof value === 'object' ? [value] : [];
  const out: Array<Record<string, string>> = [];
  for (const item of items) {
    if (out.length >= PROJECT_LOG_LIMITS.maxEntriesPerTurn) break;
    const entry = normalizeStringRecord(item, PROJECT_LOG_LIMITS.maxFields);
    if (entry) out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

/** Thuộc tính tùy chọn `project_logs` của reply / escalate: lỏng tuyệt đối như `captured`. */
const projectLogsArgSchema = z.unknown().transform(normalizeProjectLogsArg).optional();

/** Model có thể trả nhiều hơn 3 bong bóng dù khai báo maxItems: nhận hết rồi orchestrator cắt còn 3. */
export const replyArgsSchema = z.object({
  messages: z.array(z.string()).min(1),
  confidence: z.number().min(0).max(1),
  captured: capturedArgSchema,
  project_logs: projectLogsArgSchema,
});
export type ReplyArgs = z.infer<typeof replyArgsSchema>;

export const escalateArgsSchema = z.object({
  reason_code: z.enum(HANDOFF_REASON_CODES),
  summary_for_agent: z.string(),
  /**
   * Tin gửi người nhắn ngay lúc chuyển (vd. báo thù lao dự kiến, "em đã chuyển hồ sơ cho bộ phận duyệt"). Có ⇒ gửi
   * THAY cho bot.handoffMessage. Model có thể trả null / chuỗi đơn / phần tử không phải chuỗi ⇒ chuẩn hóa thành
   * mảng chuỗi (orchestrator trim, bỏ rỗng, ≤ CHATBOT_MAX_HANDOFF_MESSAGES, mỗi tin ≤ CHATBOT_MAX_BUBBLE_CHARS).
   */
  messages_to_customer: z.preprocess(
    (v) =>
      v === null || v === undefined
        ? undefined
        : typeof v === 'string'
          ? [v]
          : Array.isArray(v)
            ? v.filter((m): m is string => typeof m === 'string')
            : v,
    z.array(z.string()).optional(),
  ),
  captured: capturedArgSchema,
  project_logs: projectLogsArgSchema,
});
export type EscalateArgs = z.infer<typeof escalateArgsSchema>;

export const noReplyArgsSchema = z.object({ reason: z.string(), captured: capturedArgSchema });
export type NoReplyArgs = z.infer<typeof noReplyArgsSchema>;

export const CHATBOT_TOOLS: LlmFunctionDeclaration[] = [
  {
    name: 'reply',
    description: 'Gửi trả lời. Mỗi phần tử là một bong bóng chat (tối đa 3), văn bản thuần, không markdown.',
    parameters: {
      type: 'object',
      properties: {
        messages: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: CHATBOT_MAX_BUBBLES,
          description: 'Các bong bóng tin nhắn gửi cho khách, theo thứ tự.',
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Mức tự tin thật rằng câu trả lời đúng và có căn cứ (0..1).',
        },
      },
      required: ['messages', 'confidence'],
    },
  },
  {
    name: 'escalate',
    description:
      'Chuyển hội thoại cho nhân viên thật khi cần người xử lý (theo mục Hướng dẫn, hoặc mục Mặc định khi Hướng dẫn không nói). Đây là CÁCH DUY NHẤT để nhân viên/bộ phận khác biết: muốn nói với người nhắn rằng đã chuyển hồ sơ/thông tin/yêu cầu cho nhân viên hay bộ phận thì PHẢI gọi công cụ này (đặt lời đó vào messages_to_customer), không dùng reply.',
    parameters: {
      type: 'object',
      properties: {
        reason_code: { type: 'string', enum: [...HANDOFF_REASON_CODES] },
        summary_for_agent: {
          type: 'string',
          description: 'Tóm tắt ngắn bằng tiếng Việt cho nhân viên: người nhắn cần gì, đã trao đổi gì.',
        },
        messages_to_customer: {
          type: 'array',
          items: { type: 'string' },
          maxItems: CHATBOT_MAX_HANDOFF_MESSAGES,
          description:
            'Tùy chọn: 0–3 bong bóng gửi người nhắn ngay lúc chuyển, theo giọng văn của Hướng dẫn (vd. kết quả kiểm tra, mức thù lao dự kiến, "em đã chuyển hồ sơ cho bộ phận duyệt"). Văn bản thuần, không markdown. Không hứa thời gian cụ thể nhân viên liên hệ. Có nội dung thì hệ thống gửi các tin này thay cho câu chuyển người mặc định.',
        },
      },
      required: ['reason_code', 'summary_for_agent'],
    },
  },
  {
    name: 'no_reply',
    description: 'Không gửi gì ở lượt này (tin không cần đáp, hoặc đã trả lời đủ).',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Lý do ngắn.' } },
      required: ['reason'],
    },
  },
];

/**
 * Tool của lượt "Không đạt" (nhân viên bấm nút, bot báo người nhắn lần gửi chưa đạt — handoff-reject.ts): CHỈ `reply`
 * (Gemini mode ANY + allowedFunctionNames ⇒ model không thể escalate / no_reply).
 */
export const STAFF_REJECT_TOOLS: LlmFunctionDeclaration[] = CHATBOT_TOOLS.filter((t) => t.name === 'reply');

/**
 * Tool của lượt "Tái chăm sóc — Khách không bị bỏ sót" (bot chủ động nhắn khơi gợi): `reply` + `no_reply` (không
 * escalate, không `captured` / `project_logs`) ⇒ model được phép KHÔNG nhắn khi khách đã từ chối, bảo đừng nhắn nữa,
 * đã xong nhu cầu hoặc cuộc trò chuyện rõ ràng đã kết thúc.
 */
export const FOLLOWUP_TOOLS: LlmFunctionDeclaration[] = CHATBOT_TOOLS.filter(
  (t) => t.name === 'reply' || t.name === 'no_reply',
);

/** Lý do escalate chỉ dành cho bot "không chắc ⇒ chuyển người" (escalateWhenUnsure = true). */
export const UNSURE_REASON_CODES: readonly HandoffReasonCode[] = ['out_of_scope', 'low_confidence'];

/** Tên thuộc tính thu thập thông tin khách trong args của reply / escalate / no_reply. */
export const CAPTURED_ARG = 'captured';

/** Trường "Thu thập thông tin" đang dùng: bot bật thu thập ⇒ các trường enabled (theo thứ tự cấu hình); tắt ⇒ []. */
export function enabledCaptureFields(capture: CaptureConfig | undefined): CaptureField[] {
  if (!capture?.enabled) return [];
  return capture.fields.filter((f) => f.enabled);
}

/** Mô tả một trường trong tool/prompt: "<label>: <hint>" (hint rỗng ⇒ chỉ label), gọn trên một dòng. */
export function captureFieldDescription(field: Pick<CaptureField, 'label' | 'hint'>): string {
  const label = field.label.replace(/\s+/g, ' ').trim();
  const hint = field.hint.replace(/\s+/g, ' ').trim();
  return hint ? `${label}: ${hint}` : label;
}

/** Tên thuộc tính "Nhật ký công trình" trong args của reply / escalate (không có ở no_reply / lượt "Không đạt"). */
export const PROJECT_LOGS_ARG = 'project_logs';

/**
 * Trường "Nhật ký công trình" đang dùng: capture.projectLog.enabled ⇒ các trường enabled (theo thứ tự cấu hình);
 * tắt ⇒ []. Độc lập với capture.enabled (Ghi chú khách).
 */
export function enabledProjectLogFields(capture: CaptureConfig | undefined): CaptureField[] {
  const projectLog = capture?.projectLog;
  if (!projectLog?.enabled) return [];
  return projectLog.fields.filter((f) => f.enabled);
}

/**
 * JSON Schema của thuộc tính `project_logs`: mảng (≤ maxEntriesPerTurn) các object, mỗi trường bật một chuỗi, không
 * bắt buộc trường nào. (Gemini nhận qua parametersJsonSchema — cùng kiểu khai báo với `messages` có maxItems.)
 */
function projectLogsProperty(fields: readonly CaptureField[]): Record<string, unknown> {
  return {
    type: 'array',
    maxItems: PROJECT_LOG_LIMITS.maxEntriesPerTurn,
    description:
      'Nhật ký công trình (xem mục "Nhật ký công trình"): CHỈ điền khi trong lượt này người nhắn gửi một công trình MỚI (ảnh/thông tin) và lời bạn gửi xác nhận đã tiếp nhận; mỗi công trình khác nhau một phần tử. Chỉ điền trường đọc được chắc chắn, bỏ trường chưa biết. Không ảnh hưởng nội dung gửi người nhắn.',
    items: {
      type: 'object',
      properties: Object.fromEntries(
        fields.map((f) => [f.key, { type: 'string', description: captureFieldDescription(f) }]),
      ),
    },
  };
}

/** JSON Schema của thuộc tính `captured`: một chuỗi cho mỗi trường bật, không bắt buộc trường nào. */
function capturedProperty(fields: readonly CaptureField[]): Record<string, unknown> {
  return {
    type: 'object',
    description:
      'Thông tin người nhắn vừa TỰ cung cấp rõ ràng hoặc thay đổi trong các tin mới của lượt này (xem mục "Thu thập thông tin"). Chỉ điền trường đã biết chắc, dùng giá trị mới nhất; bỏ trường chưa biết hoặc không đổi. Không ảnh hưởng nội dung gửi người nhắn.',
    properties: Object.fromEntries(
      fields.map((f) => [f.key, { type: 'string', description: captureFieldDescription(f) }]),
    ),
  };
}

/**
 * Tool cho một bot. escalateWhenUnsure = false ⇒ enum reason_code của `escalate` bỏ UNSURE_REASON_CODES
 * (model không thể chuyển người vì "ngoài phạm vi / không chắc"; vẫn chuyển được theo Hướng dẫn / Mặc định
 * với lý do khác). Bật ⇒ đúng CHATBOT_TOOLS.
 * Bot bật "Thu thập thông tin" (capture.enabled + ≥ 1 trường bật — enabledCaptureFields) ⇒ cả 3 tool có thêm thuộc
 * tính TÙY CHỌN `captured` (object, mỗi trường bật một chuỗi, mô tả = nhãn + gợi ý); không bắt buộc. Tắt ⇒ tool giữ
 * nguyên như trước (tiền tố ổn định cho cache ngầm). STAFF_REJECT_TOOLS (lượt "Không đạt") không bao giờ có `captured`.
 * Bot bật "Nhật ký công trình" (capture.projectLog.enabled + ≥ 1 trường bật — enabledProjectLogFields) ⇒ RIÊNG reply và
 * escalate có thêm thuộc tính TÙY CHỌN `project_logs` (mảng ≤ PROJECT_LOG_LIMITS.maxEntriesPerTurn object, mỗi trường
 * bật một chuỗi). no_reply và STAFF_REJECT_TOOLS không bao giờ có.
 */
export function buildChatbotTools(
  chatbot: Pick<ChatbotConfig, 'escalateWhenUnsure'> & Partial<Pick<ChatbotConfig, 'capture'>>,
): LlmFunctionDeclaration[] {
  const fields = enabledCaptureFields(chatbot.capture);
  const logFields = enabledProjectLogFields(chatbot.capture);
  if (chatbot.escalateWhenUnsure && fields.length === 0 && logFields.length === 0) return CHATBOT_TOOLS;
  const allowed = HANDOFF_REASON_CODES.filter((c) => !UNSURE_REASON_CODES.includes(c));
  const captured = fields.length > 0 ? capturedProperty(fields) : null;
  const projectLogs = logFields.length > 0 ? projectLogsProperty(logFields) : null;
  return CHATBOT_TOOLS.map((tool) => {
    const params = tool.parameters as { properties: Record<string, unknown> };
    const properties: Record<string, unknown> = { ...params.properties };
    if (tool.name === 'escalate' && !chatbot.escalateWhenUnsure) {
      properties.reason_code = { type: 'string', enum: allowed };
    }
    if (captured) properties[CAPTURED_ARG] = captured;
    const withLogs = projectLogs !== null && (tool.name === 'reply' || tool.name === 'escalate');
    if (withLogs) properties[PROJECT_LOGS_ARG] = projectLogs;
    if (properties.reason_code === params.properties.reason_code && !captured && !withLogs) return tool;
    return { ...tool, parameters: { ...tool.parameters, properties } };
  });
}

/**
 * Cắt chuỗi còn tối đa `max` ký tự (tính cả '…'), ưu tiên cắt ở khoảng trắng gần cuối (trong 20% cuối)
 * để không đứt giữa từ. Chuỗi ngắn hơn giữ nguyên.
 */
export function truncateAtWord(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const head = chars.slice(0, Math.max(0, max - 1)).join('');
  const cut = head.search(/\s\S*$/);
  const minKeep = Math.floor(max * 0.8);
  const base = cut >= minKeep ? head.slice(0, cut) : head;
  return `${base.trimEnd()}…`;
}

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;

/** Tóm tắt cho nhân viên: bỏ link (chống chèn link lừa đảo qua prompt injection), gọn khoảng trắng, ≤ 500. */
export function sanitizeAgentSummary(text: string): string {
  const cleaned = text.replace(URL_RE, '[link]').replace(/\s+/g, ' ').trim();
  return truncateAtWord(cleaned, CHATBOT_MAX_SUMMARY_CHARS);
}

/** Giới hạn kích thước args ghi vào ai_runs.tool_calls: chuỗi ≤ 2000 ký tự, mảng ≤ 10 phần tử, sâu ≤ 4. */
export function boundToolArgsForLog(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return truncateAtWord(value, 2000);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 4) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 10).map((v) => boundToolArgsForLog(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value).slice(0, 20))
    out[k.slice(0, 100)] = boundToolArgsForLog(v, depth + 1);
  return out;
}
