import type { ReactNode } from 'react';
import { safeColor } from '@/lib/inbox-format';
import { cn } from '@/lib/utils';

/** Chip lọc bật/tắt; `color` hiển thị chấm màu của kênh. */
export function FilterChip({
  label,
  active = false,
  color,
  disabled,
  title,
  onClick,
  icon,
}: {
  label: string;
  active?: boolean;
  color?: string;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        active
          ? 'border-brand bg-brand/10 font-medium text-brand'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {color && (
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: safeColor(color) }}
          aria-hidden
        />
      )}
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}
