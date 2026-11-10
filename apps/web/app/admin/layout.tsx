import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AdminNav } from '@/components/admin/admin-nav';
import { AppHeader } from '@/components/app-header';
import { RequireAuth } from '@/components/require-auth';
import { RequireRole } from '@/components/require-role';

export const metadata: Metadata = { title: { default: 'Quản trị', template: '%s · Quản trị · Dezon Inbox' } };

/** Khu quản trị: chỉ admin; nhân viên bị chuyển về /inbox. */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <div className="relative flex h-dvh flex-col overflow-hidden">
        <AppHeader />
        <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto bg-muted/40">
          <RequireRole roles={['admin']}>
            <AdminNav />
            {children}
          </RequireRole>
        </div>
      </div>
    </RequireAuth>
  );
}
