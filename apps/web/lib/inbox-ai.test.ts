import { describe, expect, it } from 'vitest';
import { conv, msg } from './__fixtures__/inbox';
import {
  AI_RUN_DECISION_LABELS,
  CHATBOT_LOCKED_HINT,
  botSenderLabel,
  chatbotControlState,
  chatbotSelectOptions,
  conversationAiState,
  extractConversation,
  formatLatency,
  handoffAckedText,
  handoffButtonLabels,
  chatbotLockedHint,
  handoffReasonLabel,
  isAiPaused,
  matchesAiState,
  withAiResumed,
  withChatbot,
  withHandoffAcknowledged,
  withHandoffResolved,
} from './inbox-ai';
import { looksLikeConversation } from './inbox-api';

const NOW = Date.parse('2026-11-09T08:00:00.000Z');
const BOT = { id: 'b-1', name: 'Tư vấn sofa' };
const HANDOFF = {
  reasonCode: 'discount' as const,
  summary: 'Khách xin giảm 10%',
  at: '2026-11-09T07:59:00.000Z',
  acknowledgedBy: null,
};

describe('trạng thái AI của hội thoại', () => {
  it('isAiPaused: chỉ khi aiPausedUntil ở tương lai', () => {
    expect(isAiPaused(conv({ aiPausedUntil: '2026-11-09T08:30:00.000Z' }), NOW)).toBe(true);
    expect(isAiPaused(conv({ aiPausedUntil: '2026-11-09T07:30:00.000Z' }), NOW)).toBe(false);
    expect(isAiPaused(conv({ aiPausedUntil: null }), NOW)).toBe(false);
    expect(isAiPaused(conv(), NOW)).toBe(false);
    expect(isAiPaused(conv({ aiPausedUntil: 'không phải ngày' }), NOW)).toBe(false);
  });

  it('conversationAiState: handoff > none > paused > active', () => {
    expect(conversationAiState(conv({ status: 'pending_human', chatbot: BOT, aiMode: 'off' }), NOW)).toBe(
      'handoff',
    );
    expect(conversationAiState(conv({ chatbot: null, aiMode: 'auto' }), NOW)).toBe('none');
    expect(conversationAiState(conv({ chatbot: BOT, aiMode: 'off' }), NOW)).toBe('none');
    expect(
      conversationAiState(
        conv({ chatbot: BOT, aiMode: 'auto', aiPausedUntil: '2026-11-09T08:10:00.000Z' }),
        NOW,
      ),
    ).toBe('paused');
    expect(conversationAiState(conv({ chatbot: BOT, aiMode: 'auto' }), NOW)).toBe('active');
  });

  it('chatbotControlState: chỉ "on" khi ai_mode auto; còn gắn bot mà ai_mode off ⇒ "off"; chờ người ⇒ khóa', () => {
    expect(chatbotControlState(conv({ chatbot: BOT, aiMode: 'auto' }))).toBe('on');
    expect(chatbotControlState(conv({ chatbot: BOT, aiMode: 'off' }))).toBe('off');
    expect(chatbotControlState(conv({ chatbot: BOT, aiMode: 'off', status: 'resolved' }))).toBe('off');
    expect(chatbotControlState(conv({ chatbot: null, aiMode: 'off' }))).toBe('none');
    expect(chatbotControlState(conv({ chatbot: BOT, aiMode: 'off', status: 'pending_human' }))).toBe(
      'handoff',
    );
  });

  it('matchesAiState("handled") = có chatbot và ai_mode auto', () => {
    expect(matchesAiState(conv({ chatbot: BOT, aiMode: 'auto' }), 'handled')).toBe(true);
    expect(matchesAiState(conv({ chatbot: BOT, aiMode: 'off' }), 'handled')).toBe(false);
    expect(matchesAiState(conv({ chatbot: null, aiMode: 'auto' }), 'handled')).toBe(false);
    expect(matchesAiState(conv(), 'handled')).toBe(false);
    expect(matchesAiState(conv(), undefined)).toBe(true);
  });
});

