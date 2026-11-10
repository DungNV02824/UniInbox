// Kiểm tra ánh xạ request/response/lỗi của createGeminiClient bằng fetch giả — KHÔNG gọi mạng.
import { describe, expect, it } from 'vitest';
import { RESPONSE_SPEEDS } from '@dezon/shared';
import {
  AI_HEDGE_ENV,
  createGeminiClient,
  geminiThinkingConfig,
  hedgeAfterMsFromEnv,
  listGeminiModels,
  LlmError,
  runHedged,
  type LlmRequest,
} from './llm';
import { thinkingForSpeed } from './speed';
import { CHATBOT_TOOLS } from './tools';

const API_KEY = 'AIza-test-key-khong-that';

const req: LlmRequest = {
  model: 'gemini-2.5-flash',
  systemInstruction: 'Khung an toàn',
  contents: [
    { role: 'user', parts: [{ text: '[Khách] <customer_message>Chào</customer_message>' }] },
    { role: 'model', parts: [{ text: '[Bot] Dạ chào anh' }] },
    {
      role: 'user',
      parts: [{ text: '[Khách] ảnh này' }, { inlineImage: { mime: 'image/png', data: 'iVBORw0KGgo=' } }],
    },
  ],
  tools: CHATBOT_TOOLS,
  temperature: 0.4,
  timeoutMs: 5_000,
};

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function fakeFetch(handler: Handler) {
  const calls: { url: string; body: Record<string, unknown> | null; headers: Headers }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ url, body, headers: new Headers(init?.headers) });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { f, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('createGeminiClient', () => {
  it('gửi systemInstruction, contents (inlineData), tools + toolConfig ANY; đọc functionCall + usage', async () => {
    const { f, calls } = fakeFetch(() =>
      json(200, {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { text: 'suy nghĩ', thought: true },
                { functionCall: { name: 'reply', args: { messages: ['Dạ'], confidence: 0.9 } } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 15, thoughtsTokenCount: 30 },
        modelVersion: 'gemini-2.5-flash-002',
      }),
    );
    const client = createGeminiClient(API_KEY, { fetch: f });
    const res = await client.generate(req);
    expect(res).toEqual({
      functionCall: { name: 'reply', args: { messages: ['Dạ'], confidence: 0.9 } },
      text: null,
      usage: { inputTokens: 120, outputTokens: 45 },
      model: 'gemini-2.5-flash-002',
      meta: { cachedInputTokens: 0, thoughtsTokens: 30 },
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toContain('models/gemini-2.5-flash:generateContent');
    expect(call.url).not.toContain(API_KEY);
    const body = call.body!;
    expect(body.systemInstruction).toMatchObject({ parts: [{ text: 'Khung an toàn' }] });
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: '[Khách] <customer_message>Chào</customer_message>' }] },
      { role: 'model', parts: [{ text: '[Bot] Dạ chào anh' }] },
      {
        role: 'user',
        parts: [{ text: '[Khách] ảnh này' }, { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }],
      },
    ]);
    expect(body.generationConfig).toMatchObject({ temperature: 0.4 });
    const tools = body.tools as { functionDeclarations: { name: string; parametersJsonSchema: unknown }[] }[];
    expect(tools[0]?.functionDeclarations.map((d) => d.name)).toEqual(['reply', 'escalate', 'no_reply']);
    expect(tools[0]?.functionDeclarations[0]?.parametersJsonSchema).toEqual(CHATBOT_TOOLS[0]?.parameters);
    expect(body.toolConfig).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['reply', 'escalate', 'no_reply'] },
    });
  });

  it('chỉ có chữ ⇒ functionCall null, text đã trim; thiếu usage ⇒ 0; thiếu modelVersion ⇒ model request', async () => {
    const { f } = fakeFetch(() =>
      json(200, { candidates: [{ content: { role: 'model', parts: [{ text: ' Dạ em chào ' }] } }] }),
    );
    const res = await createGeminiClient(API_KEY, { fetch: f }).generate(req);
    expect(res).toEqual({
      functionCall: null,
      text: 'Dạ em chào',
      usage: { inputTokens: 0, outputTokens: 0 },
      model: 'gemini-2.5-flash',
      meta: { cachedInputTokens: 0, thoughtsTokens: 0 },
    });
  });

  it('prompt bị chặn ⇒ LlmError không retry', async () => {
    const { f } = fakeFetch(() => json(200, { promptFeedback: { blockReason: 'SAFETY' } }));
    const err = await createGeminiClient(API_KEY, { fetch: f })
      .generate(req)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).retryable).toBe(false);
  });

  it.each([
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [403, false],
    [404, false],
  ])('HTTP %i ⇒ retryable=%s, message gọn, không chứa key', async (status, retryable) => {
    const { f } = fakeFetch(() =>
      json(status, { error: { code: status, message: `Lỗi giả ${API_KEY}`, status: 'X' } }),
    );
    const err = (await createGeminiClient(API_KEY, { fetch: f })
      .generate(req)
      .catch((e: unknown) => e)) as LlmError;
    expect(err).toBeInstanceOf(LlmError);
    expect(err.retryable).toBe(retryable);
    expect(err.status).toBe(status);
    expect(err.message).toBe(`Gemini HTTP ${status}: Lỗi giả ***`);
  });

  it('lỗi mạng ⇒ retryable', async () => {
    const { f } = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const err = (await createGeminiClient(API_KEY, { fetch: f })
      .generate(req)
      .catch((e: unknown) => e)) as LlmError;
    expect(err).toBeInstanceOf(LlmError);
    expect(err.retryable).toBe(true);
  });

  it('timeout ⇒ LlmError retryable "Hết thời gian chờ"', async () => {
    const { f } = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const err = (await createGeminiClient(API_KEY, { fetch: f })
      .generate({ ...req, timeoutMs: 30 })
      .catch((e: unknown) => e)) as LlmError;
    expect(err).toBeInstanceOf(LlmError);
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('Hết thời gian chờ');
  });
});

