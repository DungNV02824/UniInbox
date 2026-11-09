import type { Metadata } from 'next';
import { Suspense } from 'react';
import { BrandLogo } from '@/components/brand-logo';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Đăng nhập' };

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-muted/60 px-4 py-10">
      <BrandLogo className="text-xl" />
      <Suspense>
        <LoginForm />
      </Suspense>
      <p className="text-center text-xs text-muted-foreground">© Dezon · dezon.vn</p>
    </main>
  );
}
