import { describe, expect, it } from 'vitest';
import { formatCountdown, sendWindowState, WINDOW_EXPIRED_REASON } from './send-window';

const NOW = Date.parse('2026-11-05T08:00:00.000Z');
const inMs = (ms: number) => new Date(NOW + ms).toISOString();
const H = 3600_000;

describe('sendWindowState', () => {
  it('còn > 2 giờ: xanh', () => {
    const s = sendWindowState({ allowed: true, expiresAt: inMs(5 * H + 12 * 60_000) }, NOW);
    expect(s).toMatchObject({ tone: 'ok', canSend: true, label: 'Còn 5 giờ 12 phút' });
  });

  it('còn < 2 giờ: vàng; dưới 1 giờ hiện phút:giây', () => {
    expect(sendWindowState({ allowed: true, expiresAt: inMs(2 * H) }, NOW).tone).toBe('warn');
    const s = sendWindowState({ allowed: true, expiresAt: inMs(12 * 60_000 + 5_000) }, NOW);
    expect(s).toMatchObject({ tone: 'warn', label: 'Còn 12:05' });
  });

  it('máy chủ chặn: đỏ, khóa gửi kèm lý do', () => {
    const s = sendWindowState({ allowed: false, expiresAt: inMs(-H), reason: 'Quá 24 giờ' }, NOW);
    expect(s).toMatchObject({ tone: 'expired', canSend: false, reason: 'Quá 24 giờ' });
    expect(sendWindowState({ allowed: false, expiresAt: null }, NOW).reason).toBe(WINDOW_EXPIRED_REASON);
  });

  it('hết hạn tại máy khách dù máy chủ còn báo allowed: khóa gửi', () => {
    const s = sendWindowState({ allowed: true, expiresAt: inMs(-1) }, NOW);
    expect(s).toMatchObject({ tone: 'expired', canSend: false });
  });

  it('không giới hạn khi expiresAt = null', () => {
    expect(sendWindowState({ allowed: true, expiresAt: null }, NOW)).toMatchObject({
      tone: 'unlimited',
      canSend: true,
      remainingMs: null,
    });
  });

  it('giữ reason/tag khi được phép có điều kiện (HUMAN_AGENT)', () => {
    const s = sendWindowState(
      { allowed: true, expiresAt: inMs(3 * 24 * H), tag: 'HUMAN_AGENT', reason: 'Gửi với tag HUMAN_AGENT' },
      NOW,
    );
    expect(s).toMatchObject({ tone: 'ok', label: 'Còn 3 ngày 0 giờ', reason: 'Gửi với tag HUMAN_AGENT' });
  });
});

describe('formatCountdown', () => {
  it('định dạng theo độ dài', () => {
    expect(formatCountdown(59_000)).toBe('00:59');
    expect(formatCountdown(H)).toBe('1 giờ 0 phút');
    expect(formatCountdown(25 * H)).toBe('1 ngày 1 giờ');
    expect(formatCountdown(-5)).toBe('00:00');
  });
});
