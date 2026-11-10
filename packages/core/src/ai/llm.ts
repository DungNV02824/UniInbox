// Giao diện LLM trung lập nhà cung cấp. Cài đặt thật: Gemini (@google/genai). Test: client giả, không gọi mạng.
import {
  ApiError,
  FunctionCallingConfigMode,
  GoogleGenAI,
  ThinkingLevel,
  type Content,
  type GenerateContentResponse,
  type HttpOptions,
  type Part,
  type ThinkingConfig,
} from '@google/genai';
import type { LlmUsage } from '@dezon/shared';
import type { LlmThinking } from './speed';
import type { ChatbotToolName } from './tools';

export type LlmPart =
  { text: string } | { inlineImage: { mime: string; /** base64, không có tiền tố data: */ data: string } };

export interface LlmContent {
  /** 'user' = khách + nhân viên + ngữ cảnh; 'model' = tin bot trước đó. */
  role: 'user' | 'model';
  parts: LlmPart[];
}

/** Khai báo function calling (JSON Schema kiểu OpenAPI mà Gemini nhận). */
export interface LlmFunctionDeclaration {
  name: ChatbotToolName;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  model: string;
  systemInstruction: string;
  contents: LlmContent[];
  /** Model BẮT BUỘC gọi đúng một trong các tool này (Gemini: functionCallingConfig mode ANY). */
  tools: LlmFunctionDeclaration[];
  temperature: number;
  /** Hủy request sau thời gian này (AbortSignal) ⇒ ném LlmError retryable. */
  timeoutMs: number;
  /**
   * Mức suy nghĩ (thinkingForSpeed(chatbot.responseSpeed)). Thiếu ⇒ KHÔNG gửi thinkingConfig (model tự quyết,
   * gemini-3.5-flash ≈ 2,5–5 s). Gemini 3.x: `thinkingConfig: { thinkingLevel: ThinkingLevel.<MỨC> }`;
   * Gemini 2.x (tên model khớp /^gemini-2\./): `thinkingBudget` thay thế — xem geminiThinkingConfig.
   */
  thinking?: LlmThinking;
}

export interface LlmFunctionCall {
  name: string;
  args: Record<string, unknown>;
}

/** Số liệu phụ của một lần gọi (ghi vào ai_runs.tool_calls[0].llm để theo dõi cache / hedge). */
export interface LlmCallMeta {
  /** usageMetadata.cachedContentTokenCount: số token đầu prompt Gemini lấy từ cache ngầm (implicit cache). */
  cachedInputTokens: number;
  /** usageMetadata.thoughtsTokenCount (đã cộng vào usage.outputTokens). */
  thoughtsTokens: number;
  /**
   * Có gửi request trùng (hedge) không và request nào về trước: 'first' = request gốc, 'second' = request trùng.
   * Thiếu = không hedge (request gốc xong trước mốc hedgeAfterMs hoặc hedge tắt).
   */
  hedged?: 'first' | 'second';
}

export interface LlmResponse {
  /** Function call ĐẦU TIÊN model trả về; null nếu model chỉ trả chữ. */
  functionCall: LlmFunctionCall | null;
  /** Phần chữ (nếu có) — chỉ để debug, không gửi cho khách. */
  text: string | null;
  usage: LlmUsage;
  /** Model thực tế trả lời (modelVersion), mặc định = request.model. */
  model: string;
  /** Client thật (Gemini) luôn có; client giả trong test có thể bỏ. */
  meta?: LlmCallMeta;
}

export interface LlmClient {
  generate(req: LlmRequest): Promise<LlmResponse>;
}

/**
 * Lỗi gọi LLM. `retryable` = lỗi tạm thời (timeout, mạng, HTTP 408/429/5xx) — orchestrator thử lại tối đa
 * 2 lần; lỗi khác (400, 401/403 sai key, 404 sai model, nội dung bị chặn) không thử lại. `message` không chứa API key.
 */
export class LlmError extends Error {
  override readonly name = 'LlmError';
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    /** true = hết thời gian chờ (orchestrator thử lại ít hơn với lượt có ảnh). */
    readonly timedOut: boolean = false,
  ) {
    super(message);
  }
}

