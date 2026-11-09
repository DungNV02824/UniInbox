import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Khung một cột của hộp thư: tiêu đề cố định + nội dung cuộn được. */
export function Panel({
  title,
  actions,
  children,
  className,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex min-h-0 flex-col bg-background', className)} aria-label={title}>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
      </div>
      {/* `relative`: phần tử absolute bên trong (vd. sr-only) tính theo vùng cuộn này, không đẩy dài cả trang. */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
        {children}
      </div>
    </section>
  );
}