describe('cập nhật lạc quan', () => {
  it('withChatbot: chọn lại đúng bot đang tắt ⇒ bật lại; đang chờ người ⇒ mở lại, đóng handoff', () => {
    expect(withChatbot(conv({ chatbot: BOT, aiMode: 'off', status: 'resolved' }), BOT)).toMatchObject({
      chatbot: BOT,
      aiMode: 'auto',
      status: 'resolved',
    });
    const waiting = conv({ chatbot: BOT, aiMode: 'off', status: 'pending_human', handoff: HANDOFF });
    expect(withChatbot(waiting, BOT)).toMatchObject({ status: 'open', handoff: null, aiMode: 'auto' });
    expect(withChatbot(waiting, null)).toMatchObject({ status: 'pending_human', aiMode: 'off' });
  });

  it('withChatbot: bật ⇒ auto + xóa tạm dừng; tắt ⇒ off', () => {
    const paused = conv({ aiPausedUntil: '2026-11-09T08:30:00.000Z' });
    expect(withChatbot(paused, BOT)).toMatchObject({ chatbot: BOT, aiMode: 'auto', aiPausedUntil: null });
    expect(withChatbot(conv({ chatbot: BOT, aiMode: 'auto' }), null)).toMatchObject({
      chatbot: null,
      aiMode: 'off',
    });
  });

  it('withAiResumed xóa aiPausedUntil, giữ phần còn lại', () => {
    const c = conv({ chatbot: BOT, aiMode: 'auto', aiPausedUntil: '2026-11-09T08:30:00.000Z' });
    expect(withAiResumed(c)).toEqual({ ...c, aiPausedUntil: null });
  });

  it('withHandoffAcknowledged ghi người nhận và phân công nếu chưa có ai', () => {
    const me = { id: 'u-a', name: 'An' };
    const acked = withHandoffAcknowledged(conv({ status: 'pending_human', handoff: HANDOFF }), me);
    expect(acked.handoff?.acknowledgedBy).toEqual(me);
    expect(acked.assignedUser).toEqual(me);
    const other = { id: 'u-b', name: 'Bình' };
    expect(withHandoffAcknowledged(conv({ assignedUser: other, handoff: HANDOFF }), me).assignedUser).toEqual(
      other,
    );
    expect(withHandoffAcknowledged(conv({ handoff: null }), me).handoff).toBeNull();
  });

  it('withHandoffResolved: mở lại, đóng handoff, bật lại AI khi còn bot', () => {
    const withBot = conv({ status: 'pending_human', aiMode: 'off', chatbot: BOT, handoff: HANDOFF });
    expect(withHandoffResolved(withBot)).toMatchObject({
      status: 'open',
      handoff: null,
      aiMode: 'auto',
      aiPausedUntil: null,
    });
    const noBot = conv({ status: 'pending_human', aiMode: 'off', chatbot: null, handoff: HANDOFF });
    expect(withHandoffResolved(noBot).aiMode).toBe('off');
  });

  it('extractConversation nhận cả ConversationSummary lẫn { conversation }', () => {
    const c = conv({ chatbot: BOT });
    expect(extractConversation(c, looksLikeConversation)).toBe(c);
    expect(extractConversation({ conversation: c, previousAssigneeId: null }, looksLikeConversation)).toBe(c);
    expect(extractConversation({ ok: true }, looksLikeConversation)).toBeNull();
    expect(extractConversation(null, looksLikeConversation)).toBeNull();
  });
});

