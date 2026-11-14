// Ba tool bot BẮT BUỘC gọi đúng một (mục 7.3): reply / escalate / no_reply. Khai báo + Zod parse args.
import { HANDOFF_REASON_CODES, type HandoffReasonCode } from '@dezon/shared';
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

/** Model có thể trả nhiều hơn 3 bong bóng dù khai báo maxItems: nhận hết rồi orchestrator cắt còn 3. */
export const replyArgsSchema = z.object({
  messages: z.array(z.string()).min(1),
  confidence: z.number().min(0).max(1),
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
});
export type EscalateArgs = z.infer<typeof escalateArgsSchema>;

export const noReplyArgsSchema = z.object({ reason: z.string() });
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

/** Lý do escalate chỉ dành cho bot "không chắc ⇒ chuyển người" (escalateWhenUnsure = true). */
export const UNSURE_REASON_CODES: readonly HandoffReasonCode[] = ['out_of_scope', 'low_confidence'];

/**
 * Tool cho một bot. escalateWhenUnsure = false ⇒ enum reason_code của `escalate` bỏ UNSURE_REASON_CODES
 * (model không thể chuyển người vì "ngoài phạm vi / không chắc"; vẫn chuyển được theo Hướng dẫn / Mặc định
 * với lý do khác). Bật ⇒ đúng CHATBOT_TOOLS.
 */
export function buildChatbotTools(
  chatbot: Pick<ChatbotConfig, 'escalateWhenUnsure'>,
): LlmFunctionDeclaration[] {
  if (chatbot.escalateWhenUnsure) return CHATBOT_TOOLS;
  const allowed = HANDOFF_REASON_CODES.filter((c) => !UNSURE_REASON_CODES.includes(c));
  return CHATBOT_TOOLS.map((tool) => {
    if (tool.name !== 'escalate') return tool;
    const params = tool.parameters as { properties: Record<string, unknown> };
    return {
      ...tool,
      parameters: {
        ...tool.parameters,
        properties: { ...params.properties, reason_code: { type: 'string', enum: allowed } },
      },
    };
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