const replyOk = () =>
  json(200, {
    candidates: [
      {
        content: { role: 'model', parts: [{ functionCall: { name: 'reply', args: { messages: ['Dạ'] } } }] },
      },
    ],
  });

describe('geminiThinkingConfig', () => {
  it('thiếu thinking ⇒ undefined (không gửi gì)', () => {
    expect(geminiThinkingConfig('gemini-3.5-flash', undefined)).toBeUndefined();
  });

  it.each([
    ['minimal', 'MINIMAL'],
    ['low', 'LOW'],
    ['medium', 'MEDIUM'],
    ['high', 'HIGH'],
  ] as const)('gemini-3.x %s ⇒ thinkingLevel %s, không có thinkingBudget', (thinking, level) => {
    expect(geminiThinkingConfig('gemini-3.5-flash', thinking)).toEqual({ thinkingLevel: level });
    expect(geminiThinkingConfig('models/gemini-flash-latest', thinking)).toEqual({ thinkingLevel: level });
  });

  it('gemini-3 pro không nhận MINIMAL ⇒ LOW', () => {
    expect(geminiThinkingConfig('gemini-3-pro-preview', 'minimal')).toEqual({ thinkingLevel: 'LOW' });
    expect(geminiThinkingConfig('gemini-3-pro-preview', 'high')).toEqual({ thinkingLevel: 'HIGH' });
  });

  it.each([
    ['minimal', 0, 128],
    ['low', 1024, 1024],
    ['medium', 4096, 4096],
    ['high', 8192, 8192],
  ] as const)('gemini-2.5 %s ⇒ thinkingBudget flash %i / pro %i', (thinking, flash, pro) => {
    expect(geminiThinkingConfig('gemini-2.5-flash', thinking)).toEqual({ thinkingBudget: flash });
    expect(geminiThinkingConfig('gemini-2.5-flash-lite', thinking)).toEqual({ thinkingBudget: flash });
    expect(geminiThinkingConfig('gemini-2.5-pro', thinking)).toEqual({ thinkingBudget: pro });
  });

  it('model không có suy nghĩ (gemini-2.0, gemma) ⇒ undefined', () => {
    expect(geminiThinkingConfig('gemini-2.0-flash', 'minimal')).toBeUndefined();
    expect(geminiThinkingConfig('gemma-3-27b-it', 'high')).toBeUndefined();
  });
});

