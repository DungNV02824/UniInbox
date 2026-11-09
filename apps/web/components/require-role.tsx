'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import type { UserRole } from '@dezon/shared';
import { useAuth } from '@/lib/auth';

/** Chặn trang theo vai trò (dùng bên trong RequireAuth): không đủ quyền thì chuyển về `redirectTo`. */
export function RequireRole({
  roles,
  redirectTo = '/inbox',
  children,
}: {
  roles: readonly UserRole[];
  redirectTo?: string;
  children: ReactNode;
}) {
  const { user } = useAuth();
  const router = useRouter();
  const allowed = !!user && roles.includes(user.role);

  useEffect(() => {
    if (user && !allowed) router.replace(redirectTo);
  }, [user, allowed, redirectTo, router]);

  if (!allowed) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Bạn không có quyền vào trang này, đang chuyển về hộp thư...
      </div>
    );
  }
  return <>{children}</>;
}
