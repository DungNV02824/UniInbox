// Chuyển dòng chatbots (hoặc bot + draft của "Chat thử") thành ChatbotConfig cho orchestrator.
import type { Chatbot } from '@dezon/db';
import {
  captureConfigSchema,
  DEFAULT_CAPTURE_CONFIG,
  type CaptureConfig,
  type CaptureFieldRef,
  type CreateChatbotRequest,
} from '@dezon/shared';
import type { ChatbotConfig } from './types';

/**
 * chatbots.capture (jsonb) ⇒ CaptureConfig. NULL (bot cũ chưa cấu hình) hoặc sai dạng ⇒ DEFAULT_CAPTURE_CONFIG (tắt) —
 * không bao giờ ném (lượt bot không được hỏng vì cấu hình thu thập).
 * projectLog (Nhật ký công trình): cấu hình cũ chưa có ⇒ DEFAULT_PROJECT_LOG_CONFIG (schema default); riêng phần
 * projectLog sai dạng ⇒ chỉ projectLog về mặc định (tắt), phần "Ghi chú khách" hợp lệ vẫn giữ.
 */
export function parseCaptureConfig(raw: unknown): CaptureConfig {
  if (raw === null || raw === undefined) return DEFAULT_CAPTURE_CONFIG;
  const parsed = captureConfigSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  if (typeof raw === 'object' && !Array.isArray(raw) && 'projectLog' in raw) {
    const withoutLog = captureConfigSchema.safeParse({ ...raw, projectLog: undefined });
    if (withoutLog.success) return withoutLog.data;
  }
  return DEFAULT_CAPTURE_CONFIG;
}

/**
 * chatbots.capture (jsonb) ⇒ các trường đang bật { key, label } theo thứ tự cấu hình, cho ChatbotRef.captureFields.
 * Thu thập tắt / chưa cấu hình / sai dạng / không trường nào bật ⇒ undefined (không kèm vào ref).
 */
export function captureFieldRefs(raw: unknown): CaptureFieldRef[] | undefined {
  if (raw === null || raw === undefined) return undefined;
  const config = parseCaptureConfig(raw);
  if (!config.enabled) return undefined;
  const refs = config.fields.filter((f) => f.enabled).map((f) => ({ key: f.key, label: f.label }));
  return refs.length > 0 ? refs : undefined;
}

/** Ghép bot đã lưu với bản nháp chưa lưu (trường có trong draft ghi đè). */
export function toChatbotConfig(
  row: Pick<
    Chatbot,
    | 'id'
    | 'name'
    | 'instructions'
    | 'knowledge'
    | 'examples'
    | 'handoffKeywords'
    | 'handoffMessage'
    | 'model'
    | 'temperature'
    | 'escalateWhenUnsure'
    | 'responseSpeed'
    | 'notifyKeywords'
    | 'aiHandoffMode'
  > &
    // Tùy chọn: bot nháp của "Chat thử" (chưa lưu) dựng từ mặc định có thể chưa có cột này.
    Partial<Pick<Chatbot, 'capture'>>,
  draft?: Partial<CreateChatbotRequest>,
): ChatbotConfig {
  return {
    id: row.id,
    name: draft?.name ?? row.name,
    instructions: draft?.instructions ?? row.instructions,
    knowledge: draft?.knowledge ?? row.knowledge,
    examples: draft?.examples ?? row.examples,
    handoffKeywords: draft?.handoffKeywords ?? row.handoffKeywords,
    handoffMessage: draft?.handoffMessage !== undefined ? draft.handoffMessage : row.handoffMessage,
    model: draft?.model !== undefined ? draft.model : row.model,
    temperature: draft?.temperature ?? row.temperature,
    escalateWhenUnsure: draft?.escalateWhenUnsure ?? row.escalateWhenUnsure,
    responseSpeed: draft?.responseSpeed ?? row.responseSpeed,
    notifyKeywords: draft?.notifyKeywords ?? row.notifyKeywords,
    aiHandoffMode: draft?.aiHandoffMode ?? row.aiHandoffMode,
    capture: parseCaptureConfig(draft?.capture ?? row.capture),
  };
}
