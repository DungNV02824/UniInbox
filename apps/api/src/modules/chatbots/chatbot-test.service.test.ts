import type { LlmClient, LlmRequest } from '@dezon/core';
import type { Db } from '@dezon/db';
import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config';
import { ChatbotModelsService } from './chatbot-models.service';
import {
  botContinuesAfterHandoff,
  ChatbotTestService,
  customerFacingMessages,
  splitTestMessages,
  TEST_RATE_LIMIT,
} from './chatbot-test.service';

const config = { GEMINI_MODEL: 'gemini-2.5-flash', AI_MIN_CONFIDENCE: 0.6 } as AppConfig;

describe('customerFacingMessages', () => {
  it('reply ⇒ bong bóng; escalate ⇒ messages hoặc handoffMessage; error ⇒ handoffMessage; no_reply ⇒ []', () => {
    expect(customerFacingMessages({ decision: 'reply', messages: ['a', 'b'] }, 'H')).toEqual(['a', 'b']);
    expect(customerFacingMessages({ decision: 'escalate', messages: ['báo giá'] }, 'H')).toEqual(['báo giá']);
    expect(customerFacingMessages({ decision: 'escalate' }, ' H ')).toEqual(['H']);
    expect(customerFacingMessages({ decision: 'escalate', messages: [] }, null)).toEqual([]);
    expect(customerFacingMessages({ decision: 'error' }, 'H')).toEqual(['H']);
    expect(customerFacingMessages({ decision: 'no_reply' }, 'H')).toEqual([]);
  });
});

describe('botContinuesAfterHandoff', () => {
  it("chỉ escalate do AI tự chuyển với bot 'continue'", () => {
    const cont = { aiHandoffMode: 'continue' as const };
    expect(botContinuesAfterHandoff({ decision: 'escalate' }, cont)).toBe(true);
    expect(botContinuesAfterHandoff({ decision: 'escalate', matchedKeyword: 'gặp nhân viên' }, cont)).toBe(
      false,
    );
    expect(botContinuesAfterHandoff({ decision: 'reply' }, cont)).toBe(false);
    // Lỗi AI ⇒ chạy thật chuyển người (AI tự chuyển) ⇒ bot 'continue' vẫn trả lời.
    expect(botContinuesAfterHandoff({ decision: 'error' }, cont)).toBe(true);
    expect(botContinuesAfterHandoff({ decision: 'error' }, { aiHandoffMode: 'stop' })).toBe(false);
    expect(botContinuesAfterHandoff({ decision: 'escalate' }, { aiHandoffMode: 'stop' })).toBe(false);
    expect(botContinuesAfterHandoff({ decision: 'escalate' }, {})).toBe(false);
  });
});

