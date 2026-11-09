import { describe, expect, it } from 'vitest';
import {
  loginRequestSchema,
  messageAttachmentSchema,
  normalizedInboundMessageSchema,
  outboundMessageSchema,
  publicConfigSchema,
} from './index';

describe('schemas dùng chung', () => {
  it('LoginRequest chuẩn hóa email (trim + lowercase)', () => {
    expect(loginRequestSchema.parse({ email: '  Admin@Dezon.VN ', password: 'x' })).toEqual({
      email: 'admin@dezon.vn',
      password: 'x',
    });
    expect(loginRequestSchema.safeParse({ email: 'abc', password: 'x' }).success).toBe(false);
    expect(loginRequestSchema.safeParse({ email: 'a@b.vn', password: '' }).success).toBe(false);
    expect(loginRequestSchema.safeParse({ email: 'a@b.vn', password: 'x'.repeat(201) }).success).toBe(false);
  });

  it('NormalizedInboundMessage nhận sentAt dạng ISO (sau khi qua queue)', () => {
    const msg = normalizedInboundMessageSchema.parse({
      channelAccountId: 'acc-1',
      channelType: 'messenger',
      externalUserId: 'psid-1',
      externalMessageId: 'mid-1',
      direction: 'in',
      senderType: 'customer',
      text: 'Shop ơi',
      attachments: [{ url: 'https://cdn.example.com/a.jpg', type: 'image' }],
      sentAt: '2026-11-04T09:00:00.000Z',
      referral: { source: 'ADS', adId: '123' },
      raw: { any: 'thing' },
    });
    expect(msg.sentAt).toBeInstanceOf(Date);
    expect(msg.referral?.source).toBe('ADS');
  });

  it('MessageAttachment dùng snake_case như cột jsonb', () => {
    expect(
      messageAttachmentSchema.safeParse({ type: 'image', storage_key: 'k', mime: 'image/jpeg' }).success,
    ).toBe(true);
    expect(
      messageAttachmentSchema.safeParse({ type: 'gif', storage_key: 'k', mime: 'image/gif' }).success,
    ).toBe(false);
  });

  it('OutboundMessage cần text hoặc attachment', () => {
    expect(outboundMessageSchema.safeParse({ text: 'Dạ em chào chị' }).success).toBe(true);
    expect(outboundMessageSchema.safeParse({ text: '  ' }).success).toBe(false);
    expect(
      outboundMessageSchema.safeParse({
        attachments: [{ type: 'image', storageKey: 'k', mime: 'image/png' }],
      }).success,
    ).toBe(true);
  });

  it('PublicConfig', () => {
    expect(publicConfigSchema.parse({ featureAiEnabled: false, zaloPersonalEnabled: true })).toEqual({
      featureAiEnabled: false,
      zaloPersonalEnabled: true,
    });
  });
});
