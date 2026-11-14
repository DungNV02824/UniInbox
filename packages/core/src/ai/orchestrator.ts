// Một lượt chatbot (thuần, không DB): pre-filter ⇒ prompt ⇒ LLM (retry) ⇒ quyết định.
// Dùng chung cho job ai-reply (runtime.ts) và "Chat thử" (POST /chatbots/:id/test).
import {
  HANDOFF_REASON_LABELS,
  type BusinessHours,
  type ChatbotTestImage,
  type LlmUsage,
} from '@dezon/shared';
import { claimsHandoffInReply } from './handoff-claim';
import { LlmError, type LlmClient, type LlmContent, type LlmRequest, type LlmResponse } from './llm';
import { keywordHandoffReason, matchHandoffKeyword } from './prefilter';
import { buildChatbotPrompt, llmTimeoutExtraMsForImages, type ReengageGuidance } from './prompt';
import { thinkingForSpeed } from './speed';
import {
  boundToolArgsForLog,
  CHATBOT_MAX_BUBBLE_CHARS,
  CHATBOT_MAX_BUBBLES,
  CHATBOT_MAX_HANDOFF_MESSAGES,
  CHATBOT_MAX_REASON_CHARS,
  buildChatbotTools,
  escalateArgsSchema,
  noReplyArgsSchema,
  replyArgsSchema,
  sanitizeAgentSummary,
  STAFF_REJECT_TOOLS,
  truncateAtWord,
} from './tools';
import type { ChatHistoryItem, ChatbotConfig, ChatbotTurnResult, PromptImage } from './types';

/** Timeout mỗi lần gọi LLM. */
export const LLM_TIMEOUT_MS = 30_000;
/** Số lần thử lại khi LlmError.retryable. */
export const LLM_MAX_RETRIES = 2;
/**
 * Lượt có ảnh: hết thời gian chờ chỉ thử lại chừng này lần (timeout đã nới theo số ảnh — 3 lần × ~60 s quá lâu cho
 * khách). Lỗi tạm thời khác vẫn thử lại LLM_MAX_RETRIES lần.
 */
export const LLM_MAX_TIMEOUT_RETRIES_WITH_IMAGES = 1;
/** confidence < ngưỡng này ⇒ escalate low_confidence (env AI_MIN_CONFIDENCE). */
export const DEFAULT_MIN_CONFIDENCE = 0.6;
/** Độ tự tin gán cho câu trả lời dạng chữ thường (model không gọi tool) — xem runChatbotTurn. */
export const TEXT_FALLBACK_CONFIDENCE = 0.7;
/** Chữ thường dài hơn ngưỡng này không được coi là câu trả lời. */
export const TEXT_FALLBACK_MAX_CHARS = 600;

export interface ChatbotTurnDeps {
  llm: LlmClient;
  now: () => Date;
  /** GEMINI_MODEL — dùng khi chatbot.model null. */
  defaultModel: string;
  /** AI_MIN_CONFIDENCE, mặc định DEFAULT_MIN_CONFIDENCE. */
  minConfidence?: number;
  /** Mặc định LLM_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Chờ giữa các lần thử lại (test truyền hàm không chờ). Mặc định backoff 500ms × lần thử. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ChatbotTurnInput {
  chatbot: ChatbotConfig;
  history: ChatHistoryItem[];
  /** Tin khách mới chưa xử lý (≥ 1 khi chạy thật). */
  newMessages: ChatHistoryItem[];
  channelName: string;
  businessHours: BusinessHours;
  /**
   * MỌI ảnh trong `newMessages` theo thứ tự gửi (cũ ⇒ mới), kể cả ảnh không đọc được (`skipped`) — xem
   * PromptImage. Job ai-reply lấy từ loadPromptImages; "Chat thử" dựng bằng promptImagesFromTest. Prompt tự áp
   * giới hạn (10 ảnh mới nhất, ≤ 4 MB/ảnh, tổng ≤ 13,5 MB) và đánh nhãn
   * "Ảnh k/N — thuộc tin lúc HH:MM:SS (tin thứ m trong lượt này):".
   */
  images?: PromptImage[];
  /**
   * Lượt "Tái chăm sóc" (runtime, AiReplyJobData.reengage): giờ gửi của tin khách chưa xử lý cũ nhất ⇒ prompt thêm
   * ghi chú "trả lời muộn, mở đầu bằng lời xin lỗi ngắn" (buildChatbotPrompt lateReplySince). Thiếu ⇒ lượt thường.
   */
  lateReplySince?: Date;
  /** Lượt "Tái chăm sóc": chỉ dẫn admin gõ tay lúc bấm (buildChatbotPrompt reengageGuidance). Thiếu ⇒ không có. */
  reengageGuidance?: ReengageGuidance;
  /**
   * Lượt "Không đạt" (rejectHandoffWithAiReply): lý do nhân viên gõ ⇒ prompt thêm staffRejectTurnNote, tools CHỈ
   * `reply` (STAFF_REJECT_TOOLS), KHÔNG escalate vì độ tự tin thấp, không pre-filter từ khóa, không ghi chú handoff
   * 'continue', không chạy bộ chặn "tự nói đã chuyển" (không bao giờ đổi thành escalate). Thiếu ⇒ lượt thường.
   */
  staffRejectReason?: string;
}

