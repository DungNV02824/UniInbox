import Link from 'next/link';
import { PauseCircle, TriangleAlert, UserRound } from 'lucide-react';
import { isAiPausedIndefinitely, type ConversationSummary } from '@dezon/shared';
import { Avatar } from '@/components/ui/avatar';
import { contactTagsOf } from '@/lib/contact-tags';
import { conversationAiState, handoffReasonLabel } from '@/lib/inbox-ai';
import {
  CHANNEL_TYPE_LABELS,
  formatDateTime,
  formatPreview,
  formatRelativeTime,
  safeColor,
} from '@/lib/inbox-format';
import { cn } from '@/lib/utils';
import { ConversationPreviewText } from './ai-typing';
import { ContactTagChips } from './contact-tag-chips';

const ROW_TAGS_MAX = 2;

/**
 * Một dòng trong danh sách hội thoại (gọn): tên + nhãn khách + giờ / kênh (chấm màu) + người phụ trách /
 * xem trước 1 dòng + số tin chưa đọc.
 */
export function ConversationRow({
  conversation: c,
  active,
  now,
  viewerId,
}: {
  conversation: ConversationSummary;
  active: boolean;
  now: number;
  viewerId?: string;
}) {
  const unread = c.unreadCount > 0;
  const tags = contactTagsOf(c.contact);
  const time = c.lastMessage?.sentAt ?? c.lastMessageAt;
  const channelTitle = `${CHANNEL_TYPE_LABELS[c.channel.type]} · ${c.channel.displayName}`;
  const aiState = conversationAiState(c, now);
  const handoffTitle = c.handoff
    ? `Cần người: ${handoffReasonLabel(c.handoff.reasonCode)}${c.handoff.acknowledgedBy ? ` · đã nhận bởi ${c.handoff.acknowledgedBy.name}` : ''}`
    : 'Cần người xử lý';
  return (
    <Link
      href={`/inbox/${c.id}`}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex items-start gap-2.5 rounded-lg px-2 py-2 outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
        active && 'bg-brand/10 hover:bg-brand/15',
      )}
    >
      <Avatar src={c.contact.avatarUrl} name={c.contact.displayName} className="mt-0.5 size-9 text-[13px]" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span
            className={cn('min-w-0 truncate text-sm leading-5', unread ? 'font-semibold' : 'font-medium')}
          >
            {c.contact.displayName}
          </span>
          {/* Nhãn khách cạnh tên: tối đa 2 chip, chiếm tối đa ~một nửa dòng để tên vẫn đọc được. */}
          <ContactTagChips
            tags={tags}
            max={ROW_TAGS_MAX}
            className="max-w-[55%] shrink-0 overflow-hidden"
            chipClassName="max-w-[6.5rem]"
          />
          {aiState === 'handoff' && (
            <TriangleAlert
              className={cn(
                'size-3.5 shrink-0',
                c.handoff?.acknowledgedBy ? 'text-amber-600' : 'text-red-600',
              )}
              aria-label={handoffTitle}
            >
              <title>{handoffTitle}</title>
            </TriangleAlert>
          )}
          {time && (
            <time
              dateTime={time}
              title={formatDateTime(time)}
              className={cn(
                'ml-auto shrink-0 pl-1 text-[11px]',
                unread ? 'font-medium text-brand' : 'text-muted-foreground',
              )}
            >
              {formatRelativeTime(time, new Date(now))}
            </time>
          )}
        </div>
        {/* Tên kênh hiện đủ (để phân biệt các Trang tên gần giống nhau); người phụ trách co lại nhường chỗ. */}
        <div className="flex min-w-0 items-center gap-2 text-[11px] leading-4 text-muted-foreground">
          <span className="flex max-w-full min-w-0 shrink-0 items-center gap-1" title={channelTitle}>
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: safeColor(c.channel.color) }}
              aria-hidden
            />
            <span className="truncate font-medium text-foreground/75">{c.channel.displayName}</span>
          </span>
          {c.chatbot && (
            <span
              className={cn(
                'flex max-w-[45%] min-w-0 items-center gap-0.5 rounded px-1 text-[10px] leading-4 font-medium',
                aiState === 'active' ? 'bg-violet-100 text-violet-700' : 'bg-muted text-muted-foreground',
              )}
              title={
                aiState === 'paused'
                  ? isAiPausedIndefinitely(c.aiPausedUntil)
                    ? `Chatbot ${c.chatbot.name} · đã dừng vì nhân viên nhắn tin`
                    : `Chatbot ${c.chatbot.name} · tạm dừng vì nhân viên vừa nhắn`
                  : aiState === 'active'
                    ? `Chatbot ${c.chatbot.name} đang trả lời`
                    : `Chatbot ${c.chatbot.name} · đang tắt cho hội thoại này`
              }
            >
              <span aria-hidden>🤖</span>
              <span className="sr-only">Chatbot: </span>
              <span className="truncate">{c.chatbot.name}</span>
              {aiState === 'paused' && <PauseCircle className="size-3 shrink-0" aria-label="AI tạm dừng" />}
            </span>
          )}
          {c.assignedUser && (
            <span
              className="flex min-w-0 items-center gap-0.5"
              title={`Người phụ trách: ${c.assignedUser.name}`}
            >
              <UserRound className="size-3 shrink-0" aria-hidden />
              <span className="sr-only">Người phụ trách: </span>
              <span className="truncate">{c.assignedUser.id === viewerId ? 'Bạn' : c.assignedUser.name}</span>
            </span>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <ConversationPreviewText
            conversationId={c.id}
            preview={formatPreview(c.lastMessage, viewerId)}
            className={cn(
              'min-w-0 flex-1 truncate text-xs leading-4',
              unread ? 'font-medium text-foreground' : 'text-muted-foreground',
            )}
          />
          {unread && (
            <span
              className="ml-auto inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-semibold text-brand-foreground"
              aria-label={`${c.unreadCount} tin chưa đọc`}
            >
              {c.unreadCount > 99 ? '99+' : c.unreadCount}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
