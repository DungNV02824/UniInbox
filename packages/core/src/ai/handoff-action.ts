// Thông báo Lark khi nhân viên bấm hai nút trên banner "Cần người" (bot bật handoff_action_lark).
import { channelAccounts, chatbots, contacts, conversations, handoffs, users, type Db } from '@dezon/db';
import { DEFAULT_HANDOFF_ACK_LABEL, DEFAULT_HANDOFF_RESOLVE_LABEL } from '@dezon/shared';
import { asc, eq, inArray } from 'drizzle-orm';
import type { HandoffActionCardInput } from './lark';

const VN_TIME = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh',
  hour: '2-digit',
  minute: '2-digit',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour12: false,
});

/** "14:36 10/11/2026" (giờ Việt Nam). */
export function formatVnDateTime(d: Date): string {
  const parts = Object.fromEntries(VN_TIME.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.hour}:${parts.minute} ${parts.day}/${parts.month}/${parts.year}`;
}

export interface HandoffActionNoticeInput {
  conversationId: string;
  action: 'ack' | 'resolve';
  /** Handoff vừa ack / vừa đóng ở lần bấm này; rỗng ⇒ không báo (bấm lại). */
  handoffIds: readonly string[];
  actorUserId: string;
  now: Date;
  /** `${APP_URL}` — nút "Mở hội thoại". */
  appUrl: string;
}

/**
 * Dữ liệu thẻ Lark cho lần bấm nút; null khi không cần báo: không có handoff mới, hội thoại không gắn bot,
 * hoặc bot không bật handoff_action_lark.
 */
export async function loadHandoffActionNotice(
  db: Db,
  input: HandoffActionNoticeInput,
): Promise<HandoffActionCardInput | null> {
  if (input.handoffIds.length === 0) return null;
  const [row] = await db
    .select({
      contactName: contacts.displayName,
      channelName: channelAccounts.displayName,
      chatbotName: chatbots.name,
      notify: chatbots.handoffActionLark,
      ackLabel: chatbots.handoffAckLabel,
      resolveLabel: chatbots.handoffResolveLabel,
    })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .innerJoin(channelAccounts, eq(channelAccounts.id, conversations.channelAccountId))
    .innerJoin(chatbots, eq(chatbots.id, conversations.chatbotId))
    .where(eq(conversations.id, input.conversationId));
  if (!row?.notify) return null;

  const [items, [actor]] = await Promise.all([
    db
      .select({ summary: handoffs.summary })
      .from(handoffs)
      .where(inArray(handoffs.id, [...input.handoffIds]))
      .orderBy(asc(handoffs.createdAt)),
    db.select({ name: users.name }).from(users).where(eq(users.id, input.actorUserId)),
  ]);

  const buttonLabel =
    input.action === 'ack'
      ? (row.ackLabel ?? DEFAULT_HANDOFF_ACK_LABEL)
      : (row.resolveLabel ?? DEFAULT_HANDOFF_RESOLVE_LABEL);
  return {
    action: input.action,
    buttonLabel,
    contactName: row.contactName ?? 'Khách',
    channelName: row.channelName,
    chatbotName: row.chatbotName,
    actorName: actor?.name ?? 'Nhân viên',
    at: formatVnDateTime(input.now),
    summaries: items.map((i) => i.summary).filter((s) => s.trim() !== ''),
    conversationUrl: `${input.appUrl.replace(/\/+$/, '')}/inbox/${input.conversationId}`,
  };
}
