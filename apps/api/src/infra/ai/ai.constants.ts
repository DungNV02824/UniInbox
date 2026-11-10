/** LlmClient của @dezon/core (Gemini); null = chưa cấu hình GEMINI_API_KEY. */
export const LLM_CLIENT = Symbol('LLM_CLIENT');
/** Hàm liệt kê model Gemini dùng được (null = chưa có key ⇒ chỉ GEMINI_MODEL). */
export const GEMINI_MODEL_LISTER = Symbol('GEMINI_MODEL_LISTER');
/** `fetch` dùng cho webhook Lark (test thay bằng fetch giả). */
export const HTTP_FETCH = Symbol('HTTP_FETCH');

export type GeminiModelLister = () => Promise<string[]>;

export const LLM_NOT_CONFIGURED_MESSAGE =
  'Chưa cấu hình GEMINI_API_KEY trên máy chủ nên chưa chạy thử chatbot được';
