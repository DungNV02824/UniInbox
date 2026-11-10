'use client';

import type { ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

export function FieldError({ id, message }: { id?: string; message?: string | null }) {
  if (!message) return null;
  return (
    <p id={id} className="flex items-start gap-1 text-xs text-destructive">
      <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden />
      {message}
    </p>
  );
}

/** Nhãn + ô nhập + gợi ý + lỗi. `htmlFor` phải trùng id của ô nhập. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  errorId,
  aside,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | null;
  errorId?: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex min-h-5 items-center gap-2">
        <Label htmlFor={htmlFor}>{label}</Label>
        {aside && <div className="ml-auto flex items-center gap-2">{aside}</div>}
      </div>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      <FieldError id={errorId} message={error} />
    </div>
  );
}

/** "12.345 / 100.000 ký tự" — chuyển màu khi gần/vượt giới hạn. */
export function CharCounter({ value, max, className }: { value: string; max: number; className?: string }) {
  const len = value.length;
  const ratio = len / max;
  return (
    <span
      className={cn(
        'text-xs tabular-nums',
        ratio > 1
          ? 'font-medium text-destructive'
          : ratio > 0.9
            ? 'text-amber-600 dark:text-amber-400'
            : 'text-muted-foreground',
        className,
      )}
      aria-live="polite"
    >
      {len.toLocaleString('vi-VN')} / {max.toLocaleString('vi-VN')} ký tự
    </span>
  );
}

/** Khung chú thích nhỏ (mẹo, giải thích). */
export function Callout({
  icon: Icon,
  title,
  children,
  tone = 'muted',
}: {
  icon?: typeof AlertCircle;
  title?: ReactNode;
  children: ReactNode;
  tone?: 'muted' | 'brand' | 'warn';
}) {
  return (
    <div
      className={cn(
        'flex gap-2.5 rounded-lg border px-3 py-2.5 text-xs leading-relaxed',
        tone === 'brand' && 'border-brand/20 bg-brand/5 text-foreground',
        tone === 'warn' &&
          'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100',
        tone === 'muted' && 'bg-muted/50 text-muted-foreground',
      )}
    >
      {Icon && <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
      <div className="flex min-w-0 flex-col gap-1">
        {title && <p className="font-medium text-foreground">{title}</p>}
        {children}
      </div>
    </div>
  );
}
