import type { ChatbotDto } from '@dezon/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import {
  addKeywords,
  apiErrorToForm,
  chatbotToForm,
  duplicateName,
  duplicateRequest,
  emptyChatbotForm,
  FAST_REPLY_TIP,
  formToRequest,
  hasKeyword,
  isFastReplySetup,
  slowReplyWarning,
  isFormDirty,
  keywordOverlap,
  moveItem,
  NAME_CONFLICT_MESSAGE,
  normalizeAgentReplyMode,
  normalizeAiHandoffMode,
  normalizeResponseSpeed,
  overlapMessage,
  tabsWithErrors,
  templateNeedsConfirm,
  toggleHandoffReminder,
  usageText,
  validateChatbotForm,
  type ChatbotFormValues,
} from './chatbot-form';

const dto: ChatbotDto = {
  id: 'b1',
  name: 'Tư vấn nhà phố',
  description: null,
  isActive: true,
  instructions: 'Xưng em, gọi anh/chị.',
  knowledge: 'Giá thiết kế: 150.000đ/m2',
  examples: [{ customer: 'Giá bao nhiêu?', reply: 'Dạ 150.000đ/m2 ạ.' }],
  handoffKeywords: ['giảm giá'],
  notifyKeywords: ['gửi công trình'],
  handoffMessage: null,
  escalateWhenUnsure: false,
  responseSpeed: 'fast',
  handoffAckLabel: null,
  handoffResolveLabel: null,
  handoffActionLark: false,
  handoffAckMessage: null,
  handoffResolveMessage: null,
  aiHandoffMode: 'stop',
  agentReplyMode: 'pause',
  agentPauseMinutes: null,
  handoffReminderMin: 0,
  model: null,
  temperature: 0.4,
  replyDelaySec: 10,
  maxWaitSec: 45,
  maxRepliesPerHour: 20,
  conversationCount: 3,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

function form(patch: Partial<ChatbotFormValues> = {}): ChatbotFormValues {
  return { ...chatbotToForm(dto), ...patch };
}

describe('chatbotToForm / formToRequest', () => {
  it('khứ hồi DTO → form → body giữ nguyên dữ liệu, null ↔ chuỗi rỗng', () => {
    const f = chatbotToForm(dto);
    expect(f.description).toBe('');
    expect(f.model).toBe('');
    expect(f.replyDelaySec).toBe('10');
    expect(formToRequest(f)).toEqual({
      name: 'Tư vấn nhà phố',
      description: null,
      isActive: true,
      instructions: 'Xưng em, gọi anh/chị.',
      knowledge: 'Giá thiết kế: 150.000đ/m2',
      examples: [{ customer: 'Giá bao nhiêu?', reply: 'Dạ 150.000đ/m2 ạ.' }],
      handoffKeywords: ['giảm giá'],
      notifyKeywords: ['gửi công trình'],
      handoffMessage: null,
      escalateWhenUnsure: false,
      handoffAckLabel: null,
      handoffResolveLabel: null,
      handoffActionLark: false,
      handoffAckMessage: null,
      handoffResolveMessage: null,
      responseSpeed: 'fast',
      aiHandoffMode: 'stop',
      agentReplyMode: 'pause',
      agentPauseMinutes: null,
      handoffReminderMin: 0,
      model: null,
      temperature: 0.4,
      replyDelaySec: 10,
      maxWaitSec: 45,
      maxRepliesPerHour: 20,
    });
  });

  it('trim tên/mô tả/tin giữ chỗ, bỏ cặp mẫu trống cả hai ô, ô số rỗng => NaN', () => {
    const body = formToRequest(
      form({
        name: '  Bot A ',
        description: '  ',
        handoffMessage: ' Dạ chờ em chút ạ ',
        model: 'gemini-2.5-pro',
        examples: [
          { key: 'a', customer: '  ', reply: '' },
          { key: 'b', customer: ' Hỏi ', reply: ' Đáp ' },
        ],
        replyDelaySec: '',
      }),
    );
    expect(body.name).toBe('Bot A');
    expect(body.description).toBeNull();
    expect(body.handoffMessage).toBe('Dạ chờ em chút ạ');
    expect(body.model).toBe('gemini-2.5-pro');
    expect(body.examples).toEqual([{ customer: 'Hỏi', reply: 'Đáp' }]);
    expect(Number.isNaN(body.replyDelaySec)).toBe(true);
  });

  it('form mới trung tính: không hướng dẫn/kiến thức/từ khóa sẵn, mặc định chuyển người khi không chắc', () => {
    const f = emptyChatbotForm();
    expect(f.instructions).toBe('');
    expect(f.knowledge).toBe('');
    expect(f.examples).toEqual([]);
    expect(f.handoffKeywords).toEqual([]);
    expect(f.escalateWhenUnsure).toBe(true);
    expect(f.temperature).toBe(0.4);
    expect(f.maxWaitSec).toBe('45');
    expect(formToRequest(f).escalateWhenUnsure).toBe(true);
  });

  it('escalateWhenUnsure đi qua form ↔ body (gồm cả bản nháp gửi chat thử)', () => {
    expect(chatbotToForm(dto).escalateWhenUnsure).toBe(false);
    expect(chatbotToForm({ ...dto, escalateWhenUnsure: true }).escalateWhenUnsure).toBe(true);
    const res = validateChatbotForm(form({ escalateWhenUnsure: true }));
    expect(res.ok && res.data.escalateWhenUnsure).toBe(true);
  });

  it('tên nút Cần người + Lark: rỗng ⇔ null (mặc định), trim, đi qua form ↔ body', () => {
    const empty = emptyChatbotForm();
    expect(empty.handoffAckLabel).toBe('');
    expect(empty.handoffResolveLabel).toBe('');
    expect(empty.handoffActionLark).toBe(false);
    expect(formToRequest(empty)).toMatchObject({
      handoffAckLabel: null,
      handoffResolveLabel: null,
      handoffActionLark: false,
    });

    const custom = {
      ...dto,
      handoffAckLabel: 'Nghiệm thu',
      handoffResolveLabel: 'Đã chuyển tiền',
      handoffActionLark: true,
    };
    const f = chatbotToForm(custom);
    expect(f.handoffAckLabel).toBe('Nghiệm thu');
    expect(f.handoffResolveLabel).toBe('Đã chuyển tiền');
    expect(f.handoffActionLark).toBe(true);
    expect(
      formToRequest({ ...f, handoffAckLabel: '  Nghiệm thu ', handoffResolveLabel: '   ' }),
    ).toMatchObject({
      handoffAckLabel: 'Nghiệm thu',
      handoffResolveLabel: null,
      handoffActionLark: true,
    });
    expect(duplicateRequest(custom, [])).toMatchObject({
      handoffAckLabel: 'Nghiệm thu',
      handoffResolveLabel: 'Đã chuyển tiền',
      handoffActionLark: true,
    });
    expect(isFormDirty({ ...f, handoffActionLark: false }, chatbotToForm(custom))).toBe(true);
  });

  it('tên nút Cần người quá 40 ký tự ⇒ lỗi đúng ô, đánh dấu tab Chuyển người', () => {
    const res = validateChatbotForm(form({ handoffAckLabel: 'x'.repeat(41) }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.handoffAckLabel).toBe('Tên nút tối đa 40 ký tự');
    expect(tabsWithErrors(res.errors).has('handoff')).toBe(true);
    expect(validateChatbotForm(form({ handoffResolveLabel: 'x'.repeat(40) })).ok).toBe(true);
  });

  it('responseSpeed: mặc định Nhanh nhất, đi qua form ↔ body (gồm bản nháp chat thử)', () => {
    expect(emptyChatbotForm().responseSpeed).toBe('fast');
    expect(formToRequest(emptyChatbotForm()).responseSpeed).toBe('fast');
    expect(chatbotToForm({ ...dto, responseSpeed: 'thorough' }).responseSpeed).toBe('thorough');
    const res = validateChatbotForm(form({ responseSpeed: 'balanced' }));
    expect(res.ok && res.data.responseSpeed).toBe('balanced');
  });

  it('responseSpeed lạ/thiếu từ API => mặc định fast; lỗi ô thuộc tab Nâng cao', () => {
    expect(normalizeResponseSpeed(undefined)).toBe('fast');
    expect(normalizeResponseSpeed('turbo')).toBe('fast');
    expect(normalizeResponseSpeed('balanced')).toBe('balanced');
    const legacy = { ...dto } as Partial<ChatbotDto>;
    delete legacy.responseSpeed;
    expect(chatbotToForm(legacy as ChatbotDto).responseSpeed).toBe('fast');
    expect(tabsWithErrors({ responseSpeed: 'x' })).toEqual(new Set(['advanced']));
    const bad = validateChatbotForm(form({ responseSpeed: 'turbo' as never }));
    expect(!bad.ok && bad.errors.responseSpeed).toBe('Chọn một tốc độ trả lời');
  });

  it('isFastReplySetup: độ trễ 0–1 giây + Nhanh nhất', () => {
    expect(FAST_REPLY_TIP).toMatch(/dưới 4 giây/);
    expect(FAST_REPLY_TIP).toMatch(/0–1 giây/);
    expect(isFastReplySetup({ replyDelaySec: '1', responseSpeed: 'fast' })).toBe(true);
    expect(isFastReplySetup({ replyDelaySec: '0', responseSpeed: 'fast' })).toBe(true);
    expect(isFastReplySetup({ replyDelaySec: '0.5', responseSpeed: 'fast' })).toBe(true);
    expect(isFastReplySetup({ replyDelaySec: '2', responseSpeed: 'fast' })).toBe(false);
    expect(isFastReplySetup({ replyDelaySec: '3', responseSpeed: 'fast' })).toBe(false);
    expect(isFastReplySetup({ replyDelaySec: '1', responseSpeed: 'balanced' })).toBe(false);
    expect(isFastReplySetup({ replyDelaySec: '', responseSpeed: 'fast' })).toBe(false);
  });

  it('slowReplyWarning: cảnh báo khi độ trễ ≥ 2 giây', () => {
    expect(slowReplyWarning({ replyDelaySec: '0' })).toBeNull();
    expect(slowReplyWarning({ replyDelaySec: '1' })).toBeNull();
    expect(slowReplyWarning({ replyDelaySec: '' })).toBeNull();
    expect(slowReplyWarning({ replyDelaySec: 'abc' })).toBeNull();
    expect(slowReplyWarning({ replyDelaySec: '2' })).toBe(
      'Đang đặt 2 giây: khách sẽ chờ khoảng 4 giây trở lên mới thấy bot trả lời.',
    );
    expect(slowReplyWarning({ replyDelaySec: '10' })).toMatch(/khoảng 12 giây/);
  });
});

describe('từ khóa "bot VẪN trả lời" + phối hợp nhân viên', () => {
  it('form mới: không từ khóa báo, khi nhân viên nhắn = tạm nghỉ (mặc định hệ thống), tắt nhắc lại', () => {
    const f = emptyChatbotForm();
    expect(f.notifyKeywords).toEqual([]);
    expect(f.agentReplyMode).toBe('pause');
    expect(f.agentPauseMinutes).toBe('');
    expect(f.handoffReminderEnabled).toBe(false);
    expect(formToRequest(f)).toMatchObject({
      notifyKeywords: [],
      agentReplyMode: 'pause',
      agentPauseMinutes: null,
      handoffReminderMin: 0,
    });
  });

  it('DTO → form → body giữ 4 trường mới (gồm bản nháp chat thử)', () => {
    const custom: ChatbotDto = {
      ...dto,
      notifyKeywords: ['nghiệm thu', 'gửi công trình'],
      agentReplyMode: 'pause',
      agentPauseMinutes: 45,
      handoffReminderMin: 20,
    };
    const f = chatbotToForm(custom);
    expect(f).toMatchObject({
      notifyKeywords: ['nghiệm thu', 'gửi công trình'],
      agentPauseMinutes: '45',
      handoffReminderEnabled: true,
      handoffReminderMin: '20',
    });
    const res = validateChatbotForm(f);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({
      notifyKeywords: ['nghiệm thu', 'gửi công trình'],
      agentReplyMode: 'pause',
      agentPauseMinutes: 45,
      handoffReminderMin: 20,
    });
    expect(duplicateRequest(custom, [])).toMatchObject({
      notifyKeywords: ['nghiệm thu', 'gửi công trình'],
      agentPauseMinutes: 45,
      handoffReminderMin: 20,
    });
    expect(chatbotToForm({ ...custom, agentReplyMode: 'stop' }).agentReplyMode).toBe('stop');
  });

  it('API cũ thiếu trường ⇒ mặc định (không từ khóa báo, pause, tắt nhắc lại)', () => {
    const legacy = { ...dto } as Partial<ChatbotDto>;
    delete legacy.notifyKeywords;
    delete legacy.agentReplyMode;
    delete legacy.agentPauseMinutes;
    delete legacy.handoffReminderMin;
    const f = chatbotToForm(legacy as ChatbotDto);
    expect(f.notifyKeywords).toEqual([]);
    expect(f.agentReplyMode).toBe('pause');
    expect(f.agentPauseMinutes).toBe('');
    expect(f.handoffReminderEnabled).toBe(false);
    expect(normalizeAgentReplyMode('xyz')).toBe('pause');
  });

  it('từ khóa nằm ở cả hai danh sách (so không dấu, đ→d) ⇒ lỗi tiếng Việt ở tab Chuyển người', () => {
    expect(keywordOverlap(['Đổi trả', 'giảm giá'], ['doi tra', 'nghiệm thu', 'GIAM GIA'])).toEqual([
      'doi tra',
      'GIAM GIA',
    ]);
    const res = validateChatbotForm(
      form({ handoffKeywords: ['Nghiệm thu'], notifyKeywords: ['x', 'nghiem thu'] }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.notifyKeywords).toBe(overlapMessage(['nghiem thu']));
    expect(res.errors.notifyKeywords).toMatch(/“nghiem thu” đã có ở danh sách “Báo nhân viên \+ DỪNG bot”/);
    expect(res.errors['notifyKeywords.1']).toBeDefined();
    expect(res.errors['notifyKeywords.0']).toBeUndefined();
    expect(tabsWithErrors(res.errors)).toEqual(new Set(['handoff']));
    expect(overlapMessage(['a', 'b'])).toMatch(/^Các từ khóa “a”, “b”/);
  });

  it('thời gian tạm nghỉ: trống = null, 1–1440, ô ẩn (không phải pause) không chặn lưu', () => {
    expect(formToRequest(form({ agentPauseMinutes: ' ' })).agentPauseMinutes).toBeNull();
    expect(validateChatbotForm(form({ agentPauseMinutes: '1440' })).ok).toBe(true);
    for (const bad of ['0', '1441', '2.5', 'abc']) {
      const res = validateChatbotForm(form({ agentPauseMinutes: bad }));
      expect(!res.ok && res.errors.agentPauseMinutes).toMatch(/1 đến 1\.440 phút/);
      if (!res.ok) expect(tabsWithErrors(res.errors)).toEqual(new Set(['staff']));
    }
    // Đổi sang 'stop' mà ô (đang ẩn) còn số sai ⇒ gửi null thay vì báo lỗi ô ẩn; số hợp lệ thì giữ.
    const hidden = validateChatbotForm(form({ agentReplyMode: 'stop', agentPauseMinutes: '0' }));
    expect(hidden.ok && hidden.data.agentPauseMinutes).toBeNull();
    expect(
      formToRequest(form({ agentReplyMode: 'continue', agentPauseMinutes: '10' })).agentPauseMinutes,
    ).toBe(10);
  });

  it('nhắc lại chưa ai nhận: tắt = 0; bật điền sẵn 15; bật phải 1–1440', () => {
    expect(toggleHandoffReminder({ handoffReminderMin: '' }, true)).toEqual({
      handoffReminderEnabled: true,
      handoffReminderMin: '15',
    });
    expect(toggleHandoffReminder({ handoffReminderMin: '40' }, true).handoffReminderMin).toBe('40');
    expect(toggleHandoffReminder({ handoffReminderMin: '40' }, false).handoffReminderEnabled).toBe(false);

    const on = form({ handoffReminderEnabled: true, handoffReminderMin: '15' });
    expect(formToRequest(on).handoffReminderMin).toBe(15);
    expect(formToRequest({ ...on, handoffReminderEnabled: false }).handoffReminderMin).toBe(0);
    for (const bad of ['0', '', '1441', '1,5']) {
      const res = validateChatbotForm({ ...on, handoffReminderMin: bad });
      expect(!res.ok && res.errors.handoffReminderMin).toBe('Nhập số nguyên từ 1 đến 1.440 phút');
    }
    // Tắt thì số phút (không gửi đi) không chặn lưu.
    expect(validateChatbotForm({ ...on, handoffReminderEnabled: false, handoffReminderMin: 'abc' }).ok).toBe(
      true,
    );
  });

  it('isFormDirty nhận ra 4 trường mới; số phút nhắc lại khi đang tắt không tính', () => {
    const base = chatbotToForm(dto);
    expect(isFormDirty({ ...base, notifyKeywords: [] }, base)).toBe(true);
    expect(isFormDirty({ ...base, agentReplyMode: 'continue' }, base)).toBe(true);
    expect(isFormDirty({ ...base, agentPauseMinutes: '10' }, base)).toBe(true);
    expect(isFormDirty({ ...base, ...toggleHandoffReminder(base, true) }, base)).toBe(true);
    expect(isFormDirty({ ...base, handoffReminderMin: '99' }, base)).toBe(false);
  });

  it('tin gửi khách khi bấm nút: rỗng ⇔ null, trim, giới hạn ký tự, đi qua form ↔ body', () => {
    const empty = emptyChatbotForm();
    expect(empty.handoffAckMessage).toBe('');
    expect(formToRequest(empty)).toMatchObject({ handoffAckMessage: null, handoffResolveMessage: null });
    const custom: ChatbotDto = {
      ...dto,
      handoffAckMessage: 'Công trình của {ten_khach} đã được nghiệm thu ạ.',
      handoffResolveMessage: 'Dezon đã chuyển tiền cho {ten_khach} ạ.',
    };
    const f = chatbotToForm(custom);
    expect(f.handoffAckMessage).toBe('Công trình của {ten_khach} đã được nghiệm thu ạ.');
    expect(formToRequest({ ...f, handoffResolveMessage: '   ' })).toMatchObject({
      handoffAckMessage: 'Công trình của {ten_khach} đã được nghiệm thu ạ.',
      handoffResolveMessage: null,
    });
    expect(formToRequest({ ...f, handoffAckMessage: '  Xong ạ  ' }).handoffAckMessage).toBe('Xong ạ');
    expect(duplicateRequest(custom, [])).toMatchObject({
      handoffAckMessage: custom.handoffAckMessage,
      handoffResolveMessage: custom.handoffResolveMessage,
    });
    expect(isFormDirty({ ...f, handoffAckMessage: '' }, chatbotToForm(custom))).toBe(true);
    const bad = validateChatbotForm(form({ handoffResolveMessage: 'x'.repeat(1001) }));
    expect(!bad.ok && bad.errors.handoffResolveMessage).toBe('Tin gửi khách tối đa 1.000 ký tự');
    if (!bad.ok) expect(tabsWithErrors(bad.errors)).toEqual(new Set(['handoff']));
  });
});

describe('"Khi AI tự chuyển người thật" (aiHandoffMode)', () => {
  it("form mới mặc định 'stop'", () => {
    expect(emptyChatbotForm().aiHandoffMode).toBe('stop');
    expect(formToRequest(emptyChatbotForm()).aiHandoffMode).toBe('stop');
  });

  it("DTO 'continue' → form → body (gồm bản nháp chat thử) và bản sao giữ nguyên", () => {
    const custom: ChatbotDto = { ...dto, aiHandoffMode: 'continue' };
    const f = chatbotToForm(custom);
    expect(f.aiHandoffMode).toBe('continue');
    const res = validateChatbotForm(f);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.aiHandoffMode).toBe('continue');
    expect(duplicateRequest(custom, []).aiHandoffMode).toBe('continue');
    expect(duplicateRequest(dto, []).aiHandoffMode).toBe('stop');
  });

  it("API cũ thiếu trường / giá trị lạ ⇒ 'stop'", () => {
    const legacy = { ...dto } as Partial<ChatbotDto>;
    delete legacy.aiHandoffMode;
    expect(chatbotToForm(legacy as ChatbotDto).aiHandoffMode).toBe('stop');
    expect(duplicateRequest(legacy as ChatbotDto, []).aiHandoffMode).toBe('stop');
    expect(normalizeAiHandoffMode('xyz')).toBe('stop');
    expect(normalizeAiHandoffMode(undefined)).toBe('stop');
    expect(normalizeAiHandoffMode('continue')).toBe('continue');
  });

  it('isFormDirty nhận ra đổi chế độ; lỗi ô thuộc tab Phối hợp nhân viên', () => {
    const baseline = form();
    expect(isFormDirty(form(), baseline)).toBe(false);
    expect(isFormDirty(form({ aiHandoffMode: 'continue' }), baseline)).toBe(true);
    expect(tabsWithErrors({ aiHandoffMode: 'x' })).toEqual(new Set(['staff']));
    const bad = validateChatbotForm(form({ aiHandoffMode: 'xyz' as never }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.aiHandoffMode).toBe('Chọn cách bot xử lý khi AI tự chuyển người thật');
  });
});

describe('validateChatbotForm', () => {
  it('form hợp lệ trả body đã parse', () => {
    const res = validateChatbotForm(form());
    expect(res.ok).toBe(true);
  });

  it('báo lỗi tiếng Việt theo ô, chỉ số mẫu theo dòng gốc của form', () => {
    const res = validateChatbotForm(
      form({
        name: ' ',
        examples: [
          { key: 'a', customer: '', reply: '' },
          { key: 'b', customer: 'Hỏi', reply: '' },
        ],
        replyDelaySec: 'abc',
        maxRepliesPerHour: '0',
        temperature: 1.5,
      }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.name).toBe('Tên chatbot không được để trống');
    expect(res.errors['examples.1.reply']).toBe('Nhập câu bot trả lời');
    expect(res.errors.replyDelaySec).toMatch(/0 đến 120/);
    expect(res.errors.maxRepliesPerHour).toMatch(/1 đến 200/);
    expect(res.errors.temperature).toMatch(/0 đến 1/);
    expect([...tabsWithErrors(res.errors)].sort()).toEqual(['advanced', 'examples']);
  });

  it('chờ tối đa phải ≥ độ trễ gom tin', () => {
    const res = validateChatbotForm(form({ replyDelaySec: '60', maxWaitSec: '30' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.maxWaitSec).toMatch(/lớn hơn hoặc bằng/);
  });

  it('kiến thức quá 100.000 ký tự', () => {
    const res = validateChatbotForm(form({ knowledge: 'a'.repeat(100_001) }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.knowledge).toMatch(/100\.000/);
  });
});

describe('apiErrorToForm', () => {
  it('409 => lỗi trùng tên ở ô tên', () => {
    expect(apiErrorToForm(new ApiError(409, 'Conflict'))).toEqual({
      errors: { name: NAME_CONFLICT_MESSAGE },
      message: null,
    });
  });

  it('400 có errors[] => lỗi từng ô (đổi chỉ số mẫu về dòng form)', () => {
    const f = form({
      examples: [
        { key: 'a', customer: '', reply: '' },
        { key: 'b', customer: 'x', reply: 'y' },
      ],
    });
    const err = new ApiError(400, 'Dữ liệu không hợp lệ', {
      message: 'Dữ liệu không hợp lệ',
      errors: [
        { path: 'examples.0.customer', message: 'Too big' },
        { path: 'maxWaitSec', message: 'Too small' },
      ],
    });
    const out = apiErrorToForm(err, f);
    expect(out.message).toBeNull();
    expect(Object.keys(out.errors).sort()).toEqual(['examples.1.customer', 'maxWaitSec']);
  });

  it('lỗi khác => thông báo chung', () => {
    expect(apiErrorToForm(new ApiError(500, 'Máy chủ lỗi')).message).toBe('Máy chủ lỗi');
    expect(apiErrorToForm(new Error('x')).message).toMatch(/Không lưu được/);
  });
});

describe('isFormDirty', () => {
  it('bỏ qua khóa dòng, nhận ra thay đổi nội dung', () => {
    const a = chatbotToForm(dto);
    const b = chatbotToForm(dto); // khóa dòng khác
    expect(isFormDirty(a, b)).toBe(false);
    expect(isFormDirty({ ...a, knowledge: a.knowledge + '!' }, b)).toBe(true);
    expect(isFormDirty({ ...a, escalateWhenUnsure: !a.escalateWhenUnsure }, b)).toBe(true);
    expect(isFormDirty({ ...a, responseSpeed: 'thorough' }, b)).toBe(true);
  });
});

describe('từ khóa', () => {
  it('tách theo dấu phẩy/xuống dòng, bỏ trùng không dấu/không phân biệt hoa thường', () => {
    expect(addKeywords(['giảm giá'], 'Giam gia, khiếu nại\n  gặp   nhân viên ,,')).toEqual([
      'giảm giá',
      'khiếu nại',
      'gặp nhân viên',
    ]);
    expect(addKeywords([], 'Đổi trả, doi tra')).toEqual(['Đổi trả']);
    expect(hasKeyword(['Hoàn tiền'], 'hoan tien')).toBe(true);
  });

  it('cắt từ khóa dài và giới hạn số lượng', () => {
    expect(addKeywords([], 'a'.repeat(80))[0]).toHaveLength(50);
    const many = Array.from({ length: 100 }, (_, i) => `k${i}`);
    expect(addKeywords(many, 'mới')).toHaveLength(100);
  });
});

describe('tiện ích', () => {
  it('moveItem', () => {
    expect(moveItem([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
    expect(moveItem([1, 2, 3], 2, 1)).toEqual([1, 3, 2]);
    expect(moveItem([1, 2, 3], 0, 5)).toEqual([1, 2, 3]);
  });

  it('templateNeedsConfirm: chỉ hỏi khi ô đang có nội dung khác mẫu', () => {
    expect(templateNeedsConfirm('', 'Mẫu')).toBe(false);
    expect(templateNeedsConfirm('  \n', 'Mẫu')).toBe(false);
    expect(templateNeedsConfirm('Mẫu\n', 'Mẫu')).toBe(false);
    expect(templateNeedsConfirm('Có sẵn', 'Mẫu')).toBe(true);
    expect(templateNeedsConfirm('Có sẵn', '')).toBe(true);
  });

  it('duplicateName tránh trùng', () => {
    expect(duplicateName('Bot', ['Bot'])).toBe('Bot (bản sao)');
    expect(duplicateName('Bot', ['Bot', 'bot (bản sao)'])).toBe('Bot (bản sao 2)');
    expect(duplicateName('x'.repeat(100), []).length).toBeLessThanOrEqual(100);
  });

  it('duplicateRequest tạo bản sao đang tắt', () => {
    const body = duplicateRequest(dto, ['Tư vấn nhà phố']);
    expect(body.name).toBe('Tư vấn nhà phố (bản sao)');
    expect(body.isActive).toBe(false);
    expect(body.escalateWhenUnsure).toBe(false);
    expect(duplicateRequest({ ...dto, responseSpeed: 'balanced' }, []).responseSpeed).toBe('balanced');
    expect(body.examples).toEqual(dto.examples);
    expect(body.examples).not.toBe(dto.examples);
  });

  it('usageText', () => {
    expect(usageText(0)).toBe('Chưa dùng ở hội thoại nào');
    expect(usageText(1234)).toBe('Đang dùng ở 1.234 hội thoại');
  });
});