describe('splitTestMessages', () => {
  it('handoffOpened ⇒ dòng [Hệ thống] handoff còn mở ngay sau tin đó (lượt sau chạy như bot continue thật)', () => {
    const { history, newMessages } = splitTestMessages([
      { role: 'customer', text: 'Em gửi 7 ảnh', imageCount: 7 },
      { role: 'bot', text: 'Dạ em đã nhận đủ ảnh', handoffOpened: 'other' },
      { role: 'customer', text: 'hello' },
    ]);
    expect(history).toEqual([
      { role: 'customer', text: 'Em gửi 7 ảnh', attachmentCount: 7 },
      { role: 'bot', text: 'Dạ em đã nhận đủ ảnh' },
      {
        role: 'system',
        text: 'Hội thoại đã được chuyển cho nhân viên (lý do: Lý do khác).',
        handoffOpen: true,
      },
    ]);
    expect(newMessages).toEqual([{ role: 'customer', text: 'hello' }]);
  });

  it('lượt chuyển không có tin bot (đánh dấu ở tin khách) ⇒ tin đó thành lịch sử, chỉ tin sau là tin mới', () => {
    const { history, newMessages } = splitTestMessages([
      { role: 'customer', text: 'chào' },
      { role: 'bot', text: 'Dạ em chào anh' },
      { role: 'customer', text: 'giá bao nhiêu', handoffOpened: 'low_confidence' },
      { role: 'customer', text: 'hello' },
    ]);
    expect(history.map((h) => h.role)).toEqual(['customer', 'bot', 'customer', 'system']);
    expect(history.at(-1)).toMatchObject({ handoffOpen: true });
    expect(newMessages).toEqual([{ role: 'customer', text: 'hello' }]);
  });

  it('các tin khách cuối là tin mới, phần trước là lịch sử', () => {
    const { history, newMessages } = splitTestMessages([
      { role: 'customer', text: 'a' },
      { role: 'bot', text: 'b' },
      { role: 'agent', text: 'c' },
      { role: 'customer', text: 'd' },
      { role: 'customer', text: 'e' },
    ]);
    expect(history.map((m) => m.text)).toEqual(['a', 'b', 'c']);
    expect(newMessages).toEqual([
      { role: 'customer', text: 'd' },
      { role: 'customer', text: 'e' },
    ]);
  });

  it('ảnh: chỉ ảnh của các tin khách cuối thành images (đúng thứ tự); lịch sử chỉ ghi số ảnh', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]).toString('base64');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString('base64');
    const { history, newMessages, images } = splitTestMessages([
      { role: 'customer', text: 'cũ', images: [{ mimeType: 'image/jpeg', data: jpeg }] },
      { role: 'bot', text: 'b' },
      {
        role: 'customer',
        text: '',
        images: [
          { mimeType: 'image/jpeg', data: png },
          { mimeType: 'image/jpeg', data: jpeg },
        ],
      },
    ]);
    expect(history[0]).toEqual({ role: 'customer', text: 'cũ', attachmentCount: 1 });
    expect(newMessages).toEqual([{ role: 'customer', text: null, attachmentCount: 2 }]);
    expect(images).toEqual([
      { mime: 'image/png', data: png, messageIndex: 1 },
      { mime: 'image/jpeg', data: jpeg, messageIndex: 1 },
    ]);
  });

  it('lượt cũ chỉ có imageCount (text rỗng) ⇒ attachmentCount, text null; lấy max(imageCount, số ảnh gửi kèm)', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]).toString('base64');
    const { history, newMessages, images } = splitTestMessages([
      { role: 'customer', text: '', imageCount: 5 },
      {
        role: 'customer',
        text: 'CT A',
        imageCount: 1,
        images: [
          { mimeType: 'image/jpeg', data: jpeg },
          { mimeType: 'image/jpeg', data: jpeg },
        ],
      },
      { role: 'bot', text: 'Dạ' },
      { role: 'customer', text: 'mới' },
      { role: 'customer', text: '', images: [{ mimeType: 'image/jpeg', data: jpeg }] },
    ]);
    expect(history.slice(0, 2)).toEqual([
      { role: 'customer', text: null, attachmentCount: 5 },
      { role: 'customer', text: 'CT A', attachmentCount: 2 },
    ]);
    expect(newMessages[1]).toEqual({ role: 'customer', text: null, attachmentCount: 1 });
    expect(images).toEqual([{ mime: 'image/jpeg', data: jpeg, messageIndex: 2 }]);
  });

  it('ảnh không nhận dạng được (kể cả trong lịch sử) => 400 nêu số thứ tự ảnh', () => {
    const text = Buffer.from('không phải ảnh').toString('base64');
    expect(() =>
      splitTestMessages([
        { role: 'customer', text: 'cũ', images: [{ mimeType: 'image/png', data: text }] },
        { role: 'bot', text: 'b' },
        { role: 'customer', text: 'mới' },
      ]),
    ).toThrow('Ảnh thứ 1 không phải ảnh');
  });

  it('tin cuối không phải của khách => 400', () => {
    expect(() => splitTestMessages([{ role: 'bot', text: 'x' }])).toThrow('phải là tin của khách');
  });
});

