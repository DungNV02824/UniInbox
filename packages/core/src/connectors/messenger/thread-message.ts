// Chuyển tin đọc từ Conversations API -> NormalizedInboundMessage để đi chung luồng tin đến với webhook.
// id tin ("m_...") trùng mid của webhook => chống trùng theo (channel_account_id, external_message_id).
import type { InboundAttachment, NormalizedInboundMessage } from '@dezon/shared';
import { parseHttpUrl } from './attachments';
import type { GraphPerson, MessengerThreadAttachment, MessengerThreadMessage } from './conversations';

export interface ThreadMessageContext {
  channelAccountId: string;
  pageId: string;
  conversationId: string;
  /** Khách trong hội thoại (participant khác Page). */
  customer: GraphPerson;
}

const UNSUPPORTED_TEXT = '[Tin nhắn không hỗ trợ hiển thị]';

function typeOfMime(mime: string | undefined): InboundAttachment['type'] {
  if (mime?.startsWith('image/')) return 'image';
  if (mime?.startsWith('video/')) return 'video';
  if (mime?.startsWith('audio/')) return 'audio';
  return 'file';
}

function mapAttachment(att: MessengerThreadAttachment): InboundAttachment | undefined {
  const mime = att.mimeType;
  const name = att.name;
  const image = parseHttpUrl(att.image?.url);
  if (image) {
    return {
      url: image.toString(),
      type: 'image',
      ...(mime?.startsWith('image/') ? { mime } : {}),
      ...(name ? { name } : {}),
    };
  }
  const video = parseHttpUrl(att.videoUrl);
  if (video) {
    return {
      url: video.toString(),
      type: 'video',
      ...(mime?.startsWith('video/') ? { mime } : {}),
      ...(name ? { name } : {}),
    };
  }
  const file = parseHttpUrl(att.fileUrl);
  if (file) {
    return {
      url: file.toString(),
      type: typeOfMime(mime),
      ...(mime ? { mime } : {}),
      ...(name ? { name } : {}),
    };
  }
  return undefined;
}

/** l.facebook.com/l.php?u=<link thật> -> link thật (Graph bọc link chia sẻ qua trang chuyển hướng). */
export function unwrapFacebookRedirect(link: string): string {
  const url = parseHttpUrl(link);
  if (!url || !/^l[a-z]?\.facebook\.com$/.test(url.hostname)) return link;
  const target = parseHttpUrl(url.searchParams.get('u') ?? undefined);
  return target ? target.toString() : link;
}

function shareNotes(msg: MessengerThreadMessage): string[] {
  // Tin chia sẻ liên kết: `message` đã chứa link => không lặp lại.
  if (msg.text?.trim()) return [];
  return msg.shares
    .map((s) => {
      const link = s.link ? unwrapFacebookRedirect(s.link) : undefined;
      const label = [s.name?.trim(), link].filter(Boolean).join(' — ');
      return label ? `[Liên kết] ${label}` : '';
    })
    .filter((n) => n !== '');
}

/**
 * Tin do Page gửi (from = Page): direction 'out', senderType 'agent', externalUserId = khách.
 * Tin của khách: 'in' / 'customer'. Trả null nếu không xác định được khách.
 * raw KHÔNG có `message.app_id` (Conversations API không trả) và không chứa token.
 */
export function threadMessageToInbound(
  msg: MessengerThreadMessage,
  ctx: ThreadMessageContext,
): NormalizedInboundMessage | null {
  const fromPage = msg.from.id === ctx.pageId;
  if (!fromPage && msg.from.id !== ctx.customer.id) return null; // hội thoại nhóm/không rõ: bỏ qua

  const attachments: InboundAttachment[] = [];
  const notes: string[] = [];
  for (const att of msg.attachments) {
    const mapped = mapAttachment(att);
    if (mapped) attachments.push(mapped);
    else notes.push(att.name ? `[Tệp đính kèm] ${att.name}` : '[Tệp đính kèm không hỗ trợ]');
  }
  const sticker = parseHttpUrl(msg.sticker);
  if (sticker) attachments.push({ url: sticker.toString(), type: 'sticker' });
  notes.push(...shareNotes(msg));

  const parts = [msg.text, ...notes].filter((s): s is string => !!s && s.trim() !== '');
  let text = parts.length > 0 ? parts.join('\n') : undefined;
  if (!text && attachments.length === 0) text = UNSUPPORTED_TEXT;

  const name = ctx.customer.name ?? (fromPage ? undefined : msg.from.name);
  return {
    channelAccountId: ctx.channelAccountId,
    channelType: 'messenger',
    externalUserId: ctx.customer.id,
    externalMessageId: msg.id,
    direction: fromPage ? 'out' : 'in',
    senderType: fromPage ? 'agent' : 'customer',
    attachments,
    sentAt: msg.createdTime,
    ...(text !== undefined ? { text } : {}),
    ...(name ? { profileHint: { name } } : {}),
    raw: {
      source: 'sync',
      pageId: ctx.pageId,
      conversationId: ctx.conversationId,
      mid: msg.id,
      fromId: msg.from.id,
      createdTime: msg.createdTime.toISOString(),
    },
  };
}
