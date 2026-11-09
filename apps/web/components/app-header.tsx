'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Inbox, Loader2, LogOut, Settings } from 'lucide-react';
import { BrandLogo } from '@/components/brand-logo';
import { clearDrafts } from '@/components/inbox/composer-drafts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ROLE_LABELS, RoleGate, useAuth } from '@/lib/auth';

export function AppHeader() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const inAdmin = pathname.startsWith('/admin');
  const queryClient = useQueryClient();
  const [leaving, setLeaving] = useState(false);

  async function onLogout() {
    setLeaving(true);
    await logout();
    queryClient.clear();
    clearDrafts();
    router.replace('/login');
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-3 sm:px-4">
      <Link href="/inbox" aria-label="Về hộp thư">
        <BrandLogo />
      </Link>

      <nav className="ml-2 hidden items-center gap-1 sm:flex" aria-label="Điều hướng chính">
        <Button variant={inAdmin ? 'ghost' : 'secondary'} size="sm" asChild>
          <Link href="/inbox" aria-current={inAdmin ? undefined : 'page'}>
            <Inbox aria-hidden />
            Hộp thư
          </Link>
        </Button>
        {/* Mục quản trị chỉ hiện với admin. */}
        <RoleGate roles={['admin']}>
          <Button variant={inAdmin ? 'secondary' : 'ghost'} size="sm" asChild>
            <Link href="/admin/channels" aria-current={inAdmin ? 'page' : undefined}>
              <Settings aria-hidden />
              Quản trị
            </Link>
          </Button>
        </RoleGate>
      </nav>

      <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-3">
        <RoleGate roles={['admin']}>
          <Button variant="ghost" size="icon" className="size-8 sm:hidden" asChild>
            <Link href={inAdmin ? '/inbox' : '/admin/channels'} aria-label={inAdmin ? 'Hộp thư' : 'Quản trị'}>
              {inAdmin ? <Inbox aria-hidden /> : <Settings aria-hidden />}
            </Link>
          </Button>
        </RoleGate>
        {user && (
          <div className="flex min-w-0 items-center gap-2">
            <span className="hidden truncate text-sm font-medium sm:inline" title={user.email}>
              {user.name}
            </span>
            <Badge variant={user.role === 'admin' ? 'brand' : 'secondary'}>{ROLE_LABELS[user.role]}</Badge>
          </div>
        )}
        <Button variant="outline" size="sm" onClick={onLogout} disabled={leaving}>
          {leaving ? <Loader2 className="animate-spin" aria-hidden /> : <LogOut aria-hidden />}
          <span className="hidden sm:inline">Đăng xuất</span>
          <span className="sr-only sm:hidden">Đăng xuất</span>
        </Button>
      </div>
    </header>
  );
}
