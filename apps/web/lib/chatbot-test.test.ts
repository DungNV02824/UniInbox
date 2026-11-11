import type { ChatbotTestResult } from '@dezon/shared';
import { describe, expect, it } from 'vitest';
import {
  appendResult,
  BOT_CONTINUES_AFTER_HANDOFF_NOTE,
  botContinuesAfterHandoff,
  botContinuesNote,
  buildTestMessages,
  describeOutcome,
  formatLatency,
  HANDOFF_NO_MESSAGE_NOTE,
  notifiedKeywordNote,
  outcomeMeta,
  transcriptIsLong,
  withBotContinues,
  type TestEntry,
} from './chatbot-test';

const base: Omit<ChatbotTestResult, 'decision'> = { latencyMs: 1234, model: 'gemini-2.5-flash' };

describe('notifiedKeywordNote', () => {
  it('khớp từ khóa "bot VẪN trả lời" ⇒ ghi chú báo nhân viên; không khớp ⇒ null', () => {
    expect(notifiedKeywordNote({ decision: 'reply', notifiedKeyword: 'gửi công trình' })).toBe(
      '🔔 Chạy thật sẽ báo nhân viên (từ khóa "gửi công trình") — bot vẫn trả lời',
    );
    expect(notifiedKeywordNote({ decision: 'no_reply', notifiedKeyword: 'nghiệm thu' })).toBe(
      '🔔 Chạy thật sẽ báo nhân viên (từ khóa "nghiệm thu")',
    );
    expect(notifiedKeywordNote({ decision: 'reply' })).toBeNull();
    expect(notifiedKeywordNote({ decision: 'reply', notifiedKeyword: '  ' })).toBeNull();
  });
});

describe('bot vẫn trả lời sau khi AI tự chuyển người (aiHandoffMode continue)', () => {
  const escalate: ChatbotTestResult = {
    ...base,
    decision: 'escalate',
    reasonCode: 'other',
    summary: 'CTV gửi đủ 7 ảnh công trình, cần duyệt thù lao',
    messages: ['Dạ em đã nhận đủ ảnh và chuyển thông tin cho bộ phận kiểm tra…'],
  };

  it("suy ra từ bản nháp: chỉ khi 'continue' + AI tự chuyển (escalate / lỗi)", () => {
    expect(botContinuesAfterHandoff(escalate, 'continue')).toBe(true);
    expect(botContinuesAfterHandoff({ ...base, decision: 'error', reason: 'x' }, 'continue')).toBe(true);
    expect(botContinuesAfterHandoff(escalate, 'stop')).toBe(false);
    expect(botContinuesAfterHandoff({ ...base, decision: 'reply', messages: ['x'] }, 'continue')).toBe(false);
    expect(botContinuesAfterHandoff({ ...base, decision: 'no_reply' }, 'continue')).toBe(false);
    // Từ khóa "DỪNG bot" luôn dừng bot.
    expect(
      botContinuesAfterHandoff(
        {
          ...escalate,
          summary: 'Khách nhắn từ khóa chuyển người "giảm giá" (Khách hỏi giảm giá / khuyến mãi)',
        },
        'continue',
      ),
    ).toBe(false);
  });

  it('API đã điền botContinuesAfterHandoff ⇒ dùng luôn', () => {
    expect(botContinuesAfterHandoff({ ...escalate, botContinuesAfterHandoff: false }, 'continue')).toBe(
      false,
    );
    expect(botContinuesAfterHandoff({ ...escalate, botContinuesAfterHandoff: true }, 'stop')).toBe(true);
  });

  it('ghi chú "Chạy thật: chuyển nhân viên nhưng bot vẫn tiếp tục trả lời"', () => {
    expect(BOT_CONTINUES_AFTER_HANDOFF_NOTE).toBe(
      'Chạy thật: chuyển nhân viên nhưng bot vẫn tiếp tục trả lời',
    );
    expect(botContinuesNote(withBotContinues(escalate, 'continue'))).toBe(BOT_CONTINUES_AFTER_HANDOFF_NOTE);
    expect(botContinuesNote(withBotContinues(escalate, 'stop'))).toBeNull();
    expect(botContinuesNote(escalate)).toBeNull();
    expect(botContinuesNote({ ...base, decision: 'reply', botContinuesAfterHandoff: true })).toBeNull();
    // withBotContinues giữ nguyên kết quả gốc.
    expect(withBotContinues(escalate, 'continue')).toMatchObject(escalate);
  });
});

