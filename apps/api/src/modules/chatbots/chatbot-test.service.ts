import {
  type ChatbotConfig,
  type ChatHistoryItem,
  type ChatbotTurnResult,
  getBusinessHours,
  InboxNotFoundError,
  type LlmClient,
  type PromptImage,
  runChatbotTurn,
  toChatbotConfig,
} from '@dezon/core';
import { chatbots, type Db } from '@dezon/db';
import {
  CHATBOT_DEFAULTS,
  type ChatbotTestRequest,
  type ChatbotTestResult,
  type CreateChatbotRequest,
} from '@dezon/shared';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { SlidingWindowLimiter } from '../../common/rate-limiter';
import { APP_CONFIG, type AppConfig } from '../../config';
import { LLM_CLIENT, LLM_NOT_CONFIGURED_MESSAGE } from '../../infra/ai/ai.constants';
import { DB } from '../../infra/db/db.constants';
import { resolveTestImageMime } from './chatbot-test-images';

/** Tên kênh hiển thị trong prompt khi chạy thử. */
export const TEST_CHANNEL_NAME = 'Chat thử';
/** Mỗi admin tối đa 20 lượt chạy thử / phút (bảo vệ quota API key). */
export const TEST_RATE_LIMIT = { limit: 20, windowMs: 60_000 } as const;

type TestMessage = ChatbotTestRequest['messages'][number];

/**
 * Tách khung chat thử: các tin KHÁCH ở cuối là tin mới cần trả lời, phần trước là lịch sử.
 * Tin cuối không phải của khách ⇒ 400 (bot không có gì để trả lời).
 *
 * Ảnh: mọi ảnh của các tin khách ở cuối thành `images` của lượt (theo thứ tự gửi; trong một tin theo thứ tự
 * đính kèm) — core tự áp giới hạn số ảnh / dung lượng và đánh nhãn "Ảnh k/N". Ảnh ở tin khách trong phần lịch
 * sử KHÔNG gửi cho model (core chỉ nhận ảnh của tin mới, giống chạy thật: ảnh đã xử lý ở lượt trước không gửi
 * lại); dòng lịch sử vẫn ghi "[gửi N ảnh/tệp]" như chạy thật — web gửi tin khách của lượt cũ chỉ kèm `imageCount`
 * (không gửi lại ảnh, text có thể rỗng): attachmentCount = max(imageCount, số ảnh gửi kèm), text rỗng ⇒ null.
 * Ảnh không phải JPEG/PNG/WebP/GIF ⇒ 400.
 */
export function splitTestMessages(messages: TestMessage[]): {
  history: ChatHistoryItem[];
  newMessages: ChatHistoryItem[];
  images: PromptImage[];
} {
  let cut = messages.length;
  while (cut > 0 && messages[cut - 1]!.role === 'customer') cut--;
  if (cut === messages.length) {
    throw new BadRequestException('Tin cuối cùng trong khung chat thử phải là tin của khách');
  }
  const toItem = (m: TestMessage): ChatHistoryItem => {
    // Lượt cũ không gửi lại ảnh, chỉ báo số lượng (imageCount) ⇒ dòng lịch sử vẫn ghi "[gửi N ảnh/tệp]".
    const count = Math.max(m.imageCount ?? 0, m.images?.length ?? 0);
    return { role: m.role, text: m.text || null, ...(count > 0 ? { attachmentCount: count } : {}) };
  };
  // Đánh số ảnh trên toàn khung chat (khớp thứ tự admin thấy) cho thông điệp lỗi.
  let position = 0;
  const images: PromptImage[] = [];
  messages.forEach((m, index) => {
    for (const img of m.images ?? []) {
      position++;
      const mime = resolveTestImageMime(img.data, `Ảnh thứ ${position}`);
      // messageIndex (1-based trong các tin mới) ⇒ nhãn ảnh ghi "(tin thứ m trong lượt này)".
      if (index >= cut) images.push({ mime, data: img.data, messageIndex: index - cut + 1 });
    }
  });
  return {
    history: messages.slice(0, cut).map(toItem),
    newMessages: messages.slice(cut).map(toItem),
    images,
  };
}

