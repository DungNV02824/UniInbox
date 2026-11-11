import { describe, expect, it } from 'vitest';
import { handoffToastText, stripTitleCounter, titleWithCounter } from './realtime-handoff';

const payload = {
  conversationId: 'c-1',
  reasonCode: 'human_request' as const,
  summary: 'Khách muốn gọi điện tư vấn',
  contactName: 'Chị Lan',
  channelName: 'Dezon Nội Thất',
};

describe('bộ đếm tiêu đề tab', () => {
  it('thêm / thay / bỏ tiền tố "(n) "', () => {
    expect(titleWithCounter('Hộp thư · Dezon', 1)).toBe('(1) Hộp thư · Dezon');
    expect(titleWithCounter('(1) Hộp thư · Dezon', 3)).toBe('(3) Hộp thư · Dezon');
    expect(titleWithCounter('(3) Hộp thư · Dezon', 0)).toBe('Hộp thư · Dezon');
    expect(titleWithCounter('Hộp thư', 150)).toBe('(99+) Hộp thư');
    expect(stripTitleCounter('(99+) Hộp thư')).toBe('Hộp thư');
    // Không đụng vào dấu ngoặc là một phần của tiêu đề gốc.
    expect(stripTitleCounter('(Test) Hộp thư')).toBe('(Test) Hộp thư');
  });
});

describe('handoffToastText', () => {
  it('"Cần người: <khách> (<kênh>) — <lý do>" + tóm tắt', () => {
    expect(handoffToastText(payload)).toEqual({
      title: 'Cần người: Chị Lan (Dezon Nội Thất) — Khách muốn gặp nhân viên',
      description: 'Khách muốn gọi điện tư vấn',
      botContinues: false,
    });
  });

  it('chỉ báo (botContinues): "Khách cần nhân viên — bot vẫn đang trả lời", không phải "Cần người"', () => {
    const text = handoffToastText({ ...payload, botContinues: true });
    expect(text).toEqual({
      title: 'Khách cần nhân viên: Chị Lan (Dezon Nội Thất) — bot vẫn đang trả lời',
      description: 'Khách muốn gọi điện tư vấn',
      botContinues: true,
    });
    expect(text.title).not.toMatch(/Cần người/);
    expect(handoffToastText({ ...payload, botContinues: true, reminder: true }).title).toMatch(
      /^Nhắc lại · /,
    );
    expect(handoffToastText({ ...payload, botContinues: false }).botContinues).toBe(false);
  });

  it('sự kiện nhắc lại có tiền tố "Nhắc lại"', () => {
    expect(handoffToastText({ ...payload, reminder: true }).title).toBe(
      'Nhắc lại · Cần người: Chị Lan (Dezon Nội Thất) — Khách muốn gặp nhân viên',
    );
  });

  it('thiếu tên kênh thì bỏ ngoặc', () => {
    expect(handoffToastText({ ...payload, channelName: '' }).title).toBe(
      'Cần người: Chị Lan — Khách muốn gặp nhân viên',
    );
  });
});
