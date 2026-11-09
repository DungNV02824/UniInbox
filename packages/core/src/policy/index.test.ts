import { describe, expect, it } from 'vitest';
import { canSend, sendWindowInfo, type PolicyConversation, type PolicyOptions } from './index';

const H = 60 * 60 * 1000;
const M = 60 * 1000;
const D = 24 * H;
const now = new Date('2026-11-05T12:00:00.000Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const off: PolicyOptions = { metaHumanAgentEnabled: false, zaloOaAllowPaidBot: false };
const on: PolicyOptions = { metaHumanAgentEnabled: true, zaloOaAllowPaidBot: true };

function conv(
  channelType: PolicyConversation['channelType'],
  lastAgoMs: number | null,
  extra: Partial<PolicyConversation> = {},
): PolicyConversation {
  return {
    channelType,
    lastCustomerMessageAt: lastAgoMs === null ? null : ago(lastAgoMs),
    windowSource: 'organic',
    firstCustomerMessageAt: null,
    ...extra,
  };
}

describe('canSend — messenger', () => {
  it('23h59: agent và bot đều gửi được, expiresAt = last + 24h', () => {
    const c = conv('messenger', 23 * H + 59 * M);
    for (const by of ['agent', 'bot'] as const) {
      const r = canSend(c, by, now, off);
      expect(r.allowed).toBe(true);
      expect(r.tag).toBeUndefined();
      expect(r.expiresAt?.getTime()).toBe(c.lastCustomerMessageAt!.getTime() + 24 * H);
    }
  });

  it('đúng 24h vẫn gửi được (mốc bao gồm)', () => {
    expect(canSend(conv('messenger', 24 * H), 'bot', now, off).allowed).toBe(true);
  });

  it('24h01: chặn khi chưa bật HUMAN_AGENT, kèm lý do tiếng Việt', () => {
    const r = canSend(conv('messenger', 24 * H + M), 'agent', now, off);
    expect(r).toMatchObject({ allowed: false, expiresAt: null });
    expect(r.reason).toContain('24 giờ');
  });

  it('24h01 với HUMAN_AGENT: agent gửi được kèm tag, expiresAt = last + 7 ngày; bot thì không', () => {
    const c = conv('messenger', 24 * H + M);
    const agent = canSend(c, 'agent', now, on);
    expect(agent).toMatchObject({ allowed: true, tag: 'HUMAN_AGENT' });
    expect(agent.expiresAt?.getTime()).toBe(c.lastCustomerMessageAt!.getTime() + 7 * D);
    const bot = canSend(c, 'bot', now, on);
    expect(bot.allowed).toBe(false);
    expect(bot.reason).toContain('Bot');
  });

  it('6 ngày 23h vẫn HUMAN_AGENT; quá 7 ngày thì chặn kể cả agent', () => {
    expect(canSend(conv('messenger', 7 * D - H), 'agent', now, on).allowed).toBe(true);
    expect(canSend(conv('messenger', 7 * D), 'agent', now, on).allowed).toBe(true);
    const r = canSend(conv('messenger', 7 * D + M), 'agent', now, on);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('7 ngày');
  });

  it('khách chưa nhắn (lastCustomerMessageAt null) → không gửi được', () => {
    const r = canSend(conv('messenger', null), 'agent', now, on);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it('hội thoại từ quảng cáo: cửa sổ tiêu chuẩn 7 ngày tính từ tin đầu, cho cả bot, không tag', () => {
    const c = conv('messenger', 3 * D, { windowSource: 'ads', firstCustomerMessageAt: ago(5 * D) });
    const r = canSend(c, 'bot', now, off);
    expect(r).toMatchObject({ allowed: true });
    expect(r.tag).toBeUndefined();
    expect(r.expiresAt?.getTime()).toBe(ago(5 * D).getTime() + 7 * D);
  });

  it('quảng cáo: quá 7 ngày từ tin đầu nhưng tin cuối còn trong 24h → vẫn cửa sổ 24h', () => {
    const c = conv('messenger', 2 * H, { windowSource: 'ads', firstCustomerMessageAt: ago(10 * D) });
    const r = canSend(c, 'bot', now, off);
    expect(r.allowed).toBe(true);
    expect(r.expiresAt?.getTime()).toBe(ago(2 * H).getTime() + 24 * H);
  });

  it('quảng cáo: quá 7 ngày từ tin đầu, tin cuối 2 ngày → bot bị chặn, agent dùng HUMAN_AGENT', () => {
    const c = conv('messenger', 2 * D, { windowSource: 'ads', firstCustomerMessageAt: ago(7 * D + M) });
    expect(canSend(c, 'bot', now, on).allowed).toBe(false);
    expect(canSend(c, 'agent', now, on)).toMatchObject({ allowed: true, tag: 'HUMAN_AGENT' });
  });
});

describe('canSend — zalo_oa', () => {
  it('47h: miễn phí, expiresAt = last + 48h', () => {
    const c = conv('zalo_oa', 47 * H);
    const r = canSend(c, 'bot', now, off);
    expect(r.allowed).toBe(true);
    expect(r.costly).toBeUndefined();
    expect(r.expiresAt?.getTime()).toBe(c.lastCustomerMessageAt!.getTime() + 48 * H);
  });

  it('50h: agent gửi được nhưng costly; bot chỉ khi zaloOaAllowPaidBot', () => {
    const c = conv('zalo_oa', 50 * H);
    const agent = canSend(c, 'agent', now, off);
    expect(agent).toMatchObject({ allowed: true, costly: true });
    expect(agent.expiresAt?.getTime()).toBe(c.lastCustomerMessageAt!.getTime() + 7 * D);
    expect(canSend(c, 'bot', now, off).allowed).toBe(false);
    expect(canSend(c, 'bot', now, on)).toMatchObject({ allowed: true, costly: true });
  });

  it('quá 7 ngày: chặn', () => {
    const r = canSend(conv('zalo_oa', 7 * D + M), 'agent', now, on);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('7 ngày');
  });

  it('khách chưa nhắn → chặn', () => {
    expect(canSend(conv('zalo_oa', null), 'agent', now, on).allowed).toBe(false);
  });
});

describe('canSend — zalo_personal', () => {
  it('luôn gửi được, expiresAt null', () => {
    expect(canSend(conv('zalo_personal', null), 'bot', now, off)).toEqual({ allowed: true, expiresAt: null });
    expect(canSend(conv('zalo_personal', 30 * D), 'agent', now, off).allowed).toBe(true);
  });
});

describe('sendWindowInfo', () => {
  it('chuyển sang DTO với chuỗi ISO và bỏ field rỗng', () => {
    const c = conv('messenger', H);
    expect(sendWindowInfo(c, now, off)).toEqual({
      allowed: true,
      expiresAt: new Date(c.lastCustomerMessageAt!.getTime() + 24 * H).toISOString(),
    });
    expect(sendWindowInfo(conv('messenger', 2 * D), now, on)).toMatchObject({ tag: 'HUMAN_AGENT' });
  });
});
