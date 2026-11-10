'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bot, Plug, SlidersHorizontal, Tags } from 'lucide-react';
import { cn } from '@/lib/utils';

const ITEMS = [
  { href: '/admin/channels', label: 'Kênh', icon: Plug },
  { href: '/admin/chatbots', label: 'Chatbot AI', icon: Bot },
  { href: '/admin/tags', label: 'Nhãn khách', icon: Tags },
  { href: '/admin/settings', label: 'Cài đặt', icon: SlidersHorizontal },
] as const;

/** Thanh mục quản trị (dính trên cùng vùng cuộn). Chiều cao h-11 — trang con dùng top-11 khi cần dính. */
export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Mục quản trị"
      className="sticky top-0 z-20 h-11 shrink-0 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
    >
      <ul className="flex h-full w-full items-stretch gap-1 overflow-x-auto overflow-y-hidden px-1.5 [scrollbar-width:none] sm:px-2.5">
        {ITEMS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href} className="flex">
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative flex items-center gap-1.5 rounded-md px-3 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  active ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="size-4" aria-hidden />
                {label}
                {active && (
                  <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand" aria-hidden />
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
