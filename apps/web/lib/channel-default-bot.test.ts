import type { ApplyDefaultChatbotPreview } from '@dezon/shared';
import { describe, expect, it } from 'vitest';
import {
  APPLY_SAFETY_NOTE,
  applyButtonLabel,
  applyPromptText,
  applyResultToast,
  applySkippedText,
  defaultBotChangedToast,
  shouldOfferApply,
} from './channel-default-bot';

const preview = (p: Partial<ApplyDefaultChatbotPreview> = {}): ApplyDefaultChatbotPreview => ({
  chatbotId: 'bot-1',
  eligible: 3,
  alreadyUsing: 2,
  skippedPendingHuman: 0,
  skippedNoBot: 0,
  ...p,
});

describe('shouldOfferApply', () => {
  it('chỉ hỏi khi còn hội thoại dùng bot khác', () => {
    expect(shouldOfferApply(preview())).toBe(true);
    expect(shouldOfferApply(preview({ eligible: 0 }))).toBe(false);
    expect(shouldOfferApply(preview({ chatbotId: null }))).toBe(false);
    expect(shouldOfferApply(null)).toBe(false);
    expect(shouldOfferApply(undefined)).toBe(false);
  });
});

describe('defaultBotChangedToast', () => {
  it('đổi sang bot, không hỏi tiếp: báo hội thoại cũ không đổi', () => {
    expect(defaultBotChangedToast('Xây Dựng', 'Bot A', 'bot-1')).toEqual({
      title: 'Hội thoại mới của "Xây Dựng" sẽ dùng "Bot A"',
      description: 'Hội thoại cũ không đổi — bật/tắt bot từng hội thoại trong hộp thư.',
    });
  });
  it('sắp mở hộp thoại hỏi: không nói "Hội thoại cũ không đổi"', () => {
    const t = defaultBotChangedToast('Xây Dựng', 'Bot A', 'bot-1', true);
    expect(t.title).toBe('Hội thoại mới của "Xây Dựng" sẽ dùng "Bot A"');
    expect(t.description).toBeUndefined();
  });
  it('thiếu tên bot => "bot"', () => {
    expect(defaultBotChangedToast('X', undefined, 'bot-1').title).toBe('Hội thoại mới của "X" sẽ dùng "bot"');
  });
  it('bỏ chatbot mặc định', () => {
    expect(defaultBotChangedToast('X', null, null).title).toBe('Đã bỏ chatbot mặc định');
  });
});

describe('applyPromptText / applyButtonLabel', () => {
  it('ghép tên kênh, số hội thoại, tên bot', () => {
    expect(applyPromptText('Xây Dựng', 'Bot A', 1234)).toBe(
      'Trang "Xây Dựng" đang có 1.234 hội thoại dùng chatbot khác. Đổi các hội thoại này sang "Bot A"?',
    );
    expect(applyButtonLabel(5)).toBe('Áp dụng cho 5 hội thoại');
  });
});

describe('applySkippedText', () => {
  it('cả hai phần', () => {
    expect(applySkippedText({ skippedPendingHuman: 2, skippedNoBot: 7 })).toBe(
      '2 hội thoại đang Cần người và 7 hội thoại chưa gắn bot sẽ giữ nguyên.',
    );
  });
  it('bỏ phần bằng 0', () => {
    expect(applySkippedText({ skippedPendingHuman: 0, skippedNoBot: 7 })).toBe(
      '7 hội thoại chưa gắn bot sẽ giữ nguyên.',
    );
    expect(applySkippedText({ skippedPendingHuman: 1, skippedNoBot: 0 })).toBe(
      '1 hội thoại đang Cần người sẽ giữ nguyên.',
    );
  });
  it('không bỏ qua gì => null', () => {
    expect(applySkippedText({ skippedPendingHuman: 0, skippedNoBot: 0 })).toBeNull();
  });
  it('có ghi chú an toàn', () => {
    expect(APPLY_SAFETY_NOTE).toBe('Bot đang tắt ở hội thoại nào vẫn giữ tắt. Không gửi tin nào cho khách.');
  });
});

describe('applyResultToast', () => {
  it('không bỏ qua', () => {
    expect(applyResultToast({ updated: 3, skippedPendingHuman: 0 }, 'Bot A')).toEqual({
      title: 'Đã đổi 3 hội thoại sang "Bot A"',
    });
  });
  it('có hội thoại Cần người bị bỏ qua (vd. khách vừa chuyển sang Cần người)', () => {
    expect(applyResultToast({ updated: 2, skippedPendingHuman: 1 }, 'Bot A')).toEqual({
      title: 'Đã đổi 2 hội thoại sang "Bot A"',
      description: '1 hội thoại đang Cần người được giữ nguyên.',
    });
  });
});