describe('createGeminiClient — thinkingConfig qua SDK thật', () => {
  it.each(
    RESPONSE_SPEEDS.map((s) => [s, { fast: 'MINIMAL', balanced: 'LOW', thorough: 'HIGH' }[s]] as const),
  )('responseSpeed %s ⇒ body generationConfig.thinkingConfig.thinkingLevel = %s', async (speed, level) => {
    const { f, calls } = fakeFetch(replyOk);
    await createGeminiClient(API_KEY, { fetch: f }).generate({
      ...req,
      model: 'gemini-3.5-flash',
      thinking: thinkingForSpeed(speed),
    });
    expect(calls).toHaveLength(1);
    const gen = calls[0]!.body!.generationConfig as Record<string, unknown>;
    expect(gen.thinkingConfig).toEqual({ thinkingLevel: level });
    expect(gen).toMatchObject({ temperature: 0.4 });
  });

  it('gemini-2.5-flash + fast ⇒ thinkingBudget 0', async () => {
    const { f, calls } = fakeFetch(replyOk);
    await createGeminiClient(API_KEY, { fetch: f }).generate({ ...req, thinking: thinkingForSpeed('fast') });
    expect((calls[0]!.body!.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({
      thinkingBudget: 0,
    });
  });

  it('thiếu thinking ⇒ không gửi thinkingConfig', async () => {
    const { f, calls } = fakeFetch(replyOk);
    await createGeminiClient(API_KEY, { fetch: f }).generate(req);
    expect(calls[0]!.body!.generationConfig).not.toHaveProperty('thinkingConfig');
  });

  it('HTTP 400 vì "thinking" ⇒ thử lại ngay 1 lần không thinkingConfig; lần sau không gửi nữa', async () => {
    const { f, calls } = fakeFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { generationConfig?: Record<string, unknown> };
      if (body.generationConfig?.thinkingConfig) {
        return json(400, {
          error: {
            code: 400,
            message: 'Thinking level is not supported for this model.',
            status: 'INVALID_ARGUMENT',
          },
        });
      }
      return replyOk();
    });
    const client = createGeminiClient(API_KEY, { fetch: f });
    const res = await client.generate({ ...req, model: 'gemini-x-pro', thinking: 'minimal' });
    expect(res.functionCall?.name).toBe('reply');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body!.generationConfig).toHaveProperty('thinkingConfig');
    expect(calls[1]!.body!.generationConfig).not.toHaveProperty('thinkingConfig');

    await client.generate({ ...req, model: 'gemini-x-pro', thinking: 'minimal' });
    expect(calls).toHaveLength(3);
    expect(calls[2]!.body!.generationConfig).not.toHaveProperty('thinkingConfig');
  });

  it('HTTP 400 khác (không nhắc thinking) ⇒ không thử lại', async () => {
    const { f, calls } = fakeFetch(() =>
      json(400, { error: { code: 400, message: 'Invalid argument', status: 'INVALID_ARGUMENT' } }),
    );
    const err = (await createGeminiClient(API_KEY, { fetch: f })
      .generate({ ...req, model: 'gemini-3.5-flash', thinking: 'minimal' })
      .catch((e: unknown) => e)) as LlmError;
    expect(err).toBeInstanceOf(LlmError);
    expect(err.status).toBe(400);
    expect(calls).toHaveLength(1);
  });
});

describe('createGeminiClient — cache ngầm + hedge', () => {
  it('usageMetadata.cachedContentTokenCount ⇒ meta.cachedInputTokens', async () => {
    const { f } = fakeFetch(() =>
      json(200, {
        candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'reply', args: {} } }] } }],
        usageMetadata: { promptTokenCount: 2400, cachedContentTokenCount: 2048, candidatesTokenCount: 60 },
      }),
    );
    const res = await createGeminiClient(API_KEY, { fetch: f, hedgeAfterMs: 0 }).generate(req);
    expect(res.meta).toEqual({ cachedInputTokens: 2048, thoughtsTokens: 0 });
    expect(res.usage).toEqual({ inputTokens: 2400, outputTokens: 60 });
  });

  /** fetch giả: lần gọi thứ i trả sau delays[i] ms; abort ⇒ reject như fetch thật. */
  function delayedFetch(delays: number[]) {
    const aborted: number[] = [];
    let n = 0;
    const { f, calls } = fakeFetch((_url, init) => {
      const i = n++;
      const tag = i === 0 ? 'gốc' : 'trùng';
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            resolve(
              json(200, {
                candidates: [
                  {
                    content: {
                      role: 'model',
                      parts: [{ functionCall: { name: 'reply', args: { messages: [tag] } } }],
                    },
                  },
                ],
              }),
            ),
          delays[i] ?? 0,
        );
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          aborted.push(i);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    });
    return { f, calls, aborted };
  }

  it('request gốc chậm hơn mốc hedge ⇒ gửi 1 request trùng (cùng body), lấy cái về trước, hủy cái kia', async () => {
    const { f, calls, aborted } = delayedFetch([400, 10]);
    const res = await createGeminiClient(API_KEY, { fetch: f, hedgeAfterMs: 30 }).generate({
      ...req,
      model: 'gemini-3.5-flash',
      thinking: 'minimal',
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toEqual(calls[0]!.body);
    expect(res.functionCall?.args).toEqual({ messages: ['trùng'] });
    expect(res.meta?.hedged).toBe('second');
    expect(aborted).toEqual([0]);
  });

  it('request gốc xong trước mốc ⇒ không gửi trùng, meta không có hedged', async () => {
    const { f, calls } = delayedFetch([5]);
    const res = await createGeminiClient(API_KEY, { fetch: f, hedgeAfterMs: 200 }).generate(req);
    expect(calls).toHaveLength(1);
    expect(res.meta).not.toHaveProperty('hedged');
  });

  it('hedge tắt (0) ⇒ chỉ một request dù chậm', async () => {
    const { f, calls } = delayedFetch([80]);
    await createGeminiClient(API_KEY, { fetch: f, hedgeAfterMs: 0 }).generate(req);
    expect(calls).toHaveLength(1);
  });
});

