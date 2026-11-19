import type { Db } from '@dezon/db';
import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config';
import { AI_OUTAGE_NOT_CONFIGURED_MESSAGE, AiOutageService, describeAiProbeError } from './ai-outage.service';

describe('AiOutageService.resume', () => {
  it('chưa có GEMINI_API_KEY (LLM_CLIENT null) ⇒ 503 trước mọi truy vấn', async () => {
    const service = new AiOutageService(
      null as unknown as Db,
      { now: () => new Date() } as never,
      null as never,
      { GEMINI_MODEL: 'gemini-2.5-flash' } as AppConfig,
      null,
    );
    const run = service.resume({ id: 'u1', email: 'a@b.c', name: 'A', role: 'agent' });
    await expect(run).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(run).rejects.toThrow(AI_OUTAGE_NOT_CONFIGURED_MESSAGE);
  });
});

describe('describeAiProbeError', () => {
  it.each([
    ['Gemini HTTP 402: Your prepayment credits are depleted.', 'hết hạn mức / chưa nạp tiền Gemini'],
    [
      'Gemini HTTP 429: Resource has been exhausted (e.g. check quota).',
      'hết hạn mức / chưa nạp tiền Gemini',
    ],
    ['Gemini HTTP 429: Too many requests', 'Gemini đang quá tải, thử lại sau ít phút'],
    ['Hết thời gian chờ AI (15000 ms)', 'Gemini phản hồi quá chậm (hết thời gian chờ)'],
    [
      'Gemini HTTP 400: API key not valid. Please pass a valid API key.',
      'khóa API Gemini không hợp lệ hoặc không đủ quyền',
    ],
    ['Gemini HTTP 503: The model is overloaded.', 'máy chủ Gemini đang lỗi'],
    ['Lỗi gọi Gemini: fetch failed', 'không kết nối được tới Gemini'],
    ['Gemini HTTP 404: models/abc is not found', 'không tìm thấy model Gemini đang cấu hình'],
  ])('%s', (error, expected) => {
    expect(describeAiProbeError(error)).toBe(expected);
  });

  it('lỗi lạ ⇒ giữ nguyên nhưng cắt ngắn', () => {
    expect(describeAiProbeError('lạ')).toBe('lạ');
    expect(describeAiProbeError('x'.repeat(500)).length).toBeLessThanOrEqual(160);
  });
});
