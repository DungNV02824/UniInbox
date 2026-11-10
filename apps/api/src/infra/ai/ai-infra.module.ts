import { createGeminiClient, listGeminiModels, type LlmClient } from '@dezon/core';
import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config';
import { GEMINI_MODEL_LISTER, type GeminiModelLister, HTTP_FETCH, LLM_CLIENT } from './ai.constants';

export interface AiInfraOverrides {
  /** LlmClient giả (test); null = coi như chưa có GEMINI_API_KEY. */
  llm?: LlmClient | null;
  /** Liệt kê model giả (test); null = chưa có key. */
  geminiModels?: GeminiModelLister | null;
  /** fetch giả cho webhook Lark (test). */
  fetch?: typeof fetch;
}

/**
 * Client Gemini tạo trễ ở lần gọi đầu: lỗi khởi tạo (key sai định dạng...) không làm hỏng việc khởi động API,
 * chỉ làm lượt chạy thử đó lỗi (orchestrator đổi thành decision 'error').
 */
export function createLazyLlmClient(config: AppConfig): LlmClient | null {
  const apiKey = config.GEMINI_API_KEY;
  if (!apiKey) return null;
  let client: LlmClient | undefined;
  return { generate: (req) => (client ??= createGeminiClient(apiKey)).generate(req) };
}

/** Chỉ giữ họ "gemini" (bỏ gemma/embedding... không dùng cho chatbot). */
export function createModelLister(config: AppConfig): GeminiModelLister | null {
  const apiKey = config.GEMINI_API_KEY;
  if (!apiKey) return null;
  return async () => (await listGeminiModels(apiKey)).filter((name) => name.startsWith('gemini'));
}

function valueOr<T>(token: symbol, value: T | undefined, factory: (config: AppConfig) => T): Provider {
  return value !== undefined
    ? { provide: token, useValue: value }
    : { provide: token, inject: [APP_CONFIG], useFactory: factory };
}

/** Phụ thuộc bên ngoài của tính năng Chatbot AI (LLM, danh sách model, fetch cho Lark). */
@Global()
@Module({})
export class AiInfraModule {
  static forRoot(overrides: AiInfraOverrides = {}): DynamicModule {
    return {
      module: AiInfraModule,
      global: true,
      providers: [
        valueOr(LLM_CLIENT, overrides.llm, createLazyLlmClient),
        valueOr(GEMINI_MODEL_LISTER, overrides.geminiModels, createModelLister),
        {
          provide: HTTP_FETCH,
          useValue: overrides.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
        },
      ],
      exports: [LLM_CLIENT, GEMINI_MODEL_LISTER, HTTP_FETCH],
    };
  }
}
