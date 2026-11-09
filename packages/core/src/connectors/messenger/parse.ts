// Chuẩn hóa webhook Page (object 'page') -> InboundEvent[] (docs/research/messenger-platform.md §3).
// Không ném lỗi với payload lạ: entry/event sai cấu trúc hoặc không nhận ra => bỏ qua.
import type { NormalizedInboundMessage } from '@dezon/shared';
import { z } from 'zod';
import type { AccountResolver, InboundEvent } from '../types';
import { mapAttachments } from './attachments';

const idSchema = z.union([z.string().min(1), z.number()]).transform(String);

const envelopeSchema = z.looseObject({
  object: z.literal('page'),
  entry: z.array(z.unknown()),
});

const entrySchema = z.looseObject({
  id: idSchema,
  time: z.number().optional(),
  messaging: z.array(z.unknown()).optional(),
  standby: z.array(z.unknown()).optional(),
});

const eventSchema = z.looseObject({
  sender: z.looseObject({ id: idSchema }),
  recipient: z.looseObject({ id: idSchema }),
  timestamp: z.number().optional(),
  message: z.unknown().optional(),
  delivery: z.unknown().optional(),
  read: z.unknown().optional(),
  postback: z.unknown().optional(),
  referral: z.unknown().optional(),
});
type MessagingEvent = z.infer<typeof eventSchema>;

const messageSchema = z.looseObject({
  mid: z.string().min(1).optional(),
  text: z.string().optional(),
  is_echo: z.boolean().optional(),
  is_deleted: z.boolean().optional(),
  attachments: z.array(z.unknown()).optional(),
  referral: z.unknown().optional(),
});

const referralSchema = z.looseObject({
  source: z.string().min(1),
  ad_id: idSchema.optional(),
});

const deliverySchema = z.looseObject({
  mids: z.array(z.string()).optional(),
  watermark: z.number().optional(),
});

const readSchema = z.looseObject({ watermark: z.number() });

const postbackSchema = z.looseObject({
  mid: z.string().min(1).optional(),
  title: z.string().optional(),
  referral: z.unknown().optional(),
});

/** Ngữ cảnh của một event: page, tài khoản đã tra, kênh nhận (messaging | standby). */
interface EventContext {
  pageId: string;
  channelAccountId: string;
  fromStandby: boolean;
  fallbackTime: number;
}

const UNSUPPORTED_TEXT = '[Tin nhắn không hỗ trợ hiển thị]';

function referralOf(...candidates: unknown[]): NormalizedInboundMessage['referral'] {
  for (const candidate of candidates) {
    const parsed = referralSchema.safeParse(candidate);
    if (parsed.success) {
      const { source, ad_id } = parsed.data;
      return ad_id ? { source, adId: ad_id } : { source };
    }
  }
  return undefined;
}

/** raw = event gốc + pageId (+ cờ standby). Giữ nguyên message.app_id/metadata cho pipeline. */
function rawOf(event: MessagingEvent, ctx: EventContext): Record<string, unknown> {
  return { ...event, pageId: ctx.pageId, ...(ctx.fromStandby ? { fromStandby: true } : {}) };
}

function baseMessage(event: MessagingEvent, ctx: EventContext) {
  return {
    channelAccountId: ctx.channelAccountId,
    channelType: 'messenger' as const,
    sentAt: new Date(event.timestamp ?? ctx.fallbackTime),
    raw: rawOf(event, ctx),
  };
}

