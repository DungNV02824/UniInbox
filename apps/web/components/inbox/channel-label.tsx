import type { ChannelBadge } from '@dezon/shared';
import { CHANNEL_TYPE_LABELS, safeColor } from '@/lib/inbox-format';
import { cn } from '@/lib/utils';

/** Nhãn kênh màu: chấm màu + tên tài khoản kênh trên nền nhạt cùng màu (chữ luôn đủ tương phản). */
export function ChannelLabel({
  channel,
  className,
}: {
  channel: Pick<ChannelBadge, 'type' | 'displayName' | 'color'>;
  className?: string;
}) {
  const color = safeColor(channel.color);
  return (
    <span
      className={cn(
        'inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] leading-none font-medium text-foreground',
        className,
      )}
      style={{ backgroundColor: `${color}1f`, borderColor: `${color}66` }}
      title={`${CHANNEL_TYPE_LABELS[channel.type]} · ${channel.displayName}`}
    >
      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      <span className="truncate">{channel.displayName}</span>
    </span>
  );
}
