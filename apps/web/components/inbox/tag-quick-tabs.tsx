'use client';

import { useContactTags } from '@/lib/contact-tags-api';
import { TAG_CHIP_CLASSES, TAG_SWATCH_CLASSES, isTagColor, LEGACY_TAG_SWATCH_CLASS } from '@/lib/tag-colors';
import { cn } from '@/lib/utils';

/**
 * Hàng nhãn bấm nhanh dưới "Tất cả / Chưa đọc / Của tôi": bấm một nhãn để chỉ xem khách có nhãn đó,
 * bấm lại (hoặc "Mọi nhãn") để bỏ lọc. Ẩn khi chưa có nhãn nào. Cuộn ngang khi nhiều nhãn.
 */
export function TagQuickTabs({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (tag: string | undefined) => void;
}) {
  const tags = useContactTags();
  const list = tags.data ?? [];
  const want = value?.toLowerCase();
  // Nhãn đang lọc đã bị xóa/đổi tên: vẫn hiện để bỏ chọn được.
  const missing = value && !list.some((t) => t.name.toLowerCase() === want) ? value : null;
  if (list.length === 0 && !missing) return null;

  const chip =
    'inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs whitespace-nowrap outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50';
  return (
    <div
      className="-mx-3 flex items-center gap-1 overflow-x-auto px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      // Lăn chuột dọc ⇒ cuộn ngang (thanh cuộn đã ẩn cho gọn).
      onWheel={(e) => {
        const el = e.currentTarget;
        if (el.scrollWidth > el.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX))
          el.scrollLeft += e.deltaY;
      }}
      role="group"
      aria-label="Lọc theo nhãn khách"
    >
      <button
        type="button"
        aria-pressed={!value}
        onClick={() => onChange(undefined)}
        className={cn(
          chip,
          !value
            ? 'border-brand bg-brand/10 font-medium text-brand'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        Mọi nhãn
      </button>
      {list.map((t) => {
        const active = t.name.toLowerCase() === want;
        const color = isTagColor(t.color) ? t.color : null;
        return (
          <button
            key={t.id}
            type="button"
            aria-pressed={active}
            title={active ? `Bỏ lọc nhãn ${t.name}` : `Chỉ xem khách có nhãn ${t.name}`}
            onClick={() => onChange(t.name)}
            className={cn(
              chip,
              active
                ? cn(
                    color ? TAG_CHIP_CLASSES[color] : 'border-brand bg-brand/10 text-brand',
                    'font-semibold ring-1 ring-current',
                  )
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <span
              className={cn(
                'size-2 shrink-0 rounded-full',
                color ? TAG_SWATCH_CLASSES[color] : LEGACY_TAG_SWATCH_CLASS,
              )}
              aria-hidden
            />
            <span className="max-w-[9rem] truncate">{t.name}</span>
          </button>
        );
      })}
      {missing && (
        <button
          type="button"
          aria-pressed
          onClick={() => onChange(undefined)}
          className={cn(chip, 'border-brand bg-brand/10 font-semibold text-brand')}
        >
          {missing}
        </button>
      )}
    </div>
  );
}
