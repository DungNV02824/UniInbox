import { describe, expect, it } from 'vitest';
import {
  HANDOFF_REASON_CODES,
  HANDOFF_REASON_LABELS,
  REENGAGE_LIMITS,
  reengageStartSchema,
  base64DecodedBytes,
  businessHoursSchema,
  CHATBOT_LIMITS,
  chatbotTestSchema,
  createChatbotSchema,
  DEFAULT_BUSINESS_HOURS,
  setConversationChatbotSchema,
  updateChatbotSchema,
  updateChannelSchema,
  updateLarkSettingsSchema,
} from './index';

describe('chatbots schemas', () => {
  it('createChatbotSchema: chỉ cần tên, kiểm giới hạn', () => {
    expect(createChatbotSchema.parse({ name: ' Bot A ' }).name).toBe('Bot A');
    expect(createChatbotSchema.safeParse({ name: '' }).success).toBe(false);
    expect(createChatbotSchema.safeParse({ name: 'x'.repeat(101) }).success).toBe(false);
    expect(createChatbotSchema.safeParse({ name: 'a', temperature: 1.5 }).success).toBe(false);
    expect(createChatbotSchema.safeParse({ name: 'a', replyDelaySec: 121 }).success).toBe(false);
    expect(createChatbotSchema.safeParse({ name: 'a', maxWaitSec: 4 }).success).toBe(false);
    expect(createChatbotSchema.safeParse({ name: 'a', knowledge: 'x'.repeat(100_001) }).success).toBe(false);
    expect(createChatbotSchema.safeParse({ name: 'a', model: null }).success).toBe(true);
  });

  it('tên nút banner Cần người: trim, ≤ 40 ký tự, nhận null; handoffActionLark boolean', () => {
    const parsed = createChatbotSchema.parse({
      name: 'a',
      handoffAckLabel: '  Nghiệm thu ',
      handoffResolveLabel: null,
      handoffActionLark: true,
    });
    expect(parsed).toMatchObject({
      handoffAckLabel: 'Nghiệm thu',
      handoffResolveLabel: null,
      handoffActionLark: true,
    });
    expect(createChatbotSchema.parse({ name: 'a', handoffAckLabel: '   ' }).handoffAckLabel).toBe('');
    const max = CHATBOT_LIMITS.handoffButtonLabelMax;
    expect(createChatbotSchema.safeParse({ name: 'a', handoffAckLabel: 'x'.repeat(max) }).success).toBe(true);
    expect(
      createChatbotSchema.safeParse({ name: 'a', handoffResolveLabel: 'x'.repeat(max + 1) }).success,
    ).toBe(false);
    expect(createChatbotSchema.safeParse({ name: 'a', handoffActionLark: 'yes' }).success).toBe(false);
    expect(updateChatbotSchema.safeParse({ handoffResolveLabel: 'Đã chuyển tiền' }).success).toBe(true);
    expect(updateChatbotSchema.safeParse({ handoffActionLark: false }).success).toBe(true);
  });

  it('updateChatbotSchema: body rỗng bị từ chối', () => {
    expect(updateChatbotSchema.safeParse({}).success).toBe(false);
    expect(updateChatbotSchema.safeParse({ isActive: false }).success).toBe(true);
  });

  it('chatbotTestSchema: 1..30 tin, draft tùy chọn', () => {
    expect(chatbotTestSchema.safeParse({ messages: [] }).success).toBe(false);
    expect(
      chatbotTestSchema.safeParse({ messages: [{ role: 'customer', text: 'hi' }], draft: { knowledge: 'k' } })
        .success,
    ).toBe(true);
  });

  it('chatbotTestSchema: ảnh chỉ cho tin khách, tối đa 10 ảnh, mỗi ảnh ≤ 4 MB', () => {
    const img = { mimeType: 'image/jpeg' as const, data: Buffer.from('xin chao').toString('base64') };
    const parse = (messages: unknown[]) => chatbotTestSchema.safeParse({ messages });
    // Tin khách chỉ có ảnh (không chữ) hợp lệ; tin không chữ không ảnh thì không.
    expect(parse([{ role: 'customer', text: '', images: [img] }]).success).toBe(true);
    expect(parse([{ role: 'customer', text: '  ' }]).success).toBe(false);
    expect(parse([{ role: 'customer', text: '', images: [] }]).success).toBe(false);
    // Ảnh trên tin bot / nhân viên bị từ chối.
    expect(parse([{ role: 'bot', text: 'Dạ', images: [img] }]).success).toBe(false);
    expect(parse([{ role: 'agent', text: 'Dạ', images: [img] }]).success).toBe(false);
    // Mime / base64 sai.
    expect(
      parse([{ role: 'customer', text: 'a', images: [{ ...img, mimeType: 'image/heic' }] }]).success,
    ).toBe(false);
    // GIF (ảnh động) không nhận cho Chat thử (core coi là định dạng không hỗ trợ).
    expect(
      parse([{ role: 'customer', text: 'a', images: [{ ...img, mimeType: 'image/gif' }] }]).success,
    ).toBe(false);
    // Lượt cũ chỉ báo số ảnh (imageCount), chữ rỗng: hợp lệ.
    expect(
      parse([
        { role: 'customer', text: '', imageCount: 5 },
        { role: 'bot', text: 'Dạ' },
      ]).success,
    ).toBe(true);
    expect(
      parse([{ role: 'customer', text: 'a', images: [{ ...img, data: 'data:image/jpeg;base64,AAAA' }] }])
        .success,
    ).toBe(false);
    // Tối đa 10 ảnh mỗi tin và tổng cả lần gọi.
    const ten = Array.from({ length: CHATBOT_LIMITS.testImagesMax }, () => img);
    expect(parse([{ role: 'customer', text: '', images: ten }]).success).toBe(true);
    expect(parse([{ role: 'customer', text: '', images: [...ten, img] }]).success).toBe(false);
    expect(
      parse([
        { role: 'customer', text: '', images: ten.slice(0, 6) },
        { role: 'customer', text: '', images: ten.slice(0, 5) },
      ]).success,
    ).toBe(false);
    // 4 MB đúng ngưỡng nhận, hơn 1 byte thì không.
    const max = CHATBOT_LIMITS.testImageMaxBytes;
    const atMax = Buffer.alloc(max, 7).toString('base64');
    expect(base64DecodedBytes(atMax)).toBe(max);
    expect(parse([{ role: 'customer', text: '', images: [{ ...img, data: atMax }] }]).success).toBe(true);
    const over = Buffer.alloc(max + 1, 7).toString('base64');
    expect(parse([{ role: 'customer', text: '', images: [{ ...img, data: over }] }]).success).toBe(false);
  });

  it('base64DecodedBytes khớp Buffer', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 100]) {
      expect(base64DecodedBytes(Buffer.alloc(n, 1).toString('base64'))).toBe(n);
    }
  });

  it('setConversationChatbotSchema nhận uuid hoặc null', () => {
    expect(setConversationChatbotSchema.safeParse({ chatbotId: null }).success).toBe(true);
    expect(setConversationChatbotSchema.safeParse({ chatbotId: 'abc' }).success).toBe(false);
  });

  it('businessHoursSchema: start < end, ≤ 4 khung, múi giờ hợp lệ', () => {
    expect(businessHoursSchema.safeParse(DEFAULT_BUSINESS_HOURS).success).toBe(true);
    const bad = structuredClone(DEFAULT_BUSINESS_HOURS);
    bad.days.mon = [{ start: '18:00', end: '08:00' }];
    expect(businessHoursSchema.safeParse(bad).success).toBe(false);
    const many = structuredClone(DEFAULT_BUSINESS_HOURS);
    many.days.tue = Array.from({ length: 5 }, () => ({ start: '08:00', end: '09:00' }));
    expect(businessHoursSchema.safeParse(many).success).toBe(false);
    expect(businessHoursSchema.safeParse({ ...DEFAULT_BUSINESS_HOURS, timezone: 'Mars/Base' }).success).toBe(
      false,
    );
  });

  it('businessHoursSchema: "24:00" chỉ hợp lệ ở giờ kết thúc', () => {
    const allDay = structuredClone(DEFAULT_BUSINESS_HOURS);
    allDay.days.sat = [{ start: '00:00', end: '24:00' }];
    expect(businessHoursSchema.safeParse(allDay).success).toBe(true);
    const badStart = structuredClone(DEFAULT_BUSINESS_HOURS);
    badStart.days.sat = [{ start: '24:00', end: '24:00' }];
    expect(businessHoursSchema.safeParse(badStart).success).toBe(false);
    const badEnd = structuredClone(DEFAULT_BUSINESS_HOURS);
    badEnd.days.sat = [{ start: '08:00', end: '24:30' }];
    expect(businessHoursSchema.safeParse(badEnd).success).toBe(false);
  });

  it('updateLarkSettingsSchema: chỉ https hoặc null', () => {
    expect(updateLarkSettingsSchema.safeParse({ webhookUrl: null }).success).toBe(true);
    expect(
      updateLarkSettingsSchema.safeParse({ webhookUrl: 'https://open.larksuite.com/hook/x' }).success,
    ).toBe(true);
    expect(updateLarkSettingsSchema.safeParse({ webhookUrl: 'http://x.com/hook' }).success).toBe(false);
  });

  it('updateChannelSchema nhận defaultChatbotId', () => {
    expect(updateChannelSchema.safeParse({ defaultChatbotId: null }).success).toBe(true);
  });

  it('mọi mã lý do có nhãn tiếng Việt', () => {
    for (const code of HANDOFF_REASON_CODES) expect(HANDOFF_REASON_LABELS[code]).toBeTruthy();
  });
});

