import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LarkNotifyError } from './errors';
import { formatVnDateTime } from './handoff-action';
import {
  buildHandoffActionLarkCard,
  buildHandoffLarkCard,
  escapeLarkMd,
  notifyLark,
  signLarkWebhook,
  type HandoffActionCardInput,
} from './lark';

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

const actionInput: HandoffActionCardInput = {
  action: 'ack',
  buttonLabel: 'Nghiệm thu',
  contactName: 'Trần_Thị *B*',
  channelName: 'Dezon Nội Thất',
  chatbotName: 'Bot Nghiệm Thu',
  actorName: 'Hương',
  at: '14:36 10/11/2026',
  summaries: ['Công trình [Q7] — 12 ảnh, thù lao 500k <ok>'],
  conversationUrl: 'https://inbox.dezon.vn/inbox/xyz',
};

type ActionCard = {
  header: { title: { tag: string; content: string }; template: string };
  elements: [
    { tag: string; fields: { is_short: boolean; text: { tag: string; content: string } }[] },
    { tag: string; actions: { tag: string; text: { content: string }; type: string; url: string }[] },
  ];
};

describe('buildHandoffActionLarkCard', () => {
  it('ack ⇒ header xanh lá "✅ <tên nút>"; resolve ⇒ xanh dương "☑️ <tên nút>"', () => {
    const ack = buildHandoffActionLarkCard(actionInput);
    expect(ack.msg_type).toBe('interactive');
    expect(ack.card.header).toEqual({
      title: { tag: 'plain_text', content: '✅ Nghiệm thu' },
      template: 'green',
    });
    const resolve = buildHandoffActionLarkCard({
      ...actionInput,
      action: 'resolve',
      buttonLabel: 'Đã chuyển tiền',
    });
    expect(resolve.card.header).toEqual({
      title: { tag: 'plain_text', content: '☑️ Đã chuyển tiền' },
      template: 'blue',
    });
  });

  it('các dòng Khách/Kênh/Bot/Người bấm/Lúc/Nội dung (escape lark_md) và nút mở hội thoại', () => {
    const card = buildHandoffActionLarkCard(actionInput).card as unknown as ActionCard;
    const [div, action] = card.elements;
    expect(div.tag).toBe('div');
    expect(div.fields.map((f) => [f.is_short, f.text.tag])).toEqual([
      [true, 'lark_md'],
      [true, 'lark_md'],
      [true, 'lark_md'],
      [true, 'lark_md'],
      [true, 'lark_md'],
      [false, 'lark_md'],
    ]);
    expect(div.fields.map((f) => f.text.content)).toEqual([
      '**Khách:**\nTrần&#95;Thị &#42;B&#42;',
      '**Kênh:**\nDezon Nội Thất',
      '**Bot:**\nBot Nghiệm Thu',
      '**Người bấm:**\nHương',
      '**Lúc:**\n14:36 10/11/2026',
      '**Nội dung:**\nCông trình &#91;Q7&#93; — 12 ảnh, thù lao 500k &lt;ok&gt;',
    ]);
    expect(action.tag).toBe('action');
    expect(action.actions).toEqual([
      {
        tag: 'button',
        text: { tag: 'plain_text', content: 'Mở hội thoại' },
        type: 'default',
        url: 'https://inbox.dezon.vn/inbox/xyz',
      },
    ]);
  });

  it('nhiều tóm tắt ⇒ đánh số từng dòng; không có ⇒ "—"', () => {
    const many = buildHandoffActionLarkCard({ ...actionInput, summaries: [' Nhà A ', 'Nhà *B*'] })
      .card as unknown as ActionCard;
    expect(many.elements[0].fields[5]?.text.content).toBe('**Nội dung:**\n1. Nhà A\n2. Nhà &#42;B&#42;');
    const none = buildHandoffActionLarkCard({ ...actionInput, summaries: [] }).card as unknown as ActionCard;
    expect(none.elements[0].fields[5]?.text.content).toBe('**Nội dung:**\n—');
  });
});

describe('formatVnDateTime', () => {
  it('UTC ⇒ giờ Việt Nam (UTC+7) dạng "HH:mm dd/MM/yyyy"', () => {
    expect(formatVnDateTime(new Date('2026-11-10T07:36:00Z'))).toBe('14:36 10/11/2026');
    expect(formatVnDateTime(new Date('2026-01-05T01:05:09Z'))).toBe('08:05 05/01/2026');
  });

  it('qua nửa đêm sang ngày/năm mới, giờ 00 không thành 24', () => {
    expect(formatVnDateTime(new Date('2026-12-31T17:00:00Z'))).toBe('00:00 01/01/2027');
    expect(formatVnDateTime(new Date('2026-03-08T16:59:00Z'))).toBe('23:59 08/03/2026');
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