describe('buildTestMessages', () => {
  it('chỉ lấy tin khách/bot, bỏ dòng trống, trim', () => {
    const entries: TestEntry[] = [
      { id: '1', kind: 'customer', text: ' Chào shop ' },
      { id: '2', kind: 'bot', text: 'Dạ em chào anh/chị' },
      { id: '3', kind: 'outcome', result: { ...base, decision: 'reply', messages: ['x'] } },
      { id: '4', kind: 'failure', message: 'lỗi' },
      { id: '5', kind: 'customer', text: '   ' },
      { id: '6', kind: 'customer', text: 'Giá?' },
    ];
    expect(buildTestMessages(entries)).toEqual([
      { role: 'customer', text: 'Chào shop' },
      { role: 'bot', text: 'Dạ em chào anh/chị' },
      { role: 'customer', text: 'Giá?' },
    ]);
  });

  it('giữ tối đa 30 tin gần nhất và bắt đầu bằng tin khách; cắt 2000 ký tự', () => {
    const entries: TestEntry[] = [];
    for (let i = 0; i < 20; i += 1) {
      entries.push({ id: `c${i}`, kind: 'customer', text: `hỏi ${i}` });
      entries.push({ id: `b${i}`, kind: 'bot', text: `đáp ${i}` });
    }
    entries.push({ id: 'last', kind: 'customer', text: 'x'.repeat(2500) });
    const msgs = buildTestMessages(entries);
    expect(msgs.length).toBeLessThanOrEqual(30);
    expect(msgs[0]!.role).toBe('customer');
    expect(msgs.at(-1)!.text).toHaveLength(2000);
  });

  it('không có tin khách => rỗng', () => {
    expect(buildTestMessages([{ id: '1', kind: 'bot', text: 'x' }])).toEqual([]);
  });

  it('lượt chuyển người mà bot vẫn trả lời ⇒ tin ngay trước mang handoffOpened (chỉ lần đầu)', () => {
    const handoff = (extra: Partial<ChatbotTestResult> = {}): TestEntry => ({
      id: 'o',
      kind: 'outcome',
      result: {
        ...base,
        decision: 'escalate',
        reasonCode: 'other',
        botContinuesAfterHandoff: true,
        ...extra,
      },
    });
    const msgs = buildTestMessages([
      { id: '1', kind: 'customer', text: 'Em gửi ảnh' },
      { id: '2', kind: 'bot', text: 'Dạ em đã nhận đủ ảnh' },
      handoff(),
      { id: '3', kind: 'customer', text: 'ảnh CT B' },
      { id: '4', kind: 'bot', text: 'Dạ em nhận CT B' },
      handoff({ reasonCode: 'complaint' }),
      { id: '5', kind: 'customer', text: 'hello' },
    ]);
    expect(msgs.map((m) => m.handoffOpened)).toEqual([undefined, 'other', undefined, undefined, undefined]);
    // Lỗi (không reasonCode) ⇒ 'other'; bot dừng (không có cờ) ⇒ không đánh dấu.
    const err = buildTestMessages([
      { id: '1', kind: 'customer', text: 'alo' },
      handoff({ decision: 'error', reasonCode: undefined }),
      { id: '2', kind: 'customer', text: 'hello' },
    ]);
    expect(err[0]).toEqual({ role: 'customer', text: 'alo', handoffOpened: 'other' });
    const stop = buildTestMessages([
      { id: '1', kind: 'customer', text: 'alo' },
      handoff({ botContinuesAfterHandoff: false }),
      { id: '2', kind: 'customer', text: 'hello' },
    ]);
    expect(stop.every((m) => m.handoffOpened === undefined)).toBe(true);
  });
});

