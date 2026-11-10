import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LarkNotifyError } from './errors';
import { buildHandoffLarkCard, escapeLarkMd, notifyLark, signLarkWebhook } from './lark';

const input = {
  contactName: 'Nguyễn *Văn* A',
  channelName: 'Dezon Nội Thất',
  reasonLabel: 'Khách hỏi giảm giá / khuyến mãi',
  summary: 'Khách hỏi giảm giá tủ bếp <b>',
  conversationUrl: 'https://inbox.dezon.vn/inbox/abc',
};

function fakeFetch(status: number, body: unknown, opts: { raw?: string; throws?: Error } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (opts.throws) throw opts.throws;
    return new Response(opts.raw ?? JSON.stringify(body), { status });
  }) as typeof fetch;
  return { f, calls };
}

describe('buildHandoffLarkCard', () => {
  it('thẻ đỏ có Khách/Kênh/Lý do/Tóm tắt (đã escape) và nút mở hội thoại', () => {
    const card = buildHandoffLarkCard(input);
    expect(card.msg_type).toBe('interactive');
    const json = JSON.stringify(card);
    expect(card.card.header).toEqual({
      title: { tag: 'plain_text', content: '🔔 Cần người xử lý' },
      template: 'red',
    });
    expect(json).toContain('**Khách:**\\nNguyễn &#42;Văn&#42; A');
    expect(json).toContain('**Kênh:**\\nDezon Nội Thất');
    expect(json).toContain('**Lý do:**');
    expect(json).toContain('&lt;b&gt;');
    expect(json).toContain('"url":"https://inbox.dezon.vn/inbox/abc"');
    expect(json).toContain('Mở hội thoại');
  });

  it('thẻ nhắc lại màu cam, thẻ thử màu xanh', () => {
    const reminder = buildHandoffLarkCard({ ...input, reminder: true }).card.header as { template: string };
    expect(reminder.template).toBe('orange');
    const test = buildHandoffLarkCard({ ...input, test: true }).card.header as { template: string };
    expect(test.template).toBe('green');
  });

  it('escapeLarkMd', () => {
    expect(escapeLarkMd('a*b_c~[d]<e>&')).toBe('a&#42;b&#95;c&#126;&#91;d&#93;&lt;e&gt;&amp;');
  });
});

describe('notifyLark', () => {
  const card = buildHandoffLarkCard(input);
  const now = () => new Date('2026-11-09T07:00:00Z');
  const ts = Math.floor(now().getTime() / 1000);

  it('ký HMAC theo Lark khi có secret', async () => {
    const { f, calls } = fakeFetch(200, { code: 0, msg: 'success', data: {} });
    await notifyLark({ webhookUrl: 'https://open.larksuite.com/hook/x', secret: 'bi-mat' }, card, {
      fetch: f,
      now,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://open.larksuite.com/hook/x');
    expect(calls[0]?.init.method).toBe('POST');
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    const expected = createHmac('sha256', `${ts}\nbi-mat`).update('').digest('base64');
    expect(body.timestamp).toBe(String(ts));
    expect(body.sign).toBe(expected);
    expect(signLarkWebhook(ts, 'bi-mat')).toBe(expected);
    expect(body.msg_type).toBe('interactive');
    expect(body.card).toEqual(card.card);
  });

  it('không có secret ⇒ không ký', async () => {
    const { f, calls } = fakeFetch(200, { StatusCode: 0, StatusMessage: 'success' });
    await notifyLark({ webhookUrl: 'https://x.test/hook', secret: null }, card, { fetch: f, now });
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.sign).toBeUndefined();
    expect(body.timestamp).toBeUndefined();
  });

  it('body code ≠ 0 ⇒ LarkNotifyError, không lộ secret', async () => {
    const { f } = fakeFetch(200, { code: 19021, msg: 'sign match fail or timestamp is not within one hour' });
    const err = await notifyLark({ webhookUrl: 'https://x.test/hook', secret: 'bi-mat' }, card, {
      fetch: f,
      now,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LarkNotifyError);
    expect((err as Error).message).toContain('19021');
    expect((err as Error).message).not.toContain('bi-mat');
  });

  it('HTTP lỗi ⇒ LarkNotifyError', async () => {
    const { f } = fakeFetch(500, null, { raw: 'Internal error' });
    await expect(
      notifyLark({ webhookUrl: 'https://x.test/hook', secret: null }, card, { fetch: f }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('lỗi mạng ⇒ LarkNotifyError', async () => {
    const { f } = fakeFetch(0, null, { throws: new TypeError('fetch failed') });
    await expect(
      notifyLark({ webhookUrl: 'https://x.test/hook', secret: null }, card, { fetch: f }),
    ).rejects.toBeInstanceOf(LarkNotifyError);
  });

  it('timeout ⇒ LarkNotifyError', async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as typeof fetch;
    await expect(
      notifyLark({ webhookUrl: 'https://x.test/hook', secret: null }, card, { fetch: hang, timeoutMs: 20 }),
    ).rejects.toThrow(/không phản hồi/);
  });
});
