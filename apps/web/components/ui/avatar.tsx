'use client';

import { useState } from 'react';
import { initials } from '@/lib/inbox-format';
import { cn } from '@/lib/utils';

/** Avatar tròn: ảnh nếu có (lỗi tải thì về chữ cái đầu), không thì chữ cái đầu của tên. */
export function Avatar({ src, name, className }: { src?: string | null; name: string; className?: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = !!src && failedSrc !== src;
  return (
    <span
      className={cn(
        'relative inline-flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-sm font-medium text-muted-foreground select-none',
        className,
      )}
      aria-hidden
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- URL ký có thời hạn từ S3, không qua next/image
        <img src={src} alt="" className="size-full object-cover" onError={() => setFailedSrc(src)} />
      ) : (
        initials(name)
      )}
    </span>
  );
}
