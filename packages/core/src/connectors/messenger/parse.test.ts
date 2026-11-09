import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizedInboundMessageSchema, type NormalizedInboundMessage } from '@dezon/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AccountResolver, InboundEvent } from '../types';
import { PAGE_INBOX_APP_IDS, createMessengerConnector, messengerEchoSource } from './index';

const PAGE = '111111111111111';
const PAGE2 = '333333333333333';
const PSID = '2222222222222222';
const T = 1762300000000;
const OWN_APP_ID = '999999999999999';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, '__fixtures__', `${name}.json`), 'utf8'));

const connector = createMessengerConnector({
  appId: OWN_APP_ID,
  appSecret: 's',
  graphBaseUrl: 'https://graph.test',
  graphVersion: 'v26.0',
});

const resolver: AccountResolver = async (type, externalId) => {
  if (type !== 'messenger') return null;
  if (externalId === PAGE) return { id: 'acc-1' };
  if (externalId === PAGE2) return { id: 'acc-2' };
  return null;
};

const parse = (name: string) => connector.parseWebhook(fixture(name), resolver);

function onlyMessage(events: InboundEvent[]): NormalizedInboundMessage {
  expect(events).toHaveLength(1);
  const [event] = events;
  if (event?.kind !== 'message') throw new Error(`không phải message: ${event?.kind}`);
  // Hợp đồng với pipeline/queue: tin phải hợp lệ theo schema dùng chung.
  expect(normalizedInboundMessageSchema.safeParse(event.message).success).toBe(true);
  return event.message;
}

describe('parseWebhook — tin khách gửi', () => {
  it('text', async () => {
    const msg = onlyMessage(await parse('text'));
    expect(msg).toMatchObject({
      channelAccountId: 'acc-1',
      channelType: 'messenger',
      externalUserId: PSID,
      externalMessageId: 'm_text_001',
      direction: 'in',
      senderType: 'customer',
      text: 'Chào shop, mình muốn tư vấn thiết kế phòng khách',
      attachments: [],
    });
    expect(msg.sentAt).toEqual(new Date(T));
    expect(msg.referral).toBeUndefined();
    expect(msg.raw).toMatchObject({ pageId: PAGE, sender: { id: PSID }, message: { mid: 'm_text_001' } });
  });

  it('một ảnh (mime suy từ đuôi URL)', async () => {
    const msg = onlyMessage(await parse('image'));
    expect(msg.text).toBeUndefined();
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]).toMatchObject({ type: 'image', mime: 'image/jpeg' });
    expect(msg.attachments[0]?.url).toContain('scontent.xx.fbcdn.net');
  });

  it('nhiều ảnh kèm text', async () => {
    const msg = onlyMessage(await parse('images-multiple'));
    expect(msg.text).toBe('Mẫu này còn không ạ?');
    expect(msg.attachments.map((a) => [a.type, a.mime])).toEqual([
      ['image', 'image/jpeg'],
      ['image', 'image/png'],
      ['image', 'image/jpeg'],
    ]);
  });

  it('file: giữ tên tệp từ URL', async () => {
    const msg = onlyMessage(await parse('file'));
    expect(msg.attachments[0]).toMatchObject({
      type: 'file',
      name: 'bao-gia noi-that.pdf',
      mime: 'application/pdf',
    });
  });

  it('sticker kiểu mới', async () => {
    const msg = onlyMessage(await parse('sticker'));
    expect(msg.attachments).toEqual([expect.objectContaining({ type: 'sticker', mime: 'image/png' })]);
  });

  it('sticker kiểu cũ (image có sticker_id) => sticker', async () => {
    const msg = onlyMessage(await parse('sticker-legacy-image'));
    expect(msg.attachments.map((a) => a.type)).toEqual(['sticker']);
  });

  it('giai đoạn chuyển tiếp: cả sticker và image cùng sticker_id => chỉ một sticker', async () => {
    const body = fixture('sticker') as {
      entry: { messaging: { message: { attachments: unknown[] } }[] }[];
    };
    const message = body.entry[0]!.messaging[0]!.message;
    message.attachments.push({
      type: 'image',
      payload: { url: 'https://x.test/s.png', sticker_id: 369239263222822 },
    });
    const msg = onlyMessage(await connector.parseWebhook(body, resolver));
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]?.type).toBe('sticker');
  });

  it('fallback (link / không payload) => bỏ đính kèm, ghi chú vào text', async () => {
    const msg = onlyMessage(await parse('fallback-link'));
    expect(msg.attachments).toEqual([]);
    expect(msg.text).toBe(
      '[Liên kết] Mẫu phòng khách hiện đại — https://dezon.vn/mau-phong-khach\n[Nội dung chia sẻ không hỗ trợ]',
    );
  });

  it('referral ADS kèm tin đầu => {source, adId}', async () => {
    const msg = onlyMessage(await parse('referral-ads'));
    expect(msg.referral).toEqual({ source: 'ADS', adId: '120200000000000001' });
    expect(msg.direction).toBe('in');
  });

  it('postback => tin text = title, mid của postback, referral nếu có', async () => {
    const msg = onlyMessage(await parse('postback'));
    expect(msg).toMatchObject({
      externalMessageId: 'm_postback_001',
      text: 'Bắt đầu',
      direction: 'in',
      senderType: 'customer',
      referral: { source: 'SHORTLINK' },
    });
  });

  it('postback không có mid => bỏ qua', async () => {
    const body = fixture('postback') as { entry: { messaging: { postback: { mid?: string } }[] }[] };
    delete body.entry[0]!.messaging[0]!.postback.mid;
    expect(await connector.parseWebhook(body, resolver)).toEqual([]);
  });
});

