'use client';

import { useId } from 'react';
import { Check } from 'lucide-react';
import { TAG_COLOR_LABELS, TAG_COLORS, type TagColor } from '@dezon/shared';
import { TAG_SWATCH_CLASSES } from '@/lib/tag-colors';
import { cn } from '@/lib/utils';

/** Chọn 1 trong 10 màu nhãn: nhóm radio thật (Tab vào nhóm, ←/→ đổi màu), mỗi ô có tên màu. */
export function TagColorPicker({
  value,
  onChange,
  label = 'Màu nhãn',
  disabled,
}: {
  value: TagColor;
  onChange: (color: TagColor) => void;
  label?: string;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5" disabled={disabled}>
      <legend className="sr-only">{label}</legend>
      <div className="flex flex-wrap items-center gap-1.5">
        {TAG_COLORS.map((color) => {
          const checked = value === color;
          const text = TAG_COLOR_LABELS[color];
          return (
            <label
              key={color}
              title={text}
              className="relative cursor-pointer has-disabled:cursor-not-allowed"
            >
              <input
                type="radio"
                name={name}
                value={color}
                checked={checked}
                onChange={() => onChange(color)}
                className="peer sr-only"
                aria-label={text}
              />
              <span
                className={cn(
                  'flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-background transition-shadow peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/60 peer-disabled:opacity-50',
                  TAG_SWATCH_CLASSES[color],
                  checked && 'ring-2 ring-foreground/70',
                )}
                aria-hidden
              >
                {checked && <Check className="size-4 text-white" />}
              </span>
            </label>
          );
        })}
        <span className="ml-1 text-xs text-muted-foreground" aria-hidden>
          {TAG_COLOR_LABELS[value]}
        </span>
      </div>
    </fieldset>
  );
}
