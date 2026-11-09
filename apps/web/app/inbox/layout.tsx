import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppHeader } from '@/components/app-header';
import { InboxLayout } from '@/components/inbox/inbox-layout';
import { RequireAuth } from '@/components/require-auth';
import { RealtimeProvider } from '@/lib/realtime';

export const metadata: Metadata = { title: 'Hộp thư' };

/**
 * Bố cục hộp thư đặt ở layout để không bị dựng lại khi đổi /inbox ↔ /inbox/<id>
 * (giữ bộ lọc, vị trí cuộn danh sách). Các page con chỉ quyết định URL, không render gì.
 */
export default function InboxRootLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <RealtimeProvider>
        {/* Khung đúng bằng màn hình: header luôn hiện, chỉ vùng bên trong từng cột cuộn.
            `relative` + overflow-hidden giữ mọi phần tử absolute ở trong khung (không tạo thanh cuộn của trình duyệt). */}
        <div className="relative flex h-dvh flex-col overflow-hidden">
          <AppHeader />
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <InboxLayout />
          </div>
          {children}
        </div>
      </RealtimeProvider>
    </RequireAuth>
  );
}
