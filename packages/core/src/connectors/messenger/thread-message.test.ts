import { describe, expect, it } from 'vitest';
import type { MessengerThreadMessage } from './conversations';
import { threadMessageToInbound, unwrapFacebookRedirect, type ThreadMessageContext } from './thread-message';

const PAGE = '1373442085851879';
const PSID = '39840294375585055';
const ctx: ThreadMessageContext = {
  channelAccountId: 'acc-1',
  pageId: PAGE,
  conversationId: 't_1',
  customer: { id: PSID, name: 'Đúng Văn' },
};
const at = new Date('2026-11-05T15:00:20Z');

function msg(extra: Partial<MessengerThreadMessage>): MessengerThreadMessage {
  return {
    id: 'm_1',
    from: { id: PSID, name: 'Đúng Văn' },
    to: [{ id: PAGE }],
    createdTime: at,
    attachments: [],
    shares: [],
    ...extra,
  };
}

describe('threadMessageToInbound', () => {
  it('tin của khách => in/customer, profileHint = tên participant, raw không có message.app_id', () => {
    const out = threadMessageToInbound(msg({ text: 'Chào shop' }), ctx);
    expect(out).toEqual({
      channelAccountId: 'acc-1',
      channelType: 'messenger',
      externalUserId: PSID,
      externalMessageId: 'm_1',
      direction: 'in',
      senderType: 'customer',
      text: 'Chào shop',
      attachments: [],
      sentAt: at,
      profileHint: { name: 'Đúng Văn' },
      raw: {
        source: 'sync',
        pageId: PAGE,
        conversationId: 't_1',
        mid: 'm_1',
        fromId: PSID,
        createdTime: at.toISOString(),
      },
    });
  });

  it('tin do Page gửi => out/agent, externalUserId = khách', () => {
    const out = threadMessageToInbound(
      msg({ from: { id: PAGE, name: 'Demo app' }, to: [{ id: PSID }], text: 'Dạ' }),
      ctx,
    );
    expect(out).toMatchObject({ direction: 'out', senderType: 'agent', externalUserId: PSID, text: 'Dạ' });
  });

  it('người gửi lạ (không phải Page, không phải khách) => null', () => {
    expect(threadMessageToInbound(msg({ from: { id: '999' } }), ctx)).toBeNull();
  });

  it('đủ loại đính kèm: ảnh, video, tệp, âm thanh, nhãn dán; URL sai bị ghi chú', () => {
    const out = threadMessageToInbound(
      msg({
        text: '',
        attachments: [
          {
            mimeType: 'image/jpeg',
            name: 'image.jpg',
            image: { url: 'https://cdn.test/i.jpg', width: 10, height: 10 },
          },
          { mimeType: 'video/mp4', name: 'v.mp4', videoUrl: 'https://cdn.test/v.mp4' },
          { mimeType: 'application/pdf', name: 'bao-gia.pdf', fileUrl: 'https://cdn.test/f.pdf' },
          { mimeType: 'audio/mpeg', name: 'audioclip.mp3', fileUrl: 'https://cdn.test/a.mp3' },
          { mimeType: 'video/mp4', name: 'clip.mp4', fileUrl: 'https://cdn.test/c.mp4' },
          { name: 'hong.bin', fileUrl: 'not a url' },
        ],
        sticker: 'https://cdn.test/s.png',
      }),
      ctx,
    )!;
    expect(out.attachments).toEqual([
      { url: 'https://cdn.test/i.jpg', type: 'image', mime: 'image/jpeg', name: 'image.jpg' },
      { url: 'https://cdn.test/v.mp4', type: 'video', mime: 'video/mp4', name: 'v.mp4' },
      { url: 'https://cdn.test/f.pdf', type: 'file', mime: 'application/pdf', name: 'bao-gia.pdf' },
      { url: 'https://cdn.test/a.mp3', type: 'audio', mime: 'audio/mpeg', name: 'audioclip.mp3' },
      { url: 'https://cdn.test/c.mp4', type: 'video', mime: 'video/mp4', name: 'clip.mp4' },
      { url: 'https://cdn.test/s.png', type: 'sticker' },
    ]);
    expect(out.text).toBe('[Tệp đính kèm] hong.bin');
  });

  it('chia sẻ liên kết: có text thì giữ text; không text thì ghi chú link thật (bỏ l.facebook.com)', () => {
    const shares = [
      { link: 'https://l.facebook.com/l.php?u=https%3A%2F%2Fdezon.vn%2Fa&h=x', name: 'Mẫu nhà' },
    ];
    expect(threadMessageToInbound(msg({ text: 'https://dezon.vn/a', shares }), ctx)!.text).toBe(
      'https://dezon.vn/a',
    );
    expect(threadMessageToInbound(msg({ shares }), ctx)!.text).toBe(
      '[Liên kết] Mẫu nhà — https://dezon.vn/a',
    );
  });

  it('không có nội dung nào => text giữ chỗ', () => {
    const out = threadMessageToInbound(msg({ text: '' }), ctx)!;
    expect(out.text).toBe('[Tin nhắn không hỗ trợ hiển thị]');
    expect(out.attachments).toEqual([]);
  });

  it('unwrapFacebookRedirect chỉ gỡ link chuyển hướng của Facebook', () => {
    expect(unwrapFacebookRedirect('https://lm.facebook.com/l.php?u=https%3A%2F%2Fa.vn%2F')).toBe(
      'https://a.vn/',
    );
    expect(unwrapFacebookRedirect('https://evil.test/l.php?u=https%3A%2F%2Fa.vn%2F')).toBe(
      'https://evil.test/l.php?u=https%3A%2F%2Fa.vn%2F',
    );
  });
});
