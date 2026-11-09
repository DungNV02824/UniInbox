import { MessagesSquare } from 'lucide-react';
import { cn } from '@/lib/utils';

export function BrandLogo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-semibold tracking-tight', className)}>
      <span className="flex size-8 items-center justify-center rounded-lg bg-brand text-brand-foreground">
        <MessagesSquare className="size-4" aria-hidden />
      </span>
      <span>
        Dezon <span className="text-brand">Inbox</span>
      </span>
    </span>
  );
}