describe('hiển thị', () => {
  it('botSenderLabel: "AI · <tên bot>", thiếu tên thì "AI"', () => {
    expect(botSenderLabel(msg({ senderType: 'bot', senderLabel: 'Tư vấn sofa' }))).toBe('AI · Tư vấn sofa');
    expect(botSenderLabel(msg({ senderType: 'bot', senderLabel: '  ' }))).toBe('AI');
    expect(botSenderLabel(msg({ senderType: 'bot', senderLabel: null }))).toBe('AI');
  });

  it('handoffReasonLabel dùng HANDOFF_REASON_LABELS, mã lạ ⇒ "Lý do khác"', () => {
    expect(handoffReasonLabel('human_request')).toBe('Khách muốn gặp nhân viên');
    expect(handoffReasonLabel('???')).toBe('Lý do khác');
    expect(handoffReasonLabel(null)).toBe('Lý do khác');
  });

  it('chatbotSelectOptions: chỉ bot đang bật (theo tên) + bot đang gắn đã tắt', () => {
    const bots = [
      { id: 'b-2', name: 'Bảo hành', isActive: true },
      { id: 'b-3', name: 'Cũ', isActive: false },
      { id: 'b-1', name: 'Tư vấn sofa', isActive: true },
    ];
    expect(chatbotSelectOptions(bots, null)).toEqual([
      { id: 'b-2', label: 'Bảo hành' },
      { id: 'b-1', label: 'Tư vấn sofa' },
    ]);
    expect(chatbotSelectOptions(bots, { id: 'b-3', name: 'Cũ' }).at(-1)).toEqual({
      id: 'b-3',
      label: 'Cũ (đã tắt)',
    });
    expect(chatbotSelectOptions(bots, BOT)).toHaveLength(2);
  });

  it('nhãn quyết định + độ trễ', () => {
    expect(AI_RUN_DECISION_LABELS.escalate).toBe('Chuyển người');
    expect(formatLatency(850)).toBe('850 ms');
    expect(formatLatency(1234)).toBe('1,2 s');
    expect(formatLatency(Number.NaN)).toBe('—');
  });
});

describe('tên nút banner Cần người', () => {
  const custom = { ...BOT, handoffAckLabel: 'Nghiệm thu', handoffResolveLabel: 'Đã chuyển tiền' };
  const def = { ack: 'Nhận xử lý', resolve: 'Đã xong, trả lại cho AI', customAck: false };

  it('bot đặt tên riêng (đi kèm hội thoại) ⇒ dùng tên của bot', () => {
    expect(handoffButtonLabels(custom)).toEqual({
      ack: 'Nghiệm thu',
      resolve: 'Đã chuyển tiền',
      customAck: true,
    });
  });

  it('bot không đặt tên / chuỗi trắng ⇒ mặc định', () => {
    expect(handoffButtonLabels(BOT)).toEqual(def);
    expect(handoffButtonLabels({ ...BOT, handoffAckLabel: '  ', handoffResolveLabel: '' })).toEqual(def);
  });

  it('chỉ đặt một nút ⇒ nút còn lại mặc định; trim khoảng trắng', () => {
    expect(handoffButtonLabels({ ...BOT, handoffResolveLabel: '  Đã chuyển tiền ' })).toEqual({
      ack: 'Nhận xử lý',
      resolve: 'Đã chuyển tiền',
      customAck: false,
    });
  });

  it('hội thoại không gắn bot ⇒ "Nhận xử lý" / "Đã xong"', () => {
    expect(handoffButtonLabels(null)).toEqual({ ack: 'Nhận xử lý', resolve: 'Đã xong', customAck: false });
  });

  it('dòng đã nhận: mặc định giữ "Đã nhận bởi …", tên riêng ⇒ Đã bấm "<tên>" — …', () => {
    expect(handoffAckedText(handoffButtonLabels(null), 'bạn')).toBe('Đã nhận bởi bạn');
    const labels = handoffButtonLabels(custom);
    expect(handoffAckedText(labels, 'bạn')).toBe('Đã bấm "Nghiệm thu" — bạn');
    expect(handoffAckedText(labels, 'Lan')).toBe('Đã bấm "Nghiệm thu" — Lan');
  });

  it('gợi ý ô chọn bot bị khóa nêu đúng tên nút xong', () => {
    expect(chatbotLockedHint(BOT)).toBe(CHATBOT_LOCKED_HINT);
    expect(chatbotLockedHint(custom)).toBe("Bấm 'Đã chuyển tiền' để bật lại bot");
  });
});