describe('appendResult', () => {
  let n = 0;
  const id = () => `id${++n}`;

  it('reply: mỗi bong bóng một dòng bot + dòng kết quả', () => {
    const out = appendResult(
      [{ id: 'c', kind: 'customer', text: 'hi' }],
      { ...base, decision: 'reply', messages: ['Dạ', '  ', 'Em gửi giá ạ'] },
      id,
    );
    expect(out.map((e) => e.kind)).toEqual(['customer', 'bot', 'bot', 'outcome']);
    expect(out[2]).toMatchObject({ kind: 'bot', text: 'Em gửi giá ạ' });
  });

  it('escalate: tin khách nhận được thành bong bóng bot + dòng kết quả', () => {
    const out = appendResult(
      [{ id: 'c', kind: 'customer', text: 'Giảm giá được không?' }],
      {
        ...base,
        decision: 'escalate',
        reasonCode: 'discount',
        summary: 'Khách xin giảm giá',
        messages: ['Dạ em chuyển anh/chị sang nhân viên tư vấn ạ', ' '],
      },
      id,
    );
    expect(out.map((e) => e.kind)).toEqual(['customer', 'bot', 'outcome']);
    expect(out[1]).toMatchObject({ kind: 'bot', text: 'Dạ em chuyển anh/chị sang nhân viên tư vấn ạ' });
    // Lượt sau: tin bot đó được gửi lại với role 'bot'.
    const next = [...out, { id: 'c2', kind: 'customer' as const, text: 'ok em' }];
    expect(buildTestMessages(next)).toEqual([
      { role: 'customer', text: 'Giảm giá được không?' },
      { role: 'bot', text: 'Dạ em chuyển anh/chị sang nhân viên tư vấn ạ' },
      { role: 'customer', text: 'ok em' },
    ]);
  });

  it('escalate không có tin cho khách: chỉ thêm dòng kết quả', () => {
    const out = appendResult([], { ...base, decision: 'escalate', reasonCode: 'discount' }, id);
    expect(out.map((e) => e.kind)).toEqual(['outcome']);
  });

  it('no_reply / error: không thêm tin bot nào (kể cả nếu API lỡ trả messages)', () => {
    for (const decision of ['no_reply', 'error'] as const) {
      const out = appendResult([], { ...base, decision, reason: 'x', messages: ['không được hiện'] }, id);
      expect(out.map((e) => e.kind)).toEqual(['outcome']);
    }
  });
});

describe('describeOutcome', () => {
  it('escalate có lý do tiếng Việt + tóm tắt', () => {
    expect(
      describeOutcome({
        ...base,
        decision: 'escalate',
        reasonCode: 'discount',
        summary: 'Khách xin bớt 10%',
      }),
    ).toEqual({
      tone: 'handoff',
      title: 'Chuyển người thật: Khách hỏi giảm giá / khuyến mãi',
      detail: 'Khách xin bớt 10%',
      note: HANDOFF_NO_MESSAGE_NOTE,
    });
    expect(HANDOFF_NO_MESSAGE_NOTE).toBe('Khách không nhận tin nào (chưa đặt Tin nhắn khi chuyển người)');
  });

  it('escalate có tin gửi khách => không hiện ghi chú "không nhận tin nào"', () => {
    expect(
      describeOutcome({ ...base, decision: 'escalate', messages: ['Dạ em chuyển nhân viên ạ'] }).note,
    ).toBeNull();
    expect(describeOutcome({ ...base, decision: 'escalate', messages: ['  '] }).note).toBe(
      HANDOFF_NO_MESSAGE_NOTE,
    );
  });

  it('no_reply / error / reply', () => {
    expect(describeOutcome({ ...base, decision: 'no_reply', reason: 'Khách chỉ gửi sticker' }).title).toBe(
      'Không trả lời: Khách chỉ gửi sticker',
    );
    expect(describeOutcome({ ...base, decision: 'no_reply' })).toMatchObject({
      tone: 'silent',
      title: 'Không trả lời',
      note: 'Khách không nhận tin nào',
    });
    expect(describeOutcome({ ...base, decision: 'error', reason: 'Hết hạn mức' })).toMatchObject({
      tone: 'error',
      detail: 'Hết hạn mức',
    });
    expect(describeOutcome({ ...base, decision: 'reply', messages: ['ok'] }).title).toBeNull();
  });
});

describe('định dạng', () => {
  it('formatLatency', () => {
    expect(formatLatency(850)).toBe('850 ms');
    expect(formatLatency(1234)).toBe('1,2 giây');
    expect(formatLatency(Number.NaN)).toBe('');
  });

  it('outcomeMeta', () => {
    expect(outcomeMeta({ ...base, decision: 'reply', usage: { inputTokens: 1000, outputTokens: 234 } })).toBe(
      '1,2 giây · gemini-2.5-flash · 1.234 token',
    );
    expect(outcomeMeta({ ...base, decision: 'reply' })).toBe('1,2 giây · gemini-2.5-flash');
  });

  it('transcriptIsLong', () => {
    const many: TestEntry[] = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      kind: 'customer' as const,
      text: 'x',
    }));
    expect(transcriptIsLong(many)).toBe(true);
    expect(transcriptIsLong(many.slice(1))).toBe(false);
  });
});