describe('runHedged', () => {
  const later = <T>(ms: number, value: T) =>
    new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
  const failAfter = (ms: number, message: string) =>
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(message)), ms));

  it('lần 1 lỗi trước mốc ⇒ ném ngay, không chạy lần 2', async () => {
    let n = 0;
    const err = await runHedged(() => {
      n++;
      return failAfter(5, 'lỗi 1');
    }, 50).catch((e: unknown) => e);
    expect((err as Error).message).toBe('lỗi 1');
    await later(70, null);
    expect(n).toBe(1);
  });

  it('đã hedge: một lần lỗi ⇒ chờ lần kia; cả hai lỗi ⇒ ném lỗi lần 1', async () => {
    const ok = await runHedged((_s) => later(20, 'x'), 5);
    expect(ok.value).toBe('x');
    let n = 0;
    const r = await runHedged(() => (n++ === 0 ? failAfter(30, 'chậm rồi lỗi') : later(60, 'b')), 10);
    expect(r).toEqual({ value: 'b', hedged: 'second' });
    let m = 0;
    const err = await runHedged(() => (m++ === 0 ? failAfter(30, 'lỗi 1') : failAfter(5, 'lỗi 2')), 10).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toBe('lỗi 1');
  });

  it('lần 1 về trước sau khi đã hedge ⇒ hedged "first", lần 2 bị abort', async () => {
    const signals: AbortSignal[] = [];
    let n = 0;
    const r = await runHedged((signal) => {
      signals.push(signal);
      return n++ === 0 ? later(30, 'a') : later(200, 'b');
    }, 10);
    expect(r).toEqual({ value: 'a', hedged: 'first' });
    expect(signals.map((s) => s.aborted)).toEqual([false, true]);
  });

  it(`${AI_HEDGE_ENV}: số nguyên ≥ 500 ⇒ bật; trống / 0 / chữ / quá nhỏ ⇒ 0`, () => {
    expect(hedgeAfterMsFromEnv({})).toBe(0);
    expect(hedgeAfterMsFromEnv({ [AI_HEDGE_ENV]: '' })).toBe(0);
    expect(hedgeAfterMsFromEnv({ [AI_HEDGE_ENV]: '0' })).toBe(0);
    expect(hedgeAfterMsFromEnv({ [AI_HEDGE_ENV]: 'abc' })).toBe(0);
    expect(hedgeAfterMsFromEnv({ [AI_HEDGE_ENV]: '100' })).toBe(0);
    expect(hedgeAfterMsFromEnv({ [AI_HEDGE_ENV]: ' 2500 ' })).toBe(2500);
  });
});

describe('listGeminiModels', () => {
  it('lọc model hỗ trợ generateContent, bỏ tiền tố models/, lật trang', async () => {
    const { f, calls } = fakeFetch((url) => {
      if (!url.includes('pageToken')) {
        return json(200, {
          models: [
            {
              name: 'models/gemini-2.5-flash',
              supportedGenerationMethods: ['generateContent', 'countTokens'],
            },
            { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
          ],
          nextPageToken: 'p2',
        });
      }
      return json(200, {
        models: [{ name: 'models/gemini-flash-latest', supportedGenerationMethods: ['generateContent'] }],
      });
    });
    const names = await listGeminiModels(API_KEY, { fetch: f });
    expect(names).toEqual(['gemini-2.5-flash', 'gemini-flash-latest']);
    expect(calls.length).toBe(2);
  });
});
