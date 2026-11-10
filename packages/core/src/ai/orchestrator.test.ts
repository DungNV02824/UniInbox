import { DEFAULT_BUSINESS_HOURS } from '@dezon/shared';
import { describe, expect, it } from 'vitest';
import { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from './llm';
import {
  claimsHandoffInReply,
  HANDOFF_CLAIM_CORRECTION,
  HANDOFF_CLAIM_GUARD,
  runChatbotTurn,
  type ChatbotTurnDeps,
  type ChatbotTurnInput,
} from './orchestrator';
import { CHATBOT_TOOLS } from './tools';
import type { ChatbotConfig } from './types';

const chatbot: ChatbotConfig = {
  id: 'bot-1',
  name: 'Tư vấn',
  instructions: 'Thân thiện',
  knowledge: 'Bảo hành 5 năm',
  examples: [],
  handoffKeywords: ['gặp nhân viên', 'giảm giá'],
  handoffMessage: null,
  model: null,
  temperature: 0.3,
  escalateWhenUnsure: true,
};

const baseInput: ChatbotTurnInput = {
  chatbot,
  history: [],
  newMessages: [{ role: 'customer', text: 'Bảo hành bao lâu?' }],
  channelName: 'Dezon',
  businessHours: DEFAULT_BUSINESS_HOURS,
};

type Step = LlmResponse | LlmError | Error;

/** LlmClient giả: trả lần lượt các bước; ghi lại request. */
function fakeLlm(steps: Step[]) {
  const requests: LlmRequest[] = [];
  const llm: LlmClient = {
    async generate(req) {
      requests.push(req);
      const step = steps.shift();
      if (!step) throw new Error('hết bước giả');
      if (step instanceof Error) throw step;
      return step;
    },
  };
  return { llm, requests };
}

function res(partial: Partial<LlmResponse>): LlmResponse {
  return {
    functionCall: null,
    text: null,
    usage: { inputTokens: 100, outputTokens: 20 },
    model: 'gemini-2.5-flash-001',
    ...partial,
  };
}

/** Đồng hồ giả: mỗi lần gọi now() tiến 250ms. */
function clock() {
  let t = new Date('2026-11-09T07:00:00Z').getTime();
  return () => {
    const d = new Date(t);
    t += 250;
    return d;
  };
}

function deps(llm: LlmClient, extra: Partial<ChatbotTurnDeps> = {}) {
  const sleeps: number[] = [];
  const d: ChatbotTurnDeps = {
    llm,
    now: clock(),
    defaultModel: 'gemini-2.5-flash',
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  };
  return { d, sleeps };
}

describe('runChatbotTurn', () => {
  it('reply: trim, bỏ bong bóng rỗng, đúng model/tools/temperature/timeout', async () => {
    const { llm, requests } = fakeLlm([
      res({
        functionCall: {
          name: 'reply',
          args: { messages: ['  Dạ bên em bảo hành 5 năm ạ ', '', '   '], confidence: 0.9 },
        },
      }),
    ]);
    const { d } = deps(llm);
    const r = await runChatbotTurn(d, baseInput);
    expect(r.decision).toBe('reply');
    expect(r.messages).toEqual(['Dạ bên em bảo hành 5 năm ạ']);
    expect(r.confidence).toBe(0.9);
    expect(r.model).toBe('gemini-2.5-flash-001');
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(r.latencyMs).toBe(250);
    expect(r.toolCalls).toEqual([
      { name: 'reply', args: { messages: ['  Dạ bên em bảo hành 5 năm ạ ', '', '   '], confidence: 0.9 } },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: 'gemini-2.5-flash', temperature: 0.3, timeoutMs: 30_000 });
    expect(requests[0]?.tools.map((t) => t.name)).toEqual(['reply', 'escalate', 'no_reply']);
    expect(requests[0]?.systemInstruction).toContain('Bảo hành 5 năm');
  });

  it('meta của client (token cache ngầm, suy nghĩ, hedge) ghi vào toolCalls[0].llm', async () => {
    const meta = { cachedInputTokens: 2048, thoughtsTokens: 0, hedged: 'second' as const };
    const { llm } = fakeLlm([
      res({ functionCall: { name: 'reply', args: { messages: ['Dạ'], confidence: 0.9 } }, meta }),
    ]);
    const r = await runChatbotTurn(deps(llm).d, baseInput);
    expect(r.toolCalls).toEqual([{ name: 'reply', args: { messages: ['Dạ'], confidence: 0.9 }, llm: meta }]);

    const text = fakeLlm([
      res({ text: 'Dạ em chào anh', meta: { cachedInputTokens: 0, thoughtsTokens: 3 } }),
    ]);
    const t = await runChatbotTurn(deps(text.llm).d, baseInput);
    expect(t.toolCalls).toEqual([
      {
        name: 'text_fallback',
        args: { text: 'Dạ em chào anh' },
        llm: { cachedInputTokens: 0, thoughtsTokens: 3 },
      },
    ]);
  });

  it('dùng chatbot.model khi có', async () => {
    const { llm, requests } = fakeLlm([
      res({ functionCall: { name: 'no_reply', args: { reason: 'cảm ơn' } } }),
    ]);
    const { d } = deps(llm);
    await runChatbotTurn(d, { ...baseInput, chatbot: { ...chatbot, model: 'gemini-3.5-flash' } });
    expect(requests[0]?.model).toBe('gemini-3.5-flash');
  });

  it('thinking theo responseSpeed: thiếu ⇒ minimal (fast); balanced ⇒ low; thorough ⇒ high', async () => {
    const step = () => res({ functionCall: { name: 'no_reply', args: { reason: 'cảm ơn' } } });
    const { llm, requests } = fakeLlm([step(), step(), step(), step()]);
    const { d } = deps(llm);
    await runChatbotTurn(d, baseInput);
    await runChatbotTurn(d, { ...baseInput, chatbot: { ...chatbot, responseSpeed: 'fast' } });
    await runChatbotTurn(d, { ...baseInput, chatbot: { ...chatbot, responseSpeed: 'balanced' } });
    await runChatbotTurn(d, { ...baseInput, chatbot: { ...chatbot, responseSpeed: 'thorough' } });
    expect(requests.map((r) => r.thinking)).toEqual(['minimal', 'minimal', 'low', 'high']);
  });

  it('pre-filter từ khóa ⇒ escalate human_request, không gọi LLM', async () => {
    const { llm, requests } = fakeLlm([]);
    const { d } = deps(llm);
    const r = await runChatbotTurn(d, {
      ...baseInput,
      newMessages: [
        { role: 'customer', text: 'ok' },
        { role: 'customer', text: 'Cho em GAP NHAN VIEN' },
      ],
    });
    expect(requests).toHaveLength(0);
    expect(r).toMatchObject({
      decision: 'escalate',
      reasonCode: 'human_request',
      matchedKeyword: 'gặp nhân viên',
      summary: 'Khách nhắn từ khóa chuyển người "gặp nhân viên" (Khách muốn gặp nhân viên)',
      usage: { inputTokens: 0, outputTokens: 0 },
      latencyMs: 0,
      model: 'gemini-2.5-flash',
      toolCalls: [{ name: 'prefilter', args: { keyword: 'gặp nhân viên', reason_code: 'human_request' } }],
    });
  });

  it('pre-filter: từ khóa "giảm giá" ⇒ discount, tóm tắt có từ khóa', async () => {
    const { llm } = fakeLlm([]);
    const r = await runChatbotTurn(deps(llm).d, {
      ...baseInput,
      newMessages: [{ role: 'customer', text: 'Shop giam gia cho em nhe' }],
    });
    expect(r).toMatchObject({
      decision: 'escalate',
      reasonCode: 'discount',
      summary: 'Khách nhắn từ khóa chuyển người "giảm giá" (Khách hỏi giảm giá / khuyến mãi)',
    });
  });

  it('pre-filter chỉ xét tin mới của khách (không xét lịch sử/tin bot)', async () => {
    const { llm, requests } = fakeLlm([res({ functionCall: { name: 'no_reply', args: { reason: 'x' } } })]);
    const { d } = deps(llm);
    await runChatbotTurn(d, {
      ...baseInput,
      history: [{ role: 'customer', text: 'giảm giá đi' }],
      newMessages: [{ role: 'customer', text: 'cảm ơn' }],
    });
    expect(requests).toHaveLength(1);
  });

  it('escalate từ model', async () => {
    const { llm } = fakeLlm([
      res({
        functionCall: {
          name: 'escalate',
          args: { reason_code: 'complaint', summary_for_agent: 'Khách bực vì giao trễ' },
        },
      }),
    ]);
    const r = await runChatbotTurn(deps(llm).d, baseInput);
    expect(r).toMatchObject({
      decision: 'escalate',
      reasonCode: 'complaint',
      summary: 'Khách bực vì giao trễ',
    });
  });

  it('escalate có messages_to_customer ⇒ messages (trim, bỏ rỗng, ≤ 3 tin, mỗi tin ≤ 1000 ký tự); rỗng/null ⇒ bỏ', async () => {
    const quote = 'Dạ với 5 ảnh công trình thì mức thù lao dự kiến là 50.000đ ạ.';
    const esc = (messages_to_customer: unknown) =>
      res({
        functionCall: {
          name: 'escalate',
          args: { reason_code: 'other', summary_for_agent: 'CT A, 5 ảnh, 50.000đ', messages_to_customer },
        },
      });
    const { llm } = fakeLlm([
      esc([`  ${quote} `, ' ', 'Em đã chuyển hồ sơ cho bộ phận duyệt ạ.']),
      esc(['a '.repeat(800), 'b', 'c', 'd', 'e']),
      esc(null),
      esc([' ', '']),
      esc(quote), // model trả chuỗi đơn ⇒ coi như một tin
      esc([quote, 42, null]), // phần tử không phải chuỗi ⇒ bỏ
    ]);
    const d = deps(llm).d;
    const r1 = await runChatbotTurn(d, baseInput);
    expect(r1).toMatchObject({
      decision: 'escalate',
      reasonCode: 'other',
      summary: 'CT A, 5 ảnh, 50.000đ',
      messages: [quote, 'Em đã chuyển hồ sơ cho bộ phận duyệt ạ.'],
    });
    expect(r1.toolCalls).toHaveLength(1);
    const r2 = await runChatbotTurn(d, baseInput);
    expect(r2.messages).toHaveLength(3);
    expect(Array.from(r2.messages![0]!).length).toBeLessThanOrEqual(1000);
    expect(r2.messages![0]!.endsWith('…')).toBe(true);
    expect((await runChatbotTurn(d, baseInput)).messages).toBeUndefined();
    expect((await runChatbotTurn(d, baseInput)).messages).toBeUndefined();
    expect((await runChatbotTurn(d, baseInput)).messages).toEqual([quote]);
    expect((await runChatbotTurn(d, baseInput)).messages).toEqual([quote]);
  });

  it('tool escalate khai báo messages_to_customer (mảng ≤ 3, tùy chọn) và nói rõ phải escalate khi báo đã chuyển', () => {
    const escalateTool = CHATBOT_TOOLS.find((t) => t.name === 'escalate')!;
    const params = escalateTool.parameters as {
      properties: Record<string, { type?: string; maxItems?: number }>;
      required: string[];
    };
    expect(params.properties.messages_to_customer).toMatchObject({ type: 'array', maxItems: 3 });
    expect(params.properties).not.toHaveProperty('message_to_customer');
    expect(params.required).not.toContain('messages_to_customer');
    expect(escalateTool.description).toContain('PHẢI gọi công cụ này');
    expect(escalateTool.description).toContain('messages_to_customer');
  });

  describe('chặn reply tự nói "đã chuyển nhân viên"', () => {
    const claim = [
      'Dạ em đã nhận đủ 5 ảnh công trình ạ.',
      'Em đã chuyển hồ sơ cho bộ phận duyệt để tiến hành kiểm tra và thanh toán cho anh/chị nhé.',
    ];
    const quote = 'Dạ với 5 ảnh công trình thì mức thù lao dự kiến là 50.000đ ạ.';
    const claimRes = (messages = claim) =>
      res({ functionCall: { name: 'reply', args: { messages, confidence: 0.9 } } });

    it('gọi lại MỘT lần kèm ghi chú; lần sau escalate ⇒ dùng escalate (messages_to_customer)', async () => {
      const { llm, requests } = fakeLlm([
        claimRes(),
        res({
          functionCall: {
            name: 'escalate',
            args: {
              reason_code: 'other',
              summary_for_agent: 'CTV gửi đủ 5 ảnh',
              messages_to_customer: [quote, 'Em đã chuyển hồ sơ cho bộ phận duyệt ạ.'],
            },
          },
          model: 'gemini-retry',
        }),
      ]);
      const r = await runChatbotTurn(deps(llm).d, baseInput);
      expect(r).toMatchObject({
        decision: 'escalate',
        reasonCode: 'other',
        summary: 'CTV gửi đủ 5 ảnh',
        messages: [quote, 'Em đã chuyển hồ sơ cho bộ phận duyệt ạ.'],
        usage: { inputTokens: 200, outputTokens: 40 },
        model: 'gemini-retry',
      });
      expect(requests).toHaveLength(2);
      // Lần gọi lại: cùng system/tools, content cuối thêm đúng một part ghi chú (không đổi tiền tố prompt).
      expect(requests[1]!.systemInstruction).toBe(requests[0]!.systemInstruction);
      expect(requests[1]!.tools).toBe(requests[0]!.tools);
      const lastParts = (i: number) => requests[i]!.contents.at(-1)!.parts;
      expect(lastParts(1)).toHaveLength(lastParts(0).length + 1);
      const note = lastParts(1).at(-1) as { text: string };
      expect(note.text).toContain(HANDOFF_CLAIM_CORRECTION);
      expect(note.text).toContain('Em đã chuyển hồ sơ cho bộ phận duyệt');
      expect(lastParts(0).at(-1)).not.toHaveProperty('text', note.text);
      expect(r.toolCalls.map((c) => (c as { name: string }).name)).toEqual([
        'reply',
        HANDOFF_CLAIM_GUARD,
        'escalate',
      ]);
      expect(r.toolCalls[1]).toEqual({ name: HANDOFF_CLAIM_GUARD, args: { action: 'retry' } });
    });

    it('lần sau trả lời lại không nói đã chuyển ⇒ reply bình thường', async () => {
      const fixed = ['Dạ em đã nhận đủ 5 ảnh ạ, anh/chị cho em xin tên nhà thầu nhé.'];
      const { llm } = fakeLlm([claimRes(), claimRes(fixed)]);
      const r = await runChatbotTurn(deps(llm).d, baseInput);
      expect(r).toMatchObject({ decision: 'reply', messages: fixed, confidence: 0.9 });
      expect(r.toolCalls).toHaveLength(3);
    });

    it('lần sau VẪN nói đã chuyển ⇒ hệ thống đổi thành escalate other, messages = bong bóng mới nhất', async () => {
      const again = ['Dạ em gửi hồ sơ sang bộ phận duyệt rồi ạ.'];
      const { llm } = fakeLlm([claimRes(), claimRes(again)]);
      const r = await runChatbotTurn(deps(llm).d, {
        ...baseInput,
        chatbot: { ...chatbot, escalateWhenUnsure: false },
      });
      expect(r).toMatchObject({
        decision: 'escalate',
        reasonCode: 'other',
        messages: again,
        confidence: 0.9,
      });
      expect(r.summary).toContain('không gọi escalate');
      expect(r.summary).toContain('Dạ em gửi hồ sơ sang bộ phận duyệt rồi ạ.');
      expect(r.toolCalls.map((c) => (c as { name: string }).name)).toEqual([
        'reply',
        HANDOFF_CLAIM_GUARD,
        'reply',
        HANDOFF_CLAIM_GUARD,
      ]);
      expect(r.toolCalls[3]).toEqual({
        name: HANDOFF_CLAIM_GUARD,
        args: { action: 'convert', reason_code: 'other', messages: again },
      });
    });

    it('lần gọi lại lỗi ⇒ vẫn chuyển người với bong bóng ban đầu', async () => {
      const { llm } = fakeLlm([claimRes(), new LlmError('hỏng', false)]);
      const r = await runChatbotTurn(deps(llm).d, baseInput);
      expect(r).toMatchObject({ decision: 'escalate', reasonCode: 'other', messages: claim });
      expect(r.toolCalls.map((c) => (c as { args: { action?: string } }).args.action)).toEqual([
        undefined,
        'retry',
        'retry_failed',
        'convert',
      ]);
    });

    it('lần gọi lại no_reply ⇒ chấp nhận (không gửi gì)', async () => {
      const { llm } = fakeLlm([
        claimRes(),
        res({ functionCall: { name: 'no_reply', args: { reason: 'Đã trả lời đủ' } } }),
      ]);
      const r = await runChatbotTurn(deps(llm).d, baseInput);
      expect(r).toMatchObject({ decision: 'no_reply', reason: 'Đã trả lời đủ' });
    });

    it('reply bình thường / câu hỏi chuyển nhân viên ⇒ KHÔNG gọi lại', async () => {
      const { llm, requests } = fakeLlm([
        claimRes(['Anh/chị có muốn em chuyển cho nhân viên không ạ?']),
        claimRes(['Dạ em chỉ phụ trách tiếp nhận ảnh thi công ạ.']),
      ]);
      const d = deps(llm).d;
      expect((await runChatbotTurn(d, baseInput)).decision).toBe('reply');
      expect((await runChatbotTurn(d, baseInput)).decision).toBe('reply');
      expect(requests).toHaveLength(2);
    });

    it('chữ thường (text fallback) tự nói đã chuyển cũng bị chặn', async () => {
      const { llm } = fakeLlm([
        res({ text: 'Dạ em đã chuyển cho nhân viên rồi ạ' }),
        res({ text: 'Dạ em đã chuyển cho nhân viên rồi ạ' }),
      ]);
      const r = await runChatbotTurn(deps(llm).d, baseInput);
      expect(r).toMatchObject({
        decision: 'escalate',
        reasonCode: 'other',
        messages: ['Dạ em đã chuyển cho nhân viên rồi ạ'],
      });
    });
  });

  it('claimsHandoffInReply: bắt lời khẳng định đã/sẽ chuyển (có dấu hoặc không dấu)', () => {
    for (const claim of [
      'Em đã chuyển hồ sơ cho bộ phận duyệt để tiến hành kiểm tra và thanh toán cho anh/chị nhé.',
      'Dạ vâng. Em gửi hồ sơ sang bộ phận duyệt để xem xét ạ.',
      'Em gửi hồ sơ chuyển bộ phận duyệt xem xét giúp mình nhé.',
      'Em đã chuyển hồ sơ để bộ phận phụ trách kiểm tra và duyệt thanh toán',
      'Dạ em sẽ chuyển cho nhân viên ngay ạ',
      'Em đã báo người phụ trách rồi ạ.',
      'Dạ hồ sơ đã được chuyển sang bộ phận duyệt ạ.',
      'Em đã gửi toàn bộ ảnh cho bộ phận duyệt rồi ạ.',
      'Em chuyển tiếp cho quản lý xử lý giúp anh/chị nhé.',
      'Dạ, nhân viên bên em sẽ liên hệ lại anh/chị ngay ạ.',
      'Bộ phận duyệt sẽ duyệt hồ sơ của anh/chị ạ.',
      'Hồ sơ của anh/chị bộ phận kế toán đang kiểm tra ạ.',
      'Da em da chuyen ho so cho bo phan duyet a', // không dấu
      'DẠ EM ĐÃ CHUYỂN CHO NHÂN VIÊN RỒI Ạ',
      'Dạ em đã nhận đủ ảnh, em đã chuyển hồ sơ cho bộ phận duyệt ạ.',
    ]) {
      expect(claimsHandoffInReply(['Dạ em cảm ơn anh/chị.', claim]), claim).toBe(true);
    }
  });

  it('claimsHandoffInReply: KHÔNG bắt câu hỏi / điều kiện / phủ định / người nhắn làm / giải thích quy trình', () => {
    for (const fine of [
      'Anh/chị có muốn em chuyển cho nhân viên không?',
      'Anh/chị có muốn em chuyển cho nhân viên không ạ',
      'Dạ em chỉ phụ trách tiếp nhận ảnh thi công ạ.',
      'Em chỉ phụ trách tiếp nhận, việc duyệt do bộ phận khác ạ.',
      'Nếu anh/chị cần, em chuyển cho nhân viên hỗ trợ ạ.',
      'Khi đủ ảnh và thông tin, em sẽ chuyển hồ sơ cho bộ phận duyệt ạ.',
      'Sau khi nhận đủ 5 ảnh, bộ phận duyệt sẽ kiểm tra ạ.',
      'Em chưa chuyển được cho bộ phận duyệt vì còn thiếu tên nhà thầu ạ.',
      'Em không thể chuyển hồ sơ khi chưa đủ ảnh ạ.',
      'Dạ em bên bộ phận tiếp nhận hồ sơ thi công của Dezon ạ.',
      'Anh/chị gửi giúp em ảnh có ghi ngày thi công nhé.',
      'Anh/chị gửi hồ sơ cho em nhé.',
      'Cảm ơn anh/chị đã chuyển hồ sơ cho em ạ.',
      'Dạ với 5 ảnh công trình thì mức thù lao dự kiến là 50.000đ ạ.',
      'Việc duyệt và thanh toán do bộ phận duyệt thực hiện ạ.',
      'Bộ phận duyệt sẽ duyệt trong vòng 3 ngày làm việc ạ.',
      'Chuyện này bộ phận duyệt quyết định ạ.',
      'Em gửi anh/chị số điện thoại của bộ phận kế toán: 0909 000 000 ạ.',
      'Em báo anh/chị biết là bộ phận duyệt cần ảnh rõ hơn ạ.',
      'Em đã chuyển khoản cho anh rồi ạ.',
      'Dạ em đã nhận đủ ảnh, anh/chị cho em xin tên công trình ạ.',
    ]) {
      expect(claimsHandoffInReply([fine]), fine).toBe(false);
    }
  });

  it('escalate với tóm tắt rỗng ⇒ dùng nhãn lý do', async () => {
    const { llm } = fakeLlm([
      res({ functionCall: { name: 'escalate', args: { reason_code: 'closing', summary_for_agent: ' ' } } }),
    ]);
    const r = await runChatbotTurn(deps(llm).d, baseInput);
    expect(r.summary).toBe('Khách muốn đặt hàng / đặt lịch');
  });

  it('no_reply', async () => {
    const { llm } = fakeLlm([
      res({ functionCall: { name: 'no_reply', args: { reason: 'Khách chỉ cảm ơn' } } }),
    ]);
    const r = await runChatbotTurn(deps(llm).d, baseInput);
    expect(r).toMatchObject({ decision: 'no_reply', reason: 'Khách chỉ cảm ơn' });
  });

  it('confidence thấp ⇒ escalate low_confidence, KHÔNG gửi câu trả lời không chắc (không có messages)', async () => {
    const { llm } = fakeLlm([
      res({ functionCall: { name: 'reply', args: { messages: ['Chắc là 3 năm ạ'], confidence: 0.4 } } }),
    ]);
    const r = await runChatbotTurn(deps(llm).d, baseInput);
    expect(r).toMatchObject({
      decision: 'escalate',
      reasonCode: 'low_confidence',
      summary: 'AI không chắc câu trả lời (độ tự tin 0.40)',
      confidence: 0.4,
    });
    expect(r.messages).toBeUndefined();
    expect(r.toolCalls[0]).toMatchObject({ name: 'reply', args: { messages: ['Chắc là 3 năm ạ'] } });
  });

  it('ngưỡng minConfidence tùy chỉnh', async () => {
    const { llm } = fakeLlm([
      res({ functionCall: { name: 'reply', args: { messages: ['Dạ'], confidence: 0.7 } } }),
    ]);
    const r = await runChatbotTurn(deps(llm, { minConfidence: 0.8 }).d, baseInput);
    expect(r.reasonCode).toBe('low_confidence');
  });

  it('escalateWhenUnsure = false: confidence thấp vẫn reply (kể cả ngưỡng tùy chỉnh)', async () => {
    const { llm } = fakeLlm([
      res({ functionCall: { name: 'reply', args: { messages: ['Chắc là 3 năm ạ'], confidence: 0.1 } } }),
    ]);
    const r = await runChatbotTurn(deps(llm, { minConfidence: 0.9 }).d, {
      ...baseInput,
      chatbot: { ...chatbot, escalateWhenUnsure: false },
    });
    expect(r).toMatchObject({ decision: 'reply', messages: ['Chắc là 3 năm ạ'], confidence: 0.1 });
    expect(r.reasonCode).toBeUndefined();
  });

  it('escalateWhenUnsure = false: model tự gọi escalate vẫn được tôn trọng; text fallback vẫn reply', async () => {
    const off = { ...baseInput, chatbot: { ...chatbot, escalateWhenUnsure: false } };
    const { llm } = fakeLlm([
      res({
        functionCall: {
          name: 'escalate',
          args: { reason_code: 'complaint', summary_for_agent: 'Khách bực' },
        },
      }),
      res({ text: 'Dạ mình chưa chắc, bạn đợi xác nhận nhé.' }),
    ]);
    expect(await runChatbotTurn(deps(llm).d, off)).toMatchObject({
      decision: 'escalate',
      reasonCode: 'complaint',
    });
    expect(await runChatbotTurn(deps(llm, { minConfidence: 0.95 }).d, off)).toMatchObject({
      decision: 'reply',
      confidence: 0.7,
    });
  });

  it('prompt gửi model phản ánh escalateWhenUnsure', async () => {
    const on = fakeLlm([res({ functionCall: { name: 'no_reply', args: { reason: 'ok' } } })]);
    await runChatbotTurn(deps(on.llm).d, baseInput);
    expect(on.requests[0]?.systemInstruction).toContain('bạn không chắc ⇒ `escalate`');
    const off = fakeLlm([res({ functionCall: { name: 'no_reply', args: { reason: 'ok' } } })]);
    await runChatbotTurn(deps(off.llm).d, {
      ...baseInput,
      chatbot: { ...chatbot, escalateWhenUnsure: false },
    });
    expect(off.requests[0]?.systemInstruction).not.toContain('bạn không chắc ⇒ `escalate`');
    expect(off.requests[0]?.systemInstruction).toContain('không chuyển nhân viên chỉ vì không chắc');
  });

  it('tool escalate: escalateWhenUnsure = false ⇒ bỏ out_of_scope / low_confidence khỏi reason_code', async () => {
    const reasonEnum = (
      tools: readonly { name: string; parameters: Record<string, unknown> }[] | undefined,
    ) => {
      const esc = tools?.find((t) => t.name === 'escalate');
      const props = esc?.parameters.properties as { reason_code: { enum: string[] } } | undefined;
      return props?.reason_code.enum ?? [];
    };
    const on = fakeLlm([res({ functionCall: { name: 'no_reply', args: { reason: 'ok' } } })]);
    await runChatbotTurn(deps(on.llm).d, baseInput);
    expect(on.requests[0]?.tools).toBe(CHATBOT_TOOLS);
    expect(reasonEnum(on.requests[0]?.tools)).toEqual(
      expect.arrayContaining(['out_of_scope', 'low_confidence']),
    );
    const off = fakeLlm([res({ functionCall: { name: 'no_reply', args: { reason: 'ok' } } })]);
    await runChatbotTurn(deps(off.llm).d, {
      ...baseInput,
      chatbot: { ...chatbot, escalateWhenUnsure: false },
    });
    const offEnum = reasonEnum(off.requests[0]?.tools);
    expect(offEnum).not.toContain('out_of_scope');
    expect(offEnum).not.toContain('low_confidence');
    expect(offEnum).toEqual(
      expect.arrayContaining(['human_request', 'complaint', 'discount', 'closing', 'other']),
    );
    // không làm thay đổi khai báo dùng chung
    expect(reasonEnum(CHATBOT_TOOLS)).toContain('out_of_scope');
    expect(off.requests[0]?.tools?.map((t) => t.name)).toEqual(['reply', 'escalate', 'no_reply']);
  });

  it('reply toàn bong bóng rỗng ⇒ error', async () => {
    const { llm } = fakeLlm([
      res({ functionCall: { name: 'reply', args: { messages: [' '], confidence: 0.9 } } }),
    ]);
    const r = await runChatbotTurn(deps(llm).d, baseInput);
    expect(r).toMatchObject({ decision: 'error', reasonCode: 'other' });
  });

  it('args sai / tool lạ ⇒ error', async () => {
    const bad = fakeLlm([res({ functionCall: { name: 'reply', args: { messages: 'x', confidence: 2 } } })]);
    expect(await runChatbotTurn(deps(bad.llm).d, baseInput)).toMatchObject({
      decision: 'error',
      reasonCode: 'other',
    });
    const unknown = fakeLlm([res({ functionCall: { name: 'delete_all', args: {} } })]);
    const r = await runChatbotTurn(deps(unknown.llm).d, baseInput);
    expect(r.decision).toBe('error');
    expect(r.reason).toContain('delete_all');
  });

  it('lỗi tạm thời ⇒ thử lại với backoff rồi thành công', async () => {
    const { llm, requests } = fakeLlm([
      new LlmError('HTTP 503', true, 503),
      new LlmError('timeout', true),
      res({ functionCall: { name: 'no_reply', args: { reason: 'ok' } } }),
    ]);
    const { d, sleeps } = deps(llm);
    const r = await runChatbotTurn(d, baseInput);
    expect(r.decision).toBe('no_reply');
    expect(requests).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('hết lượt thử ⇒ error "Lỗi gọi AI"', async () => {
    const { llm, requests } = fakeLlm([
      new LlmError('HTTP 429', true, 429),
      new LlmError('HTTP 429', true, 429),
      new LlmError('HTTP 429 lần 3', true, 429),
    ]);
    const r = await runChatbotTurn(deps(llm).d, baseInput);
    expect(requests).toHaveLength(3);
    expect(r).toMatchObject({ decision: 'error', reasonCode: 'other', reason: 'Lỗi gọi AI: HTTP 429 lần 3' });
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(r.toolCalls).toEqual([]);
  });

  it('lượt có ảnh: timeout nới +3 s/ảnh đính kèm; hết thời gian chờ chỉ thử lại 1 lần', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64');
    const images = [
      { mime: 'image/jpeg', data: jpeg },
      { mime: 'image/jpeg', data: jpeg },
      { mime: 'image/jpeg', data: '', skipped: 'unavailable' as const },
    ];
    const timeout = () => new LlmError('Hết thời gian chờ AI (36s)', true, undefined, true);
    const { llm, requests } = fakeLlm([timeout(), timeout(), res({ text: 'không tới' })]);
    const r = await runChatbotTurn(deps(llm).d, { ...baseInput, images });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.timeoutMs).toBe(30_000 + 2 * 3_000);
    expect(r).toMatchObject({ decision: 'error', reason: 'Lỗi gọi AI: Hết thời gian chờ AI (36s)' });
    // Không có ảnh: timeout vẫn thử lại đủ LLM_MAX_RETRIES lần, timeout gốc.
    const plain = fakeLlm([
      timeout(),
      timeout(),
      res({ functionCall: { name: 'no_reply', args: { reason: 'ok' } } }),
    ]);
    expect((await runChatbotTurn(deps(plain.llm).d, baseInput)).decision).toBe('no_reply');
    expect(plain.requests).toHaveLength(3);
    expect(plain.requests[0]!.timeoutMs).toBe(30_000);
  });

  it('lỗi không retryable (hoặc lỗi lạ) ⇒ không thử lại', async () => {
    const a = fakeLlm([new LlmError('HTTP 400: API key not valid', false, 400)]);
    const r = await runChatbotTurn(deps(a.llm).d, baseInput);
    expect(a.requests).toHaveLength(1);
    expect(r.reason).toBe('Lỗi gọi AI: HTTP 400: API key not valid');
    const b = fakeLlm([new Error('boom')]);
    expect((await runChatbotTurn(deps(b.llm).d, baseInput)).decision).toBe('error');
    expect(b.requests).toHaveLength(1);
  });

  it('model trả chữ ngắn thay vì gọi tool ⇒ reply confidence 0.7, tách bong bóng', async () => {
    const { llm } = fakeLlm([res({ text: 'Dạ bên em bảo hành 5 năm ạ.\nAnh/chị cần thêm gì không ạ?' })]);
    const r = await runChatbotTurn(deps(llm).d, baseInput);
    expect(r).toMatchObject({
      decision: 'reply',
      confidence: 0.7,
      messages: ['Dạ bên em bảo hành 5 năm ạ.', 'Anh/chị cần thêm gì không ạ?'],
    });
    expect(r.toolCalls).toEqual([
      { name: 'text_fallback', args: { text: 'Dạ bên em bảo hành 5 năm ạ.\nAnh/chị cần thêm gì không ạ?' } },
    ]);
  });

  it('chữ thường quá dài / giống markdown / rỗng ⇒ error', async () => {
    for (const text of ['x'.repeat(700), '**Giá**: 5 triệu', null]) {
      const { llm } = fakeLlm([res({ text })]);
      const r = await runChatbotTurn(deps(llm).d, baseInput);
      expect(r.decision).toBe('error');
    }
  });

  it('không bao giờ ném lỗi kể cả khi now() lỗi', async () => {
    const { llm } = fakeLlm([]);
    const r = await runChatbotTurn(
      {
        ...deps(llm).d,
        now: () => {
          throw new Error('clock hỏng');
        },
      },
      baseInput,
    );
    expect(r.decision).toBe('error');
    expect(r.reason).toContain('clock hỏng');
  });

  it('reply > 3 bong bóng ⇒ nhận và cắt còn 3; bong bóng dài cắt ≤ 1000 ký tự ở ranh giới từ', async () => {
    const long = 'xin chào '.repeat(200); // 1800 ký tự
    const { llm } = fakeLlm([
      res({
        functionCall: { name: 'reply', args: { messages: [long, 'b', 'c', 'd', 'e'], confidence: 0.9 } },
      }),
    ]);
    const r = await runChatbotTurn(deps(llm).d, baseInput);
    expect(r.decision).toBe('reply');
    expect(r.messages).toHaveLength(3);
    const first = r.messages![0]!;
    expect(first.length).toBeLessThanOrEqual(1000);
    expect(first.endsWith('chào…') || first.endsWith('xin…')).toBe(true);
    expect(r.messages!.slice(1)).toEqual(['b', 'c']);
  });

  it('escalate: summary bỏ link và ≤ 500 ký tự; tool_calls log có giới hạn', async () => {
    const summary = `Khách hỏi https://evil.example/login?x=1 và www.phish.test ${'rất dài '.repeat(200)}`;
    const { llm } = fakeLlm([
      res({ functionCall: { name: 'escalate', args: { reason_code: 'other', summary_for_agent: summary } } }),
    ]);
    const r = await runChatbotTurn(deps(llm).d, baseInput);
    expect(r.decision).toBe('escalate');
    expect(r.summary!.length).toBeLessThanOrEqual(500);
    expect(r.summary).toContain('[link]');
    expect(r.summary).not.toMatch(/evil|phish/);
    const logged = JSON.stringify(r.toolCalls);
    expect(logged.length).toBeLessThan(2600);
  });

  it('no_reply: lý do dài bị cắt', async () => {
    const { llm } = fakeLlm([
      res({ functionCall: { name: 'no_reply', args: { reason: 'a '.repeat(2000) } } }),
    ]);
    const r = await runChatbotTurn(deps(llm).d, baseInput);
    expect(r.reason!.length).toBeLessThanOrEqual(500);
  });
});
