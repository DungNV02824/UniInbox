'use client';

import { useMemo } from 'react';
import { TagChip } from '@/components/tag-chip';
import { buildTagIndex, findCatalogTag, splitVisibleTags } from '@/lib/contact-tags';
import { useContactTags } from '@/lib/contact-tags-api';
import { cn } from '@/lib/utils';

/**
 * Nhãn khách dạng chip nhỏ cạnh tên (danh sách hội thoại, đầu khung chat): `max` chip đầu + "+N".
 * Màu theo danh sách nhãn; nhãn cũ/ngoài danh sách màu xám nét đứt. Rê chuột thấy đủ mọi nhãn.
 */
export function ContactTagChips({
  tags,
  max,
  className,
  chipClassName,
}: {
  tags: readonly string[];
  max: number;
  className?: string;
  /** Giới hạn bề rộng mỗi chip (chữ bị cắt "..."). */
  chipClassName?: string;
}) {
  const catalogQuery = useContactTags();
  const index = useMemo(() => buildTagIndex(catalogQuery.data ?? []), [catalogQuery.data]);
  if (tags.length === 0) return null;
  const { visible, overflow } = splitVisibleTags(tags, max);
  const all = tags.join(', ');
  return (
    <span className={cn('flex min-w-0 items-center', className)} title={`Nhãn: ${all}`}>
      <span className="sr-only">Nhãn: {all}</span>
      <span className="flex min-w-0 items-center gap-1" aria-hidden>
        {visible.map((name) => {
          const tag = findCatalogTag(index, name);
          // Danh sách chưa tải xong thì chưa coi là nhãn cũ.
          const legacy = !tag && catalogQuery.isSuccess;
          return (
            <TagChip
              key={name}
              name={tag?.name ?? name}
              color={tag ? tag.color : legacy ? null : 'gray'}
              className={cn('shrink px-1.5 py-0 text-[10px] leading-4', chipClassName)}
            />
          );
        })}
        {overflow > 0 && (
          <span className="shrink-0 rounded-full border bg-muted px-1 text-[10px] leading-4 font-medium text-muted-foreground">
            +{overflow}
          </span>
        )}
      </span>
    </span>
  );
}
