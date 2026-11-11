// Chuyển dòng chatbots (hoặc bot + draft của "Chat thử") thành ChatbotConfig cho orchestrator.
import type { Chatbot } from '@dezon/db';
import type { CreateChatbotRequest } from '@dezon/shared';
import type { ChatbotConfig } from './types';

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
  >,
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
  };
}