/**
 * Ảnh "Chat thử" (ChatbotTestRequest.messages[].images, đã qua Zod) ⇒ PromptImage. API gọi cho từng tin khách MỚI
 * theo thứ tự rồi nối lại; `sentAt` (tùy chọn) = giờ của tin để nhãn ghi "thuộc tin lúc HH:MM:SS";
 * `messageIndex` (tùy chọn, 1-based trong các tin mới) để nhãn ghi "(tin thứ m trong lượt này)". Tin chứa ảnh nên
 * có `attachmentCount` = số ảnh để dòng hội thoại ghi "[gửi N ảnh/tệp]".
 */
export function promptImagesFromTest(
  images: readonly Pick<ChatbotTestImage, 'mimeType' | 'data'>[] | undefined,
  sentAt?: Date,
  messageIndex?: number,
): PromptImage[] {
  return (images ?? []).map((img) => ({
    mime: img.mimeType,
    data: img.data,
    ...(sentAt ? { sentAt } : {}),
    ...(messageIndex !== undefined ? { messageIndex } : {}),
  }));
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Decided = Omit<ChatbotTurnResult, 'usage' | 'model' | 'latencyMs' | 'toolCalls'>;

function errorDecision(reason: string): Decided {
  return { decision: 'error', reasonCode: 'other', reason: truncateAtWord(reason, CHATBOT_MAX_REASON_CHARS) };
}

/** trim, bỏ bong bóng rỗng, tối đa `max` (CHATBOT_MAX_BUBBLES), mỗi bong bóng ≤ CHATBOT_MAX_BUBBLE_CHARS. */
function cleanBubbles(messages: readonly string[], max: number = CHATBOT_MAX_BUBBLES): string[] {
  return messages
    .map((m) => m.trim())
    .filter((m) => m.length > 0)
    .slice(0, max)
    .map((m) => truncateAtWord(m, CHATBOT_MAX_BUBBLE_CHARS));
}

/**
 * Ngưỡng độ tự tin áp cho lượt này: null = không escalate vì độ tự tin thấp (bot đặt
 * escalateWhenUnsure = false ⇒ vẫn gửi câu trả lời).
 */
type MinConfidence = number | null;

function replyDecision(messages: string[], confidence: number, minConfidence: MinConfidence): Decided {
  if (messages.length === 0) return errorDecision('AI trả lời rỗng');
  if (minConfidence !== null && confidence < minConfidence) {
    return {
      decision: 'escalate',
      reasonCode: 'low_confidence',
      summary: `AI không chắc câu trả lời (độ tự tin ${confidence.toFixed(2)})`,
      // KHÔNG mang `messages`: với escalate, `messages` là tin GỬI khách (câu trả lời không chắc thì không gửi;
      // nội dung vẫn có trong toolCalls để xem log).
      confidence,
    };
  }
  return { decision: 'reply', messages, confidence };
}

/**
 * Model trả chữ thường thay vì gọi tool (hiếm khi mode ANY): coi là reply với độ tin
 * TEXT_FALLBACK_CONFIDENCE nếu chữ ngắn (≤ TEXT_FALLBACK_MAX_CHARS) và không giống mã/JSON/markdown;
 * tách đoạn theo dòng trống/xuống dòng thành ≤ 3 bong bóng. Ngược lại ⇒ error.
 */
function textFallback(text: string | null, minConfidence: MinConfidence): Decided {
  const t = text?.trim() ?? '';
  if (!t) return errorDecision('AI không gọi công cụ nào và không có nội dung');
  if (t.length > TEXT_FALLBACK_MAX_CHARS || /[{}`#*]|<\/?\w/.test(t)) {
    return errorDecision('AI không gọi công cụ và trả về chữ không dùng được');
  }
  const paragraphs = t.split(/\n+/);
  const bubbles = cleanBubbles(
    paragraphs.length > CHATBOT_MAX_BUBBLES
      ? [...paragraphs.slice(0, CHATBOT_MAX_BUBBLES - 1), paragraphs.slice(CHATBOT_MAX_BUBBLES - 1).join(' ')]
      : paragraphs,
  );
  return replyDecision(bubbles, TEXT_FALLBACK_CONFIDENCE, minConfidence);
}

function decide(res: LlmResponse, minConfidence: MinConfidence): Decided {
  const call = res.functionCall;
  if (!call) return textFallback(res.text, minConfidence);
  switch (call.name) {
    case 'reply': {
      const parsed = replyArgsSchema.safeParse(call.args);
      if (!parsed.success) return errorDecision('AI gọi reply với tham số không hợp lệ');
      return replyDecision(cleanBubbles(parsed.data.messages), parsed.data.confidence, minConfidence);
    }
    case 'escalate': {
      const parsed = escalateArgsSchema.safeParse(call.args);
      if (!parsed.success) return errorDecision('AI gọi escalate với tham số không hợp lệ');
      const summary =
        sanitizeAgentSummary(parsed.data.summary_for_agent) || HANDOFF_REASON_LABELS[parsed.data.reason_code];
      const messages = cleanBubbles(parsed.data.messages_to_customer ?? [], CHATBOT_MAX_HANDOFF_MESSAGES);
      return {
        decision: 'escalate',
        reasonCode: parsed.data.reason_code,
        summary,
        ...(messages.length > 0 ? { messages } : {}),
      };
    }
    case 'no_reply': {
      const parsed = noReplyArgsSchema.safeParse(call.args);
      if (!parsed.success) return errorDecision('AI gọi no_reply với tham số không hợp lệ');
      return {
        decision: 'no_reply',
        reason: truncateAtWord(parsed.data.reason.trim(), CHATBOT_MAX_REASON_CHARS),
      };
    }
    default:
      return errorDecision(`AI gọi công cụ không tồn tại: ${call.name.slice(0, 50)}`);
  }
}

export { claimsHandoffInReply } from './handoff-claim';

/**
 * Tên mục ghi vào ai_runs.tool_calls khi chặn reply tự nói "đã chuyển nhân viên": args.action 'retry' (gọi lại model
 * một lần kèm ghi chú) hoặc 'convert' (vẫn nói vậy ⇒ hệ thống đổi thành escalate 'other'). Runtime đọc để biết
 * reason_code khi escalate bù.
 */
export const HANDOFF_CLAIM_GUARD = 'handoff_claim_guard';

/** Ghi chú thêm vào cuối prompt cho lần gọi lại (sau khi reply tự nói đã chuyển mà không gọi escalate). */
export const HANDOFF_CLAIM_CORRECTION =
  'Lượt trước bạn nói đã chuyển cho nhân viên nhưng không gọi escalate. Nếu cần chuyển thì gọi escalate và đặt lời nhắn vào messages_to_customer; nếu không thì trả lời lại, không nói đã chuyển.';

/** Part chữ của lần gọi lại: ghi chú + các bong bóng model định gửi (để model dùng lại trong messages_to_customer). */
export function handoffCorrectionText(bubbles: readonly string[]): string {
  const quoted = bubbles.map((b) => `"${b.replace(/\s+/g, ' ')}"`).join(' / ');
  return `(Ghi chú của hệ thống, không phải lời người nhắn) ${HANDOFF_CLAIM_CORRECTION} Các bong bóng bạn định gửi ở lượt trước: ${quoted}`;
}

/** Thêm part chữ vào content user cuối (không đổi tiền tố prompt ⇒ vẫn dùng được cache ngầm). */
function withCorrection(contents: readonly LlmContent[], text: string): LlmContent[] {
  const out = contents.map((c) => ({ ...c, parts: [...c.parts] }));
  const last = out[out.length - 1];
  if (last && last.role === 'user') last.parts.push({ text });
  else out.push({ role: 'user', parts: [{ text }] });
  return out;
}

/** Tóm tắt tự động cho nhân viên khi hệ thống tự chuyển (bot nói đã chuyển mà không gọi escalate). */
function autoHandoffSummary(bubbles: readonly string[]): string {
  return sanitizeAgentSummary(
    `Bot báo người nhắn đã chuyển cho nhân viên nhưng không gọi escalate — hệ thống tự chuyển. Bot đã nhắn: ${bubbles.join(' / ')}`,
  );
}

/** reply tự nói đã chuyển ⇒ escalate 'other', gửi chính các bong bóng đó (giờ đã đúng sự thật) thay handoffMessage. */
function convertClaimToEscalate(bubbles: string[], confidence: number | undefined): Decided {
  return {
    decision: 'escalate',
    reasonCode: 'other',
    summary: autoHandoffSummary(bubbles),
    messages: bubbles,
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

interface ClaimTolerance {
  allowStaffNotified: boolean;
  allowHandedOff: boolean;
}

const isClaimingReply = (d: Decided, tolerance: ClaimTolerance): boolean =>
  d.decision === 'reply' && claimsHandoffInReply(d.messages ?? [], tolerance);

/**
 * Lịch sử của lượt có dòng [Hệ thống] "Hội thoại đã được chuyển cho nhân viên …" của handoff CÒN MỞ (loadTurnHistory
 * đánh dấu handoffOpen từ bảng handoffs — khách không giả được).
 */
export function historyHasOpenHandoff(history: readonly ChatHistoryItem[]): boolean {
  return history.some((h) => h.role === 'system' && h.handoffOpen === true);
}

/**
 * Bot aiHandoffMode 'continue' và hội thoại đang có handoff mở ⇒ bot đang trả lời trong lúc chờ nhân viên: prompt
 * thêm handoffContinueTurnNote, bộ chặn "tự nói đã chuyển" bỏ qua lời chuyển (allowHandedOff).
 */
export function handoffContinuesInTurn(
  chatbot: Pick<ChatbotConfig, 'aiHandoffMode'>,
  history: readonly ChatHistoryItem[],
): boolean {
  return chatbot.aiHandoffMode === 'continue' && historyHasOpenHandoff(history);
}

/**
 * Lịch sử của lượt có dòng [Hệ thống] "Đã báo nhân viên …" THẬT (loadTurnHistory: tin system của notifyStaffKeyword,
 * staffNotified) ⇒ nhân viên đã thật sự được báo ở lượt trước: bot nói "em đã báo nhân viên rồi ạ" là đúng sự thật.
 */
export function historyHasStaffNotified(history: readonly ChatHistoryItem[]): boolean {
  return history.some((h) => h.role === 'system' && h.staffNotified === true);
}

/**
 * Tên mục ghi vào ai_runs.tool_calls (đứng ĐẦU danh sách) khi tin khách mới khớp từ khóa "Báo nhân viên, bot VẪN
 * trả lời" (chatbot.notifyKeywords): args.keyword = từ khóa gốc. Lượt vẫn gọi LLM như thường.
 */
export const NOTIFY_PREFILTER = 'notify_prefilter';

/**
 * Từ khóa "Báo nhân viên, bot VẪN trả lời" ĐẦU TIÊN khớp với text một tin khách mới (cùng cách so khớp với
 * matchHandoffKeyword: không dấu, theo ranh giới từ). Không khớp / không có notifyKeywords ⇒ null.
 */
export function matchNotifyKeyword(
  newMessages: readonly ChatHistoryItem[],
  notifyKeywords: readonly string[] | undefined,
): string | null {
  const keywords = notifyKeywords ?? [];
  if (keywords.length === 0) return null;
  for (const msg of newMessages) {
    if (msg.role !== 'customer' || !msg.text) continue;
    const keyword = matchHandoffKeyword(msg.text, keywords);
    if (keyword) return keyword;
  }
  return null;
}

/** Mục toolCalls cho một phản hồi của model (giới hạn kích thước; `llm` = meta cache/thinking nếu client có). */
function toolCallEntries(response: LlmResponse): unknown[] {
  const llmMeta = response.meta ? { llm: { ...response.meta } } : {};
  if (response.functionCall) {
    return [
      {
        name: response.functionCall.name.slice(0, 100),
        args: boundToolArgsForLog(response.functionCall.args),
        ...llmMeta,
      },
    ];
  }
  if (response.text)
    return [{ name: 'text_fallback', args: boundToolArgsForLog({ text: response.text }), ...llmMeta }];
  return [];
}

/**
 * Hành vi:
 * 1. Pre-filter: text của bất kỳ tin `newMessages` role 'customer' khớp
 *    matchHandoffKeyword(text, chatbot.handoffKeywords) ⇒ { decision 'escalate', reasonCode =
 *    keywordHandoffReason(kw) (giảm giá ⇒ discount, khiếu nại ⇒ complaint, chốt đơn ⇒ closing, còn lại
 *    human_request), summary 'Khách nhắn từ khóa chuyển người "<kw>" (<nhãn lý do>)', matchedKeyword, usage 0/0,
 *    latencyMs 0, model = chatbot.model ?? defaultModel, toolCalls [{ name: 'prefilter', args: { keyword,
 *    reason_code } }] } — KHÔNG gọi LLM. Từ khóa chuyển người LUÔN thắng từ khóa báo nhân viên (bước 1b).
 * 1b. Không khớp từ khóa chuyển người mà một tin khách mới khớp chatbot.notifyKeywords (matchNotifyKeyword) ⇒ nhớ
 *    từ khóa, VẪN chạy LLM như thường; kết quả (reply / no_reply / escalate / error) mang `notifiedKeyword`,
 *    toolCalls mở đầu bằng { name: NOTIFY_PREFILTER, args: { keyword } }; prompt có ghi chú "hệ thống ĐÃ báo
 *    nhân viên" (buildChatbotPrompt notifiedKeyword) và bộ chặn "tự nói đã chuyển" (3b) TẮT ở lượt này — nhân
 *    viên thật sự được báo nên bot nói "em đã báo nhân viên" là đúng sự thật. Runtime lo việc báo thật. Các lượt
 *    sau: lịch sử có dòng [Hệ thống] "Đã báo nhân viên …" thật (historyHasStaffNotified) ⇒ bộ chặn 3b bỏ qua RIÊNG
 *    lời "đã báo (lại) nhân viên" thuần (claimsHandoffInReply allowStaffNotified); lời chuyển khác vẫn bị chặn.
 * 2. buildChatbotPrompt({ ..., now: deps.now() }) rồi llm.generate({ model: chatbot.model ?? defaultModel,
 *    tools: buildChatbotTools(chatbot) (escalateWhenUnsure=false ⇒ escalate không có out_of_scope /
 *    low_confidence), temperature: chatbot.temperature, timeoutMs (+ llmTimeoutExtraMsForImages(images)), thinking:
 *    thinkingForSpeed(chatbot.responseSpeed) (thiếu ⇒ 'fast' ⇒ 'minimal') }). LlmError.retryable ⇒ thử lại
 *    tối đa LLM_MAX_RETRIES lần (chờ deps.sleep(500 × lần thử)); lượt có ảnh hết thời gian chờ chỉ thử lại
 *    LLM_MAX_TIMEOUT_RETRIES_WITH_IMAGES lần; usage cộng dồn qua các lần.
 * 3. Kết quả (args parse bằng Zod trong tools.ts):
 *    - reply: trim, bỏ bong bóng rỗng, tối đa 3 (thừa thì cắt), mỗi bong bóng ≤ 1000 ký tự (cắt ở ranh giới từ). confidence < minConfidence ⇒ decision 'escalate',
 *      reasonCode 'low_confidence', summary 'AI không chắc câu trả lời (độ tự tin X)', KHÔNG có messages (không gửi
 *      câu trả lời không chắc; nội dung vẫn ở toolCalls)
 *      — CHỈ khi chatbot.escalateWhenUnsure; false ⇒ luôn 'reply' (vẫn ghi confidence).
 *      Không còn bong bóng nào ⇒ 'error'.
 *    - escalate ⇒ decision 'escalate', reasonCode, summary = summary_for_agent bỏ link, ≤ 500 ký tự (rỗng ⇒
 *      nhãn lý do); messages = messages_to_customer (trim, bỏ rỗng, ≤ 3 tin, mỗi tin ≤ 1000 ký tự; rỗng ⇒ bỏ) —
 *      runtime gửi các tin này THAY cho bot.handoffMessage.
 *    - reply mà bong bóng tự khẳng định đã/sẽ chuyển cho nhân viên/bộ phận (claimsHandoffInReply) ⇒ gọi lại model
 *      MỘT lần, cùng prompt + part chữ handoffCorrectionText(bong bóng) ở content cuối; toolCalls thêm
 *      { name: HANDOFF_CLAIM_GUARD, args: { action: 'retry' } } rồi mục của lần gọi lại. Lần gọi lại: escalate ⇒
 *      dùng; reply không còn tự nói đã chuyển (hoặc no_reply) ⇒ dùng; còn lại (vẫn tự nói đã chuyển, lỗi gọi AI,
 *      args sai) ⇒ decision 'escalate', reasonCode 'other', messages = bong bóng tự nói đã chuyển gần nhất,
 *      summary tự động; toolCalls thêm { name: HANDOFF_CLAIM_GUARD, args: { action: 'convert', reason_code: 'other',
 *      messages } }.
 *    - no_reply ⇒ decision 'no_reply', reason.
 *    - Không có functionCall nhưng có chữ ngắn (≤ 600 ký tự, không giống mã/markdown) ⇒ coi như reply với
 *      confidence TEXT_FALLBACK_CONFIDENCE (0.7), toolCalls ghi { name: 'text_fallback', args: { text } }.
 *    - Không có gì dùng được / tên lạ / args sai ⇒ decision 'error', reasonCode 'other', reason tiếng Việt.
 *    - Lỗi LLM sau khi hết lượt thử (hoặc lỗi không retryable) ⇒ decision 'error', reasonCode 'other',
 *      reason 'Lỗi gọi AI: <message>'.
 * 4. latencyMs = deps.now() cuối − đầu; toolCalls = [{ name, args }] model trả về; model = response.model.
 * Lượt "Không đạt" (input.staffRejectReason): bỏ bước 1/1b, tools = STAFF_REJECT_TOOLS (chỉ reply), không escalate
 * low_confidence, không chạy bước 3b ⇒ kết quả chỉ là 'reply' / 'error' (hoặc quyết định lạ nếu model vẫn gọi tool khác).
 * KHÔNG bao giờ ném lỗi (mọi lỗi ⇒ decision 'error').
 */
export async function runChatbotTurn(
  deps: ChatbotTurnDeps,
  input: ChatbotTurnInput,
): Promise<ChatbotTurnResult> {
  const { chatbot } = input;
  const staffRejectReason = input.staffRejectReason?.trim() || undefined;
  const model = chatbot.model?.trim() || deps.defaultModel;
  const usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  let startedAt = 0;
  let turnNotified: { notifiedKeyword?: string } = {};
  let turnNotifyCalls: unknown[] = [];
  const elapsed = () => {
    try {
      return Math.max(0, deps.now().getTime() - startedAt);
    } catch {
      return 0;
    }
  };

  try {
    // 1. Pre-filter từ khóa chuyển người (lượt "Không đạt" không có tin khách mới ⇒ bỏ qua).
    for (const msg of staffRejectReason ? [] : input.newMessages) {
      if (msg.role !== 'customer' || !msg.text) continue;
      const keyword = matchHandoffKeyword(msg.text, chatbot.handoffKeywords);
      if (keyword) {
        const reasonCode = keywordHandoffReason(keyword);
        return {
          decision: 'escalate',
          reasonCode,
          summary: `Khách nhắn từ khóa chuyển người "${keyword}" (${HANDOFF_REASON_LABELS[reasonCode]})`,
          matchedKeyword: keyword,
          usage,
          model,
          latencyMs: 0,
          toolCalls: [{ name: 'prefilter', args: { keyword, reason_code: reasonCode } }],
        };
      }
    }

    // 1b. Từ khóa "Báo nhân viên, bot VẪN trả lời": nhớ lại rồi vẫn gọi LLM.
    const notifiedKeyword = staffRejectReason
      ? null
      : matchNotifyKeyword(input.newMessages, chatbot.notifyKeywords);
    const notified = notifiedKeyword ? { notifiedKeyword } : {};
    const notifyCalls: unknown[] = notifiedKeyword
      ? [{ name: NOTIFY_PREFILTER, args: { keyword: notifiedKeyword } }]
      : [];
    // Phòng hờ ở catch cuối hàm (lỗi bất ngờ sau bước này vẫn giữ notifiedKeyword).
    turnNotified = notified;
    turnNotifyCalls = notifyCalls;

    // 2. Gọi LLM có retry.
    const now = deps.now();
    startedAt = now.getTime();
    const handoffContinues = !staffRejectReason && handoffContinuesInTurn(chatbot, input.history);
    const prompt = buildChatbotPrompt({
      chatbot,
      history: input.history,
      newMessages: input.newMessages,
      channelName: input.channelName,
      businessHours: input.businessHours,
      now,
      images: input.images,
      ...(notifiedKeyword ? { notifiedKeyword } : {}),
      ...(handoffContinues ? { handoffContinues } : {}),
      ...(input.lateReplySince ? { lateReplySince: input.lateReplySince } : {}),
      ...(input.reengageGuidance ? { reengageGuidance: input.reengageGuidance } : {}),
      ...(staffRejectReason ? { staffRejectReason } : {}),
    });
    const sleep = deps.sleep ?? defaultSleep;
    const request: LlmRequest = {
      model,
      systemInstruction: prompt.systemInstruction,
      contents: prompt.contents,
      tools: staffRejectReason ? STAFF_REJECT_TOOLS : buildChatbotTools(chatbot),
      temperature: chatbot.temperature,
      // Ảnh làm Gemini chậm hơn: +3 s mỗi ảnh thật sự đính kèm (tối đa +30 s).
      timeoutMs: (deps.timeoutMs ?? LLM_TIMEOUT_MS) + llmTimeoutExtraMsForImages(input.images),
      thinking: thinkingForSpeed(chatbot.responseSpeed),
    };
    const hasImages = (input.images ?? []).some((img) => !img.skipped);
    /** Gọi LLM có retry; cộng dồn usage. Lỗi sau khi hết lượt ⇒ { error }. */
    const call = async (req: LlmRequest): Promise<{ response: LlmResponse } | { error: unknown }> => {
      let lastError: unknown = null;
      let timeouts = 0;
      for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
        if (attempt > 0) await sleep(500 * attempt);
        try {
          const response = await deps.llm.generate(req);
          usage.inputTokens += response.usage.inputTokens;
          usage.outputTokens += response.usage.outputTokens;
          return { response };
        } catch (err) {
          lastError = err;
          if (!(err instanceof LlmError) || !err.retryable) break;
          if (err.timedOut && hasImages && ++timeouts > LLM_MAX_TIMEOUT_RETRIES_WITH_IMAGES) break;
        }
      }
      return { error: lastError };
    };
    const errorMessage = (err: unknown) => (err instanceof Error ? err.message : 'không rõ nguyên nhân');

    const first = await call(request);
    if (!('response' in first)) {
      return {
        ...errorDecision(`Lỗi gọi AI: ${errorMessage(first.error)}`),
        ...notified,
        usage,
        model,
        latencyMs: elapsed(),
        toolCalls: notifyCalls,
      };
    }
    const response = first.response;
    // Ghi log có giới hạn kích thước (model có thể trả args rất dài). `llm` (khi client có meta) = token lấy từ
    // cache ngầm của Gemini, token suy nghĩ, hedge — để kiểm tra độ trễ trong ai_runs.tool_calls.
    const toolCalls: unknown[] = [...notifyCalls, ...toolCallEntries(response)];

    // 3. Quyết định.
    // Lượt "Không đạt": nhân viên đã quyết định ⇒ độ tự tin thấp không bao giờ thành escalate.
    const minConfidence =
      chatbot.escalateWhenUnsure && !staffRejectReason
        ? (deps.minConfidence ?? DEFAULT_MIN_CONFIDENCE)
        : null;
    let decided = decide(response, minConfidence);
    let finalModel = response.model || model;

    // 3b. reply tự nói đã chuyển cho người thật mà không gọi escalate ⇒ gọi lại một lần; vẫn vậy ⇒ tự chuyển.
    // Lượt khớp từ khóa báo nhân viên: nhân viên ĐÃ được báo thật ⇒ không chặn. Lượt sau (lịch sử có dòng [Hệ thống]
    // "Đã báo nhân viên" thật) ⇒ chỉ bỏ qua lời "đã báo nhân viên" thuần; lời chuyển khác vẫn chặn.
    // Bot 'continue' đang trả lời trong lúc handoff còn mở: nhân viên ĐÃ nhận yêu cầu ⇒ "em đã chuyển … cho bộ phận"
    // là đúng sự thật; lời hứa "nhân viên sẽ liên hệ…" vẫn chặn.
    const tolerance: ClaimTolerance = {
      allowStaffNotified: historyHasStaffNotified(input.history),
      allowHandedOff: handoffContinues,
    };
    // Lượt "Không đạt" không chạy bộ chặn: chỉ có tool `reply`, và không bao giờ được đổi thành escalate.
    if (!notifiedKeyword && !staffRejectReason && isClaimingReply(decided, tolerance)) {
      toolCalls.push({ name: HANDOFF_CLAIM_GUARD, args: { action: 'retry' } });
      let claim = decided;
      const second = await call({
        ...request,
        contents: withCorrection(request.contents, handoffCorrectionText(decided.messages ?? [])),
      });
      let retried: Decided | null = null;
      if ('response' in second) {
        toolCalls.push(...toolCallEntries(second.response));
        finalModel = second.response.model || finalModel;
        retried = decide(second.response, minConfidence);
      } else {
        toolCalls.push({
          name: HANDOFF_CLAIM_GUARD,
          args: { action: 'retry_failed', error: truncateAtWord(errorMessage(second.error), 300) },
        });
      }
      if (retried && isClaimingReply(retried, tolerance)) claim = retried;
      const acceptable =
        retried !== null &&
        !isClaimingReply(retried, tolerance) &&
        (retried.decision === 'escalate' || retried.decision === 'reply' || retried.decision === 'no_reply');
      if (acceptable) {
        decided = retried!;
      } else {
        decided = convertClaimToEscalate(claim.messages ?? [], claim.confidence);
        toolCalls.push({
          name: HANDOFF_CLAIM_GUARD,
          args: boundToolArgsForLog({ action: 'convert', reason_code: 'other', messages: decided.messages }),
        });
      }
    }
    return {
      ...decided,
      ...notified,
      usage,
      model: finalModel,
      latencyMs: elapsed(),
      toolCalls,
    };
  } catch (err) {
    // Phòng hờ (prompt/now lỗi bất ngờ): không bao giờ ném ra ngoài.
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...errorDecision(`Lỗi chatbot: ${message}`),
      ...turnNotified,
      usage,
      model,
      latencyMs: elapsed(),
      toolCalls: turnNotifyCalls,
    };
  }
}