describe('parseWebhook — echo', () => {
  it('echo từ app mình: out/agent, khách = recipient, raw giữ app_id + metadata', async () => {
    const msg = onlyMessage(await parse('echo-own-app'));
    expect(msg).toMatchObject({
      externalUserId: PSID,
      externalMessageId: 'm_echo_own_001',
      direction: 'out',
      senderType: 'agent',
      text: 'Dạ shop chào anh/chị ạ',
    });
    expect(msg.raw).toMatchObject({ message: { app_id: 999999999999999, metadata: 'dezon-inbox' } });
    expect(messengerEchoSource(msg.raw, OWN_APP_ID)).toBe('own');
  });

  it('echo từ Hộp thư Page (Business Suite) => page_inbox', async () => {
    const msg = onlyMessage(await parse('echo-page-inbox'));
    expect(msg.direction).toBe('out');
    expect(msg.attachments.map((a) => a.type)).toEqual(['image']);
    expect(messengerEchoSource(msg.raw, OWN_APP_ID)).toBe('page_inbox');
  });

  it('messengerEchoSource: app_id chuỗi/số, app khác, thiếu app_id', () => {
    expect(PAGE_INBOX_APP_IDS).toEqual(expect.arrayContaining(['263902037430900', '1217981644879628']));
    expect(messengerEchoSource({ message: { app_id: '26390203743090' } }, OWN_APP_ID)).toBe('page_inbox');
    expect(messengerEchoSource({ message: { app_id: OWN_APP_ID } }, OWN_APP_ID)).toBe('own');
    expect(messengerEchoSource({ message: { app_id: 123 } }, OWN_APP_ID)).toBe('other_app');
    expect(messengerEchoSource({ message: {} }, OWN_APP_ID)).toBe('other_app');
    expect(messengerEchoSource(null, OWN_APP_ID)).toBe('other_app');
  });
});

describe('parseWebhook — delivery / read', () => {
  it('delivery: mids + watermark', async () => {
    expect(await parse('delivery')).toEqual([
      {
        kind: 'delivery',
        channelAccountId: 'acc-1',
        externalUserId: PSID,
        externalMessageIds: ['m_echo_own_001'],
        watermark: new Date(T + 1500),
      },
    ]);
  });

  it('delivery thiếu mids => mảng rỗng', async () => {
    const body = fixture('delivery') as { entry: { messaging: { delivery: { mids?: string[] } }[] }[] };
    delete body.entry[0]!.messaging[0]!.delivery.mids;
    const [event] = await connector.parseWebhook(body, resolver);
    expect(event).toMatchObject({ kind: 'delivery', externalMessageIds: [] });
  });

  it('read: watermark', async () => {
    expect(await parse('read')).toEqual([
      { kind: 'read', channelAccountId: 'acc-1', externalUserId: PSID, watermark: new Date(T + 1800) },
    ]);
  });
});

describe('parseWebhook — standby, page lạ, batch, payload lạ', () => {
  it('standby: tin khách + echo + read đều được xử lý, raw đánh dấu fromStandby', async () => {
    const events = await parse('standby');
    expect(events.map((e) => e.kind)).toEqual(['message', 'message', 'read']);
    const [customer, echo] = events;
    expect(customer).toMatchObject({ message: { externalMessageId: 'm_standby_001', direction: 'in' } });
    expect(echo).toMatchObject({ message: { externalMessageId: 'm_standby_echo_001', direction: 'out' } });
    if (echo?.kind !== 'message') throw new Error('expected message');
    expect(echo.message.raw).toMatchObject({ fromStandby: true, pageId: PAGE });
    expect(messengerEchoSource(echo.message.raw, OWN_APP_ID)).toBe('page_inbox');
  });

  it('entry của page không có trong hệ thống => bỏ qua', async () => {
    expect(await parse('unknown-page')).toEqual([]);
  });

  it('batch nhiều entry/event: sắp theo timestamp, bỏ event lạ/sai, mỗi page tra 1 lần', async () => {
    const spy = vi.fn(resolver);
    const events = await connector.parseWebhook(fixture('batch'), spy);
    const summary = events.map((e) =>
      e.kind === 'message'
        ? `${e.message.channelAccountId}:${e.message.externalMessageId}`
        : `${e.channelAccountId}:${e.kind}`,
    );
    expect(summary).toEqual(['acc-1:m_batch_001', 'acc-2:m_batch_p2_001', 'acc-1:m_batch_002', 'acc-2:read']);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy).toHaveBeenCalledWith('messenger', PAGE);
    expect(spy).toHaveBeenCalledWith('messenger', PAGE2);
  });

  it('object khác "page" / body rác => [] và không ném', async () => {
    expect(await connector.parseWebhook({ object: 'instagram', entry: [] }, resolver)).toEqual([]);
    expect(await connector.parseWebhook(null, resolver)).toEqual([]);
    expect(await connector.parseWebhook('x', resolver)).toEqual([]);
    expect(await connector.parseWebhook({ object: 'page', entry: [1, null, { id: {} }] }, resolver)).toEqual(
      [],
    );
  });

  it('tin không có mid (handoff Meta AI) hoặc đã thu hồi => bỏ qua', async () => {
    const body = {
      object: 'page',
      entry: [
        {
          id: PAGE,
          messaging: [
            {
              sender: { id: PSID },
              recipient: { id: PAGE },
              timestamp: T,
              message: { admin_text: 'handoff' },
            },
            {
              sender: { id: PSID },
              recipient: { id: PAGE },
              timestamp: T,
              message: { mid: 'x', is_deleted: true },
            },
          ],
        },
      ],
    };
    expect(await connector.parseWebhook(body, resolver)).toEqual([]);
  });
});
