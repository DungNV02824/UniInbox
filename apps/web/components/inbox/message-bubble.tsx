'use client';

import { memo } from 'react';
import { AlertCircle, Check, CheckCheck, Clock, RotateCw } from 'lucide-react';
import type { MessageStatus } from '@dezon/shared';
import { Button } from '@/components/ui/button';
import { botSenderLabel } from '@/lib/inbox-ai';
import { isTempMessage, type ChatMessage } from '@/lib/inbox-cache';
import { formatClock, formatDateTime, MESSAGE_STATUS_LABELS } from '@/lib/inbox-format';
import { sendErrorHint } from '@/lib/send-error-hint';
import { cn } from '@/lib/utils';
import { MessageAttachments } from './message-attachments';

function StatusIcon({ status }: { status: MessageStatus }) {
  const label = MESSAGE_STATUS_LABELS[status];
  const cls = 'size-3.5';
  switch (status) {
    case 'queued':
      return <Clock className={cls} aria-label={label} />;
    case 'sent':
      return <Check className={cls} aria-label={label} />;
    case 'delivered':
      return <CheckCheck className={cls} aria-label={label} />;
    case 'seen':
      return <CheckCheck className={cn(cls, 'text-brand')} aria-label={label} />;
    case 'failed':
      return <AlertCircle className={cn(cls, 'text-destructive')} aria-label={label} />;
    default:
      return null;
  }
}

/** Tên người gửi phía shop: nhân viên, nhãn phụ (vd. "Meta Business Suite") hoặc "AI · <tên bot>". */
export function senderName(m: ChatMessage): string | null {
  if (m.senderType === 'bot') return botSenderLabel(m);
  if (m.senderType !== 'agent') return null;
  return m.senderUser?.name ?? m.senderLabel ?? 'Nhân viên';
}

export const MessageBubble = memo(function MessageBubble({
  message: m,
  showSender,
  onRetry,
  onMediaLoad,
}: {
  message: ChatMessage;
  /** Hiện tên người gửi (khi khác người gửi tin trước). */
  showSender: boolean;
  onRetry: (m: ChatMessage) => void;
  onMediaLoad?: () => void;
}) {
  if (m.senderType === 'system') {
    return (
      <div className="flex justify-center py-1">
        <p className="max-w-[85%] rounded-full bg-muted px-3 py-1 text-center text-xs text-muted-foreground">
          {m.text}
        </p>
      </div>
    );
  }

  const outbound = m.senderType === 'agent' || m.senderType === 'bot';
  const bot = m.senderType === 'bot';
  const failed = m.status === 'failed';
  const hint = failed ? sendErrorHint(m.error) : null;
  const name = senderName(m);

  return (
    <div className={cn('flex flex-col gap-1', outbound ? 'items-end' : 'items-start')}>
      {showSender && name && (
        <span className="flex items-center gap-1 px-1 text-xs text-muted-foreground">
          {bot ? (
            <span className="rounded bg-violet-100 px-1.5 py-px text-[11px] font-semibold text-violet-700">
              {name}
            </span>
          ) : (
            name
          )}
        </span>
      )}
      <MessageAttachments
        attachments={m.attachments}
        outbound={outbound}
        conversationId={isTempMessage(m) ? undefined : m.conversationId}
        onMediaLoad={onMediaLoad}
      />
      {m.text && (
        <div
          className={cn(
            'max-w-[85%] rounded-2xl px-3 py-2 text-sm break-words whitespace-pre-wrap sm:max-w-[75%]',
            !outbound && 'rounded-bl-md bg-muted text-foreground',
            outbound && !bot && 'rounded-br-md bg-brand text-brand-foreground',
            bot && 'rounded-br-md border border-violet-200 bg-violet-50 text-violet-950',
            failed && 'opacity-80 ring-2 ring-destructive/60',
          )}
        >
          {m.text}
        </div>
      )}
      <div className="flex items-center gap-1 px-1 text-[11px] text-muted-foreground">
        <time dateTime={m.sentAt} title={formatDateTime(m.sentAt)}>
          {formatClock(m.sentAt)}
        </time>
        {outbound && <StatusIcon status={m.status} />}
        {outbound && m.status === 'queued' && <span>Đang gửi...</span>}
      </div>
      {failed && (
        <div className="flex max-w-[85%] flex-wrap items-center justify-end gap-2 px-1 text-xs text-destructive">
          <span>{m.error || 'Gửi tin thất bại'}</span>
          {hint && <span className="basis-full text-right text-[11px] text-muted-foreground">{hint}</span>}
          {m.pending && (
            <Button variant="outline" size="sm" className="h-7" onClick={() => onRetry(m)}>
              <RotateCw aria-hidden />
              Gửi lại
            </Button>
          )}
        </div>
      )}
    </div>
  );
});