describe('reengageStartSchema — chỉ dẫn gõ tay', () => {
  const base = { days: 15, conversationIds: ['3f0c8a52-7f3e-4d3e-9b55-0c4b1a2d3e4f'] };

  it('trim; ô trống / chỉ khoảng trắng ⇒ bỏ (undefined); không gửi cũng hợp lệ', () => {
    const empty = reengageStartSchema.parse(base);
    expect(empty.rules).toBeUndefined();
    expect(empty.content).toBeUndefined();
    const parsed = reengageStartSchema.parse({ ...base, rules: '  Xưng em  ', content: '   ' });
    expect(parsed.rules).toBe('Xưng em');
    expect(parsed.content).toBeUndefined();
  });

  it(`quá ${REENGAGE_LIMITS.guidanceMaxChars} ký tự ⇒ lỗi`, () => {
    const long = 'a'.repeat(REENGAGE_LIMITS.guidanceMaxChars + 1);
    expect(reengageStartSchema.safeParse({ ...base, content: long }).success).toBe(false);
    expect(
      reengageStartSchema.safeParse({ ...base, rules: 'a'.repeat(REENGAGE_LIMITS.guidanceMaxChars) }).success,
    ).toBe(true);
    // Đếm theo ký tự như bộ đếm ở web: emoji (2 đơn vị UTF-16) vẫn là 1 ký tự.
    const emoji = '😀'.repeat(REENGAGE_LIMITS.guidanceMaxChars);
    expect(reengageStartSchema.safeParse({ ...base, rules: emoji }).success).toBe(true);
    expect(reengageStartSchema.safeParse({ ...base, rules: `${emoji}😀` }).success).toBe(false);
  });
});
