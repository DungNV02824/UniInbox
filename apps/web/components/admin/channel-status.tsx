import type { ChannelAccountStatus, ChannelType } from '@dezon/shared';
import { PLATFORM_LABELS } from '@/lib/channel-groups';
import { cn } from '@/lib/utils';

const STATUS: Record<ChannelAccountStatus, { label: string; className: string; dot: string }> = {
  connected: {
    label: 'Đang hoạt động',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    dot: 'bg-emerald-500',
  },
  expired: { label: 'Hết hạn', className: 'border-red-200 bg-red-50 text-red-700', dot: 'bg-red-500' },
  error: { label: 'Lỗi', className: 'border-red-200 bg-red-50 text-red-700', dot: 'bg-red-500' },
  disconnected: {
    label: 'Đã ngắt kết nối',
    className: 'border-border bg-muted text-muted-foreground',
    dot: 'bg-slate-400',
  },
};

/** Viên trạng thái kênh; `detail` (vd. lỗi gần nhất) hiện ở tooltip. */
export function ChannelStatusBadge({
  status,
  detail,
}: {
  status: ChannelAccountStatus;
  detail?: string | null;
}) {
  const s = STATUS[status];
  return (
    <span
      className={cn(
        'inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        s.className,
      )}
      title={detail || undefined}
    >
      <span className={cn('size-1.5 rounded-full', s.dot)} aria-hidden />
      {s.label}
    </span>
  );
}

const PLATFORM_MARK: Record<ChannelType, { letter: string; className: string }> = {
  messenger: { letter: 'f', className: 'bg-[#1877F2]' },
  zalo_oa: { letter: 'Z', className: 'bg-[#0068FF]' },
  zalo_personal: { letter: 'Z', className: 'bg-[#0068FF]' },
};

/** Huy hiệu nền tảng: logo chữ + tên ("Facebook", "Zalo OA"). */
export function PlatformBadge({ type, className }: { type: ChannelType; className?: string }) {
  const mark = PLATFORM_MARK[type];
  return (
    <span
      className={cn(
        'inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border bg-background px-2 py-0.5 text-xs font-medium text-foreground/80',
        className,
      )}
    >
      <span
        className={cn(
          'inline-flex size-3.5 items-center justify-center rounded-full text-[9px] leading-none font-bold text-white',
          mark.className,
        )}
        aria-hidden
      >
        {mark.letter}
      </span>
      {PLATFORM_LABELS[type]}
    </span>
  );
}