function fromMessage(event: MessagingEvent, ctx: EventContext): InboundEvent | null {
  const parsed = messageSchema.safeParse(event.message);
  if (!parsed.success) return null;
  const msg = parsed.data;
  // Tin bị thu hồi / tin hệ thống (handoff Meta AI: không có mid) => bỏ qua.
  if (msg.is_deleted || !msg.mid) return null;

  const { attachments, notes } = mapAttachments(msg.attachments, msg.text);
  const textParts = [msg.text, ...notes].filter((s): s is string => !!s && s.trim() !== '');
  let text = textParts.length > 0 ? textParts.join('\n') : undefined;
  if (!text && attachments.length === 0) text = UNSUPPORTED_TEXT;

  const isEcho = msg.is_echo === true;
  const referral = isEcho ? undefined : referralOf(msg.referral, event.referral);
  const message: NormalizedInboundMessage = {
    ...baseMessage(event, ctx),
    // Echo: sender = page, recipient = khách (PSID).
    externalUserId: isEcho ? event.recipient.id : event.sender.id,
    externalMessageId: msg.mid,
    direction: isEcho ? 'out' : 'in',
    senderType: isEcho ? 'agent' : 'customer',
    attachments,
    ...(text !== undefined ? { text } : {}),
    ...(referral ? { referral } : {}),
  };
  return { kind: 'message', message };
}

function fromPostback(event: MessagingEvent, ctx: EventContext): InboundEvent | null {
  const parsed = postbackSchema.safeParse(event.postback);
  if (!parsed.success || !parsed.data.mid) return null;
  const { mid, title, referral: rawReferral } = parsed.data;
  const referral = referralOf(rawReferral, event.referral);
  const message: NormalizedInboundMessage = {
    ...baseMessage(event, ctx),
    externalUserId: event.sender.id,
    externalMessageId: mid,
    direction: 'in',
    senderType: 'customer',
    text: title?.trim() ? title : '[Bấm nút]',
    attachments: [],
    ...(referral ? { referral } : {}),
  };
  return { kind: 'message', message };
}

function fromEvent(event: MessagingEvent, ctx: EventContext): InboundEvent | null {
  if (event.message !== undefined) return fromMessage(event, ctx);
  if (event.postback !== undefined) return fromPostback(event, ctx);
  if (event.delivery !== undefined) {
    const parsed = deliverySchema.safeParse(event.delivery);
    if (!parsed.success) return null;
    const { mids, watermark } = parsed.data;
    return {
      kind: 'delivery',
      channelAccountId: ctx.channelAccountId,
      externalUserId: event.sender.id,
      externalMessageIds: mids ?? [],
      watermark: watermark !== undefined ? new Date(watermark) : null,
    };
  }
  if (event.read !== undefined) {
    const parsed = readSchema.safeParse(event.read);
    if (!parsed.success) return null;
    return {
      kind: 'read',
      channelAccountId: ctx.channelAccountId,
      externalUserId: event.sender.id,
      watermark: new Date(parsed.data.watermark),
    };
  }
  // messaging_referrals đứng riêng, reaction, handover, edit...: chưa xử lý ở 1A.
  return null;
}

export async function parseMessengerWebhook(
  body: unknown,
  resolveAccount: AccountResolver,
): Promise<InboundEvent[]> {
  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success) return [];

  const accounts = new Map<string, { id: string } | null>();
  const collected: { at: number; order: number; event: InboundEvent }[] = [];

  for (const rawEntry of envelope.data.entry) {
    const entry = entrySchema.safeParse(rawEntry);
    if (!entry.success) continue;
    const pageId = entry.data.id;
    if (!accounts.has(pageId)) accounts.set(pageId, await resolveAccount('messenger', pageId));
    const account = accounts.get(pageId);
    if (!account) continue; // Page không có trong hệ thống

    const fallbackTime = entry.data.time ?? Date.now();
    const lists: [unknown[] | undefined, boolean][] = [
      [entry.data.messaging, false],
      [entry.data.standby, true],
    ];
    for (const [list, fromStandby] of lists) {
      for (const rawEvent of list ?? []) {
        const event = eventSchema.safeParse(rawEvent);
        if (!event.success) continue;
        const ctx: EventContext = { pageId, channelAccountId: account.id, fromStandby, fallbackTime };
        const normalized = fromEvent(event.data, ctx);
        if (normalized) {
          collected.push({
            at: event.data.timestamp ?? fallbackTime,
            order: collected.length,
            event: normalized,
          });
        }
      }
    }
  }

  // Sau khi Meta gửi lại, thứ tự không bảo đảm => sắp theo timestamp (ổn định).
  collected.sort((a, b) => a.at - b.at || a.order - b.order);
  return collected.map((c) => c.event);
}