describe('ChatbotTestService', () => {
  const draft = { name: 'Nháp' };
  const messages = [{ role: 'customer' as const, text: 'Chào' }];

  it('chưa có GEMINI_API_KEY => 503', async () => {
    const service = new ChatbotTestService({} as Db, config, null);
    await expect(service.testDraft('u1', draft, messages)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('quá giới hạn chạy thử mỗi phút => 429 (đếm theo từng admin)', async () => {
    const service = new ChatbotTestService({} as Db, config, {
      generate: () => Promise.reject(new Error('x')),
    });
    // Chặn ở bước tách tin (400) để không cần DB/orchestrator: lượt vẫn bị tính.
    const bad = [{ role: 'bot' as const, text: 'x' }];
    for (let i = 0; i < TEST_RATE_LIMIT.limit; i++) {
      await expect(service.testDraft('u1', draft, bad)).rejects.toMatchObject({ status: 400 });
    }
    const limited = service.testDraft('u1', draft, bad);
    await expect(limited).rejects.toBeInstanceOf(HttpException);
    await expect(limited).rejects.toMatchObject({ status: 429 });
    await expect(service.testDraft('u2', draft, bad)).rejects.toMatchObject({ status: 400 });
  });

  /** Db giả: select…limit ⇒ [] (getBusinessHours dùng mặc định; testSaved trả `savedRow`). */
  function fakeDb(rows: unknown[] = []): Db {
    const chain = { from: () => chain, where: () => chain, limit: async () => rows };
    return { select: () => chain } as unknown as Db;
  }
  const replyLlm = (messages: string[]) => {
    const requests: LlmRequest[] = [];
    const llm: LlmClient = {
      async generate(req) {
        requests.push(req);
        return {
          functionCall: { name: 'reply', args: { messages, confidence: 0.9 } },
          text: null,
          usage: { inputTokens: 10, outputTokens: 5 },
          model: 'gemini-2.5-flash',
        };
      },
    };
    return { llm, requests };
  };

  it('bản nháp có notifyKeywords khớp ⇒ notifiedKeyword, bot VẪN trả lời (lời "đã báo nhân viên" không bị đổi)', async () => {
    const said = ['Dạ em đã báo nhân viên rồi ạ, bên em bảo hành 5 năm.'];
    const { llm, requests } = replyLlm(said);
    const service = new ChatbotTestService(fakeDb(), config, llm);
    const r = await service.testDraft('u-notify', { name: 'Nháp', notifyKeywords: ['bảo hành'] }, [
      { role: 'customer', text: 'Cho hỏi bảo hành bao lâu?' },
    ]);
    expect(requests).toHaveLength(1);
    expect(r).toMatchObject({ decision: 'reply', messages: said, notifiedKeyword: 'bảo hành' });
  });

  it('không khớp notifyKeywords ⇒ không có notifiedKeyword; bot đã lưu + draft ghi đè notifyKeywords', async () => {
    const { llm } = replyLlm(['Dạ']);
    const service = new ChatbotTestService(fakeDb(), config, llm);
    const plain = await service.testDraft('u-plain', { name: 'Nháp', notifyKeywords: ['đơn gấp'] }, [
      { role: 'customer', text: 'Chào' },
    ]);
    expect(plain).not.toHaveProperty('notifiedKeyword');
    const savedRow = {
      id: 'bot-1',
      name: 'Bot',
      instructions: '',
      knowledge: '',
      examples: [],
      handoffKeywords: [],
      notifyKeywords: ['đơn gấp'],
      handoffMessage: null,
      model: null,
      temperature: 0.3,
      escalateWhenUnsure: true,
      responseSpeed: 'fast',
    };
    const saved = new ChatbotTestService(fakeDb([savedRow]), config, replyLlm(['Dạ']).llm);
    const msgs = [{ role: 'customer' as const, text: 'đơn gấp nha' }];
    await expect(saved.testSaved('u-saved', 'bot-1', { messages: msgs })).resolves.toMatchObject({
      notifiedKeyword: 'đơn gấp',
    });
    const overridden = await saved.testSaved('u-saved', 'bot-1', {
      messages: msgs,
      draft: { notifyKeywords: [] },
    });
    expect(overridden).not.toHaveProperty('notifiedKeyword');
  });
});

describe('ChatbotModelsService', () => {
  it('chưa có key (không có hàm liệt kê) => chỉ GEMINI_MODEL', async () => {
    const service = new ChatbotModelsService(config, null);
    await expect(service.list()).resolves.toEqual({
      defaultModel: 'gemini-2.5-flash',
      models: ['gemini-2.5-flash'],
    });
  });
});
