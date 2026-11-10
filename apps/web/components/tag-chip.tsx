import type { ReactNode } from 'react';
import { tagChipClass } from '@/lib/tag-colors';
import { cn } from '@/lib/utils';

/** Chip nhãn khách có màu. `color` null = nhãn cũ ngoài danh sách (xám nét đứt). */
export function TagChip({
  name,
  color,
  title,
  className,
  children,
}: {
  name: string;
  color: string | null | undefined;
  title?: string;
  className?: string;
  /** Phần thêm sau tên (vd. nút ×). */
  children?: ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        tagChipClass(color),
        className,
      )}
    >
      <span className="truncate">{name}</span>
      {children}
    </span>
  );
}
