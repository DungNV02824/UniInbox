// "Tốc độ trả lời" của bot (ChatbotDto.responseSpeed) ⇒ mức suy nghĩ (thinking) của LLM.
import { CHATBOT_DEFAULTS, type ResponseSpeed } from '@dezon/shared';

/**
 * Mức suy nghĩ trung lập nhà cung cấp (LlmRequest.thinking). Gemini 3.x nhận `thinkingConfig.thinkingLevel`
 * MINIMAL | LOW | MEDIUM | HIGH (SDK @google/genai enum ThinkingLevel); Gemini 3.5+ BÁO LỖI nếu gửi
 * `thinkingBudget` — xem geminiThinkingConfig trong llm.ts (agent core-llm cài).
 */
export const LLM_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;
export type LlmThinking = (typeof LLM_THINKING_LEVELS)[number];

/**
 * Bảng ánh xạ, chọn từ đo thật gemini-3.5-flash ngày 2026-11-09 (prompt bot "tiếp nhận ảnh thi công CTV" thật
 * ~2 KB hướng dẫn + kiến thức + 3 ví dụ, lịch sử 2 tin, CHATBOT_TOOLS mode ANY; mỗi mức 1–2 lần gọi):
 *
 * | responseSpeed | thinking  | độ trễ đo (ms)  | token suy nghĩ | gọi tool đúng |
 * |---------------|-----------|-----------------|----------------|---------------|
 * | fast          | 'minimal' | 1870, 1587      | 0              | 2/2 reply     |
 * | balanced      | 'low'     | 4343, 1867      | 551, 79        | 2/2 reply     |
 * | thorough      | 'high'    | 9083            | 1562           | 1/1 reply     |
 * | (không gửi)   | mặc định  | 4858, 2473      | 728, 284       | 2/2 reply     |
 * | (tham khảo)   | 'medium'  | 4203            | 554            | 1/1 reply     |
 *
 * 'minimal' là mức thấp nhất model nhận và vẫn luôn trả function call hợp lệ ⇒ dùng cho 'fast'.
 */
export const THINKING_BY_SPEED: Record<ResponseSpeed, LlmThinking> = {
  fast: 'minimal',
  balanced: 'low',
  thorough: 'high',
};

/** responseSpeed của bot (thiếu/null ⇒ CHATBOT_DEFAULTS.responseSpeed = 'fast') ⇒ LlmRequest.thinking. */
export function thinkingForSpeed(speed: ResponseSpeed | null | undefined): LlmThinking {
  return THINKING_BY_SPEED[speed ?? CHATBOT_DEFAULTS.responseSpeed];
}
