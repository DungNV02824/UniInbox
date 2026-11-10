'use client';

import { useId, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Biểu tượng "i" hiện chú thích ngắn khi rê chuột hoặc focus bằng bàn phím. */
export function InfoTip({
  children,
  label = 'Giải thích',
  className,
  side = 'top',
}: {
  children: ReactNode;
  label?: string;
  className?: string;
  side?: 'top' | 'bottom';
}) {
  const id = useId();
  return (
    <span className={cn('group/tip relative inline-flex', className)}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={id}
        className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <Info className="size-3.5" aria-hidden />
      </button>
      <span
        role="tooltip"
        id={id}
        className={cn(
          'pointer-events-none invisible absolute left-1/2 z-40 w-60 -translate-x-1/2 rounded-md bg-foreground px-2.5 py-1.5 text-xs leading-snug font-normal text-background opacity-0 shadow-md transition-opacity group-focus-within/tip:visible group-focus-within/tip:opacity-100 group-hover/tip:visible group-hover/tip:opacity-100',
          side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
        )}
      >
        {children}
      </span>
    </span>
  );
}