export interface GeminiClientOptions {
  /** Ghi đè endpoint (test/proxy). */
  baseUrl?: string;
  /** fetch thay thế (test không gọi mạng). */
  fetch?: typeof fetch;
  /**
   * Hedge: request đầu chưa trả lời sau ngần này ms ⇒ gửi thêm ĐÚNG MỘT request trùng, lấy cái nào về trước
   * (cái còn lại bị hủy). Cắt "đuôi" độ trễ của Gemini (thỉnh thoảng ~3 s thay vì ~1,7 s) nhưng TỐN THÊM token
   * cho request trùng. 0 = tắt. Thiếu ⇒ đọc env AI_HEDGE_AFTER_MS (mặc định tắt) — xem hedgeAfterMsFromEnv.
   */
  hedgeAfterMs?: number;
}

/** Tên biến môi trường bật hedge (ms, ví dụ 2500). Trống / 0 / sai định dạng ⇒ tắt. */
export const AI_HEDGE_ENV = 'AI_HEDGE_AFTER_MS';
/** Mốc hedge nhỏ nhất cho phép (tránh gửi trùng gần như mọi request ⇒ gấp đôi chi phí). */
export const MIN_HEDGE_AFTER_MS = 500;

/** Đọc AI_HEDGE_AFTER_MS: số nguyên ≥ MIN_HEDGE_AFTER_MS ⇒ bật; còn lại (trống, 0, chữ, quá nhỏ) ⇒ 0 = tắt. */
export function hedgeAfterMsFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env[AI_HEDGE_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return 0;
  const ms = Number(raw);
  return ms >= MIN_HEDGE_AFTER_MS ? ms : 0;
}

/**
 * Chạy `start` (mỗi lần một AbortSignal riêng). `afterMs` > 0 và lần 1 chưa xong sau `afterMs` ⇒ chạy lần 2
 * song song; kết quả = lần THÀNH CÔNG về trước, lần kia bị abort. Lần 1 lỗi trước mốc ⇒ ném lỗi ngay (không
 * hedge — orchestrator tự retry). Đã chạy 2 lần ⇒ chỉ ném khi CẢ HAI lỗi (ném lỗi của lần 1).
 * `hedged` thiếu khi chỉ chạy 1 lần; 'first' / 'second' = lần thắng khi đã chạy 2 lần.
 */
