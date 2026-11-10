import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config';
import { GEMINI_MODEL_LISTER, type GeminiModelLister } from '../../infra/ai/ai.constants';

/** GET /chatbots/models */
export interface ChatbotModelsResponse {
  /** GEMINI_MODEL của server — bot để trống model sẽ dùng model này. */
  defaultModel: string;
  /** Model chọn được (luôn có defaultModel). */
  models: string[];
}

const CACHE_TTL_MS = 60 * 60 * 1000;

/** Danh sách model Gemini cho ô chọn của admin; cache 1 giờ, lỗi ⇒ chỉ trả GEMINI_MODEL. */
@Injectable()
export class ChatbotModelsService {
  private readonly logger = new Logger(ChatbotModelsService.name);
  private cache: { models: string[]; expiresAt: number } | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(GEMINI_MODEL_LISTER) private readonly lister: GeminiModelLister | null,
  ) {}

  async list(): Promise<ChatbotModelsResponse> {
    const defaultModel = this.config.GEMINI_MODEL;
    return { defaultModel, models: withDefault(await this.fetchCached(), defaultModel) };
  }

  private async fetchCached(): Promise<string[]> {
    if (!this.lister) return [];
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.models;
    try {
      const models = await this.lister();
      this.cache = { models, expiresAt: now + CACHE_TTL_MS };
      return models;
    } catch (error) {
      // Không cache lỗi: lần sau thử lại.
      this.logger.warn(
        `Không liệt kê được model Gemini: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }
}

function withDefault(models: string[], defaultModel: string): string[] {
  return models.includes(defaultModel) ? models : [defaultModel, ...models];
}
