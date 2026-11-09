'use client';

import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Màu gợi ý cho nhãn kênh (dễ phân biệt, đủ đậm trên nền trắng). */
export const SUGGESTED_COLORS = [
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#dc2626',
  '#ea580c',
  '#ca8a04',
  '#16a34a',
  '#0891b2',
  '#475569',
] as const;

/** Chọn màu: vài màu gợi ý + ô màu tự do. `value` undefined = để hệ thống tự chọn. */
export function ColorPicker({
  value,
  onChange,
  allowAuto = false,
  id,
}: {
  value: string | undefined;
  onChange: (color: string | undefined) => void;
  allowAuto?: boolean;
  id?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Màu nhãn kênh">
      {allowAuto && (
        <button
          type="button"
          onClick={() => onChange(undefined)}
          aria-pressed={value === undefined}
          className={cn(
            'h-7 rounded-full border px-2.5 text-xs',
            value === undefined
              ? 'border-brand bg-brand/10 text-brand'
              : 'text-muted-foreground hover:bg-accent',
          )}
        >
          Tự động
        </button>
      )}
      {SUGGESTED_COLORS.map((c) => {
        const active = value?.toLowerCase() === c;
        return (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            aria-pressed={active}
            aria-label={`Màu ${c}`}
            title={c}
            className={cn(
              'flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-background transition-shadow',
              active && 'ring-2 ring-foreground/60',
            )}
            style={{ backgroundColor: c }}
          >
            {active && <Check className="size-4 text-white" aria-hidden />}
          </button>
        );
      })}
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <input
          id={id}
          type="color"
          value={value ?? '#2563eb'}
          onChange={(e) => onChange(e.target.value)}
          className="size-7 cursor-pointer rounded border bg-transparent p-0.5"
          aria-label="Chọn màu khác"
        />
        Màu khác
      </label>
    </div>
  );
}