/**
 * Tin người nhắn thật sự nhận ở lượt này (ChatbotTestResult.messages), khớp runtime: reply ⇒ bong bóng; escalate ⇒
 * messages_to_customer (orchestrator đưa vào result.messages) nếu có, không thì handoffMessage; error (runtime chuyển
 * người) ⇒ handoffMessage; no_reply ⇒ [].
 */
export function customerFacingMessages(
  result: Pick<ChatbotTurnResult, 'decision' | 'messages'>,
  handoffMessage: string | null,
): string[] {
  const handoff = handoffMessage?.trim() ? [handoffMessage.trim()] : [];
  switch (result.decision) {
    case 'reply':
      return result.messages ?? [];
    case 'escalate':
      return result.messages?.length ? result.messages : handoff;
    case 'error':
      return handoff;
    default:
      return [];
  }
}

/** Bot chưa lưu: bắt đầu từ mặc định của bảng chatbots rồi ghép bản nháp. */
function draftConfig(draft: CreateChatbotRequest): ChatbotConfig {
  const base = {
    id: '',
    name: draft.name,
    instructions: '',
    knowledge: '',
    examples: [],
    handoffKeywords: [],
    handoffMessage: null,
    model: null,
    temperature: CHATBOT_DEFAULTS.temperature,
    escalateWhenUnsure: CHATBOT_DEFAULTS.escalateWhenUnsure,
    responseSpeed: CHATBOT_DEFAULTS.responseSpeed,
  };
  return { ...toChatbotConfig(base, draft), id: null };
}

/** "Chat thử": chạy đúng orchestrator/prompt thật nhưng KHÔNG gửi tin và KHÔNG ghi DB hội thoại. */
@Injectable()
export class ChatbotTestService {
  private readonly limiter = new SlidingWindowLimiter(TEST_RATE_LIMIT.limit, TEST_RATE_LIMIT.windowMs);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LLM_CLIENT) private readonly llm: LlmClient | null,
  ) {}

  /** Bot đã lưu (+ bản nháp ghi đè nếu có). */
  async testSaved(actorUserId: string, id: string, input: ChatbotTestRequest): Promise<ChatbotTestResult> {
    const llm = this.guard(actorUserId);
    const [row] = await this.db.select().from(chatbots).where(eq(chatbots.id, id)).limit(1);
    if (!row) throw new InboxNotFoundError('Không tìm thấy chatbot');
    return this.run(llm, toChatbotConfig(row, input.draft), input.messages);
  }

  /** Bot chưa lưu lần nào. */
  async testDraft(
    actorUserId: string,
    draft: CreateChatbotRequest,
    messages: TestMessage[],
  ): Promise<ChatbotTestResult> {
    const llm = this.guard(actorUserId);
    return this.run(llm, draftConfig(draft), messages);
  }

  private guard(actorUserId: string): LlmClient {
    if (!this.llm) throw new ServiceUnavailableException(LLM_NOT_CONFIGURED_MESSAGE);
    if (!this.limiter.take(actorUserId)) {
      throw new HttpException(
        'Bạn chạy thử quá nhiều lần trong một phút, vui lòng đợi một chút',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.llm;
  }

  private async run(
    llm: LlmClient,
    chatbot: ChatbotConfig,
    messages: TestMessage[],
  ): Promise<ChatbotTestResult> {
    const { history, newMessages, images } = splitTestMessages(messages);
    const businessHours = await getBusinessHours(this.db);
    const result = await runChatbotTurn(
      {
        llm,
        now: () => new Date(),
        defaultModel: this.config.GEMINI_MODEL,
        minConfidence: this.config.AI_MIN_CONFIDENCE,
      },
      {
        chatbot,
        history,
        newMessages,
        channelName: TEST_CHANNEL_NAME,
        businessHours,
        ...(images.length > 0 ? { images } : {}),
      },
    );
    return {
      decision: result.decision,
      messages: customerFacingMessages(result, chatbot.handoffMessage),
      ...(result.reasonCode !== undefined ? { reasonCode: result.reasonCode } : {}),
      ...(result.summary !== undefined ? { summary: result.summary } : {}),
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      latencyMs: result.latencyMs,
      model: result.model,
      usage: result.usage,
    };
  }
}