export function runHedged<T>(
  start: (signal: AbortSignal) => Promise<T>,
  afterMs: number,
): Promise<{ value: T; hedged?: 'first' | 'second' }> {
  return new Promise((resolve, reject) => {
    const controllers: AbortController[] = [];
    const failed: boolean[] = [];
    let firstError: unknown;
    let hasError = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (fn: () => void) => {
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    const launch = (index: 0 | 1) => {
      const controller = new AbortController();
      controllers.push(controller);
      let promise: Promise<T>;
      try {
        promise = start(controller.signal);
      } catch (err) {
        promise = Promise.reject(err);
      }
      promise.then(
        (value) => {
          if (settled) return;
          finish(() => {
            controllers.forEach((c, i) => {
              if (i !== index) c.abort();
            });
            if (controllers.length > 1) resolve({ value, hedged: index === 0 ? 'first' : 'second' });
            else resolve({ value });
          });
        },
        (err: unknown) => {
          if (settled) return;
          failed[index] = true;
          if (!hasError || index === 0) {
            firstError = err;
            hasError = true;
          }
          const launched = controllers.length;
          // Chưa hedge mà lần 1 đã lỗi ⇒ ném ngay; đã hedge ⇒ chờ lần còn lại.
          if (launched === 1 || failed.filter(Boolean).length === launched) finish(() => reject(firstError));
        },
      );
    };

    launch(0);
    if (afterMs > 0 && !settled) {
      timer = setTimeout(() => {
        timer = undefined;
        if (!settled) launch(1);
      }, afterMs);
    }
  });
}

const MAX_ERROR_MESSAGE = 300;

function createSdk(apiKey: string, options?: GeminiClientOptions): GoogleGenAI {
  const http: HttpOptions = {};
  if (options?.baseUrl) http.baseUrl = options.baseUrl;
  if (options?.fetch) http.fetch = options.fetch;
  return new GoogleGenAI(Object.keys(http).length > 0 ? { apiKey, httpOptions: http } : { apiKey });
}

function toGeminiPart(part: LlmPart): Part {
  if ('text' in part) return { text: part.text };
  return { inlineData: { mimeType: part.inlineImage.mime, data: part.inlineImage.data } };
}

function toGeminiContents(contents: LlmContent[]): Content[] {
  return contents.map((c) => ({ role: c.role, parts: c.parts.map(toGeminiPart) }));
}

/** Rút message gọn từ ApiError (message của SDK là JSON body lỗi) và che API key nếu lỡ có. */
function cleanMessage(raw: string, apiKey: string): string {
  let msg = raw;
  try {
    const body = JSON.parse(raw) as { error?: { message?: unknown } };
    if (typeof body.error?.message === 'string') msg = body.error.message;
  } catch {
    // không phải JSON — giữ nguyên
  }
  if (apiKey) msg = msg.split(apiKey).join('***');
  return msg.length > MAX_ERROR_MESSAGE ? `${msg.slice(0, MAX_ERROR_MESSAGE)}…` : msg;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function timeoutError(timeoutMs: number): LlmError {
  return new LlmError(`Hết thời gian chờ AI (${Math.round(timeoutMs / 1000)}s)`, true, undefined, true);
}

/** Ánh xạ mọi lỗi từ SDK/fetch sang LlmError. */
export function toLlmError(err: unknown, apiKey: string, timedOut: boolean, timeoutMs: number): LlmError {
  if (err instanceof LlmError) return err;
  if (timedOut) return timeoutError(timeoutMs);
  if (err instanceof ApiError) {
    return new LlmError(
      `Gemini HTTP ${err.status}: ${cleanMessage(err.message, apiKey)}`,
      isRetryableStatus(err.status),
      err.status,
    );
  }
  if (err instanceof Error) {
    // fetch của Node ném TypeError('fetch failed') khi lỗi mạng / DNS / kết nối bị đóng.
    const network = err instanceof TypeError || err.name === 'AbortError' || err.name === 'TimeoutError';
    return new LlmError(`Lỗi gọi Gemini: ${cleanMessage(err.message, apiKey)}`, network);
  }
  return new LlmError('Lỗi gọi Gemini không xác định', false);
}

/**
 * Đọc function call đầu tiên + phần chữ (bỏ phần "thought") của ứng viên đầu. Không dùng getter `.text`
 * của SDK vì getter log cảnh báo khi có part không phải chữ.
 */
export function parseGeminiResponse(res: GenerateContentResponse, requestModel: string): LlmResponse {
  const candidate = res.candidates?.[0];
  if (!candidate && res.promptFeedback?.blockReason) {
    throw new LlmError(`Gemini chặn nội dung (${res.promptFeedback.blockReason})`, false);
  }
  let functionCall: LlmFunctionCall | null = null;
  const texts: string[] = [];
  for (const part of candidate?.content?.parts ?? []) {
    if (part.functionCall?.name && !functionCall) {
      functionCall = { name: part.functionCall.name, args: part.functionCall.args ?? {} };
    }
    if (typeof part.text === 'string' && !part.thought) texts.push(part.text);
  }
  const text = texts.join('').trim();
  const meta = res.usageMetadata;
  return {
    functionCall,
    text: text.length > 0 ? text : null,
    usage: {
      inputTokens: meta?.promptTokenCount ?? 0,
      // Token "suy nghĩ" của Gemini 2.5+/3 tính phí như output ⇒ cộng vào outputTokens.
      outputTokens: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
    },
    model: res.modelVersion ?? requestModel,
    meta: {
      cachedInputTokens: meta?.cachedContentTokenCount ?? 0,
      thoughtsTokens: meta?.thoughtsTokenCount ?? 0,
    },
  };
}

/**
 * Chạy `fn` với AbortSignal hết hạn sau `timeoutMs` (hoặc khi `outer` bị abort — request thua khi hedge);
 * mọi lỗi ⇒ LlmError.
 */
async function withTimeout<T>(
  apiKey: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
  outer?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onOuterAbort = () => controller.abort();
  if (outer?.aborted) controller.abort();
  else outer?.addEventListener('abort', onOuterAbort, { once: true });
  try {
    const result = await fn(controller.signal);
    if (timedOut) throw timeoutError(timeoutMs);
    return result;
  } catch (err) {
    throw toLlmError(err, apiKey, timedOut, timeoutMs);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuterAbort);
  }
}

/** thinkingBudget (token) cho Gemini 2.5 flash / flash-lite. 0 = tắt suy nghĩ. */
const GEMINI_2_BUDGET: Record<LlmThinking, number> = { minimal: 0, low: 1024, medium: 4096, high: 8192 };
/** Gemini 2.5 Pro không tắt được suy nghĩ: ngân sách tối thiểu 128. */
const GEMINI_2_PRO_MIN_BUDGET = 128;
const GEMINI_3_LEVEL: Record<LlmThinking, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

/**
 * LlmRequest.thinking ⇒ `config.thinkingConfig` của @google/genai (undefined = không gửi gì, model tự quyết).
 * - thinking undefined, hoặc model không phải 'gemini-*' (gemma…), hoặc gemini-2.0 (không có suy nghĩ) ⇒ undefined.
 * - gemini-2.x (2.5): `thinkingBudget` (2.5 không hiểu thinkingLevel) — flash/flash-lite minimal 0, low 1024,
 *   medium 4096, high 8192; pro không tắt được ⇒ minimal = 128.
 * - còn lại (gemini-3.x, gemini-*-latest…): `thinkingLevel` MINIMAL/LOW/MEDIUM/HIGH (Gemini 3.5+ BÁO LỖI nếu
 *   gửi thinkingBudget); model '-pro' không nhận MINIMAL ⇒ LOW.
 * Không đặt includeThoughts (mặc định false).
 */
export function geminiThinkingConfig(
  model: string,
  thinking: LlmThinking | undefined,
): ThinkingConfig | undefined {
  if (!thinking) return undefined;
  const name = model
    .trim()
    .toLowerCase()
    .replace(/^models\//, '');
  if (!name.startsWith('gemini-') || name.startsWith('gemini-2.0') || name.startsWith('gemini-1.')) {
    return undefined;
  }
  const pro = name.includes('-pro');
  if (name.startsWith('gemini-2.')) {
    const budget = GEMINI_2_BUDGET[thinking];
    return { thinkingBudget: pro ? Math.max(budget, GEMINI_2_PRO_MIN_BUDGET) : budget };
  }
  return { thinkingLevel: GEMINI_3_LEVEL[pro && thinking === 'minimal' ? 'low' : thinking] };
}

/** HTTP 400 vì model không nhận cấu hình suy nghĩ ⇒ thử lại không gửi thinkingConfig. */
function isThinkingConfigRejected(err: unknown): boolean {
  return err instanceof LlmError && err.status === 400 && /thinking/i.test(err.message);
}

/**
 * Client Gemini bằng @google/genai (`new GoogleGenAI({ apiKey })`, `models.generateContent`):
 * - systemInstruction, contents (text + inlineData{mimeType,data}), temperature;
 * - tools: [{ functionDeclarations }] (tham số gửi dạng `parametersJsonSchema` vì CHATBOT_TOOLS là JSON Schema
 *   chữ thường), toolConfig.functionCallingConfig = { mode: ANY, allowedFunctionNames } để bắt buộc gọi tool;
 * - timeout bằng AbortController + abortSignal (SDK mặc định KHÔNG tự retry — orchestrator tự retry);
 * - thinkingConfig = geminiThinkingConfig(model, req.thinking) khi có (400 "thinking" ⇒ thử lại 1 lần không gửi);
 * - usage từ usageMetadata.promptTokenCount / candidatesTokenCount + thoughtsTokenCount (thiếu ⇒ 0);
 *   meta.cachedInputTokens = cachedContentTokenCount (cache ngầm của Gemini cho phần đầu prompt giống lần trước);
 * - hedge (options.hedgeAfterMs, mặc định env AI_HEDGE_AFTER_MS = tắt): chậm quá mốc ⇒ gửi 1 request trùng,
 *   lấy cái về trước (runHedged); meta.hedged ghi lại;
 * - lỗi ⇒ LlmError (retryable cho timeout/mạng/408/429/5xx). Không log nội dung prompt.
 */
export function createGeminiClient(apiKey: string, options?: GeminiClientOptions): LlmClient {
  const ai = createSdk(apiKey, options);
  const hedgeAfterMs = Math.max(0, options?.hedgeAfterMs ?? hedgeAfterMsFromEnv());
  /** Model đã từng trả 400 vì thinkingConfig ⇒ các lần sau không gửi nữa (đỡ tốn 1 lượt gọi hỏng). */
  const rejectsThinking = new Set<string>();

  const call = (req: LlmRequest, thinkingConfig: ThinkingConfig | undefined, outer: AbortSignal) =>
    withTimeout(
      apiKey,
      req.timeoutMs,
      (signal) =>
        ai.models.generateContent({
          model: req.model,
          contents: toGeminiContents(req.contents),
          config: {
            abortSignal: signal,
            systemInstruction: req.systemInstruction,
            temperature: req.temperature,
            ...(thinkingConfig ? { thinkingConfig } : {}),
            tools: [
              {
                functionDeclarations: req.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parametersJsonSchema: t.parameters,
                })),
              },
            ],
            toolConfig: {
              functionCallingConfig: {
                mode: FunctionCallingConfigMode.ANY,
                allowedFunctionNames: req.tools.map((t) => t.name),
              },
            },
          },
        }),
      outer,
    );

  /** Một lượt gọi (kèm lưới an toàn thinkingConfig) — đơn vị mà hedge nhân đôi. */
  const attempt = async (req: LlmRequest, signal: AbortSignal): Promise<GenerateContentResponse> => {
    const thinkingConfig = rejectsThinking.has(req.model)
      ? undefined
      : geminiThinkingConfig(req.model, req.thinking);
    try {
      return await call(req, thinkingConfig, signal);
    } catch (err) {
      // Lưới an toàn: model không nhận mức suy nghĩ ⇒ thử lại NGAY 1 lần không thinkingConfig
      // (không tính vào LLM_MAX_RETRIES của orchestrator).
      if (!thinkingConfig || !isThinkingConfigRejected(err)) throw err;
      rejectsThinking.add(req.model);
      return call(req, undefined, signal);
    }
  };

  return {
    async generate(req: LlmRequest): Promise<LlmResponse> {
      const { value, hedged } = await runHedged((signal) => attempt(req, signal), hedgeAfterMs);
      const parsed = parseGeminiResponse(value, req.model);
      if (hedged && parsed.meta) parsed.meta.hedged = hedged;
      return parsed;
    },
  };
}

/**
 * Danh sách model hỗ trợ generateContent (ô chọn model ở trang admin), tên bỏ tiền tố 'models/',
 * giữ thứ tự API trả, không trùng. Lỗi ⇒ LlmError. Timeout mặc định 15s cho cả việc lật trang.
 */
export async function listGeminiModels(
  apiKey: string,
  options?: GeminiClientOptions & { timeoutMs?: number },
): Promise<string[]> {
  const ai = createSdk(apiKey, options);
  return withTimeout(apiKey, options?.timeoutMs ?? 15_000, async (signal) => {
    const pager = await ai.models.list({ config: { pageSize: 100, abortSignal: signal } });
    const names: string[] = [];
    for await (const model of pager) {
      if (!model.name || !model.supportedActions?.includes('generateContent')) continue;
      const name = model.name.replace(/^models\//, '');
      if (!names.includes(name)) names.push(name);
    }
    return names;
  });
}
