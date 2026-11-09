import { z } from 'zod';
import { ATTACHMENT_TYPES, CHANNEL_TYPES, SENDER_TYPES } from './enums';

/** Phần tử của cột messages.attachments (jsonb) — mục 5. File đã được lưu trên S3. */
export const messageAttachmentSchema = z.object({
  type: z.enum(ATTACHMENT_TYPES),
  storage_key: z.string().min(1),
  mime: z.string().min(1),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  original_url: z.url().optional(),
  /** Tên tệp gốc (tệp nhân viên tải lên / tệp khách gửi), để hiển thị và gửi đi. */
  name: z.string().optional(),
});
export type MessageAttachment = z.infer<typeof messageAttachmentSchema>;

/** Tệp đính kèm do connector nhận được: URL tạm của nền tảng, chưa tải về S3. */
export const inboundAttachmentSchema = z.object({
  url: z.url(),
  type: z.enum(ATTACHMENT_TYPES),
  mime: z.string().min(1).optional(),
  name: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
});
export type InboundAttachment = z.infer<typeof inboundAttachmentSchema>;

export const MESSAGE_DIRECTIONS = ['in', 'out'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

/** Tin đến đã chuẩn hóa — đúng mục 6.1. `sentAt` nhận cả chuỗi ISO (sau khi qua hàng đợi). */
export const normalizedInboundMessageSchema = z.object({
  channelAccountId: z.string().min(1),
  channelType: z.enum(CHANNEL_TYPES),
  externalUserId: z.string().min(1),
  externalMessageId: z.string().min(1),
  /** 'out' = echo / tin do OA hoặc chính chủ gửi */
  direction: z.enum(MESSAGE_DIRECTIONS),
  senderType: z.enum(SENDER_TYPES),
  text: z.string().optional(),
  attachments: z.array(inboundAttachmentSchema),
  sentAt: z.coerce.date(),
  profileHint: z
    .object({
      name: z.string().optional(),
      avatarUrl: z.string().optional(),
    })
    .optional(),
  /** source: 'ADS' hoặc giá trị khác do nền tảng gửi */
  referral: z
    .object({
      source: z.string().min(1),
      adId: z.string().optional(),
    })
    .optional(),
  raw: z.unknown(),
});
export type NormalizedInboundMessage = z.infer<typeof normalizedInboundMessageSchema>;

/**
 * Tin gửi đi (tối giản cho Giai đoạn 0). Sẽ được bổ sung ở Giai đoạn 1A
 * (reply_to, quick replies, tag Messenger...).
 */
export const outboundMessageSchema = z
  .object({
    text: z.string().optional(),
    attachments: z
      .array(
        z.object({
          type: z.enum(ATTACHMENT_TYPES),
          storageKey: z.string().min(1),
          mime: z.string().min(1),
        }),
      )
      .default([]),
  })
  .refine((m) => (m.text?.trim().length ?? 0) > 0 || m.attachments.length > 0, {
    message: 'Tin gửi đi phải có nội dung hoặc tệp đính kèm',
  });
export type OutboundMessage = z.infer<typeof outboundMessageSchema>;
