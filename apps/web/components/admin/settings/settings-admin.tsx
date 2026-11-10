'use client';

import { useCallback, useState } from 'react';
import { useUnsavedGuard } from '../use-unsaved-guard';
import { AiCard } from './ai-card';
import { BusinessHoursCard } from './business-hours-card';
import { LarkCard } from './lark-card';

export function SettingsAdmin() {
  // Một bộ cảnh báo rời trang chung cho các khối có form.
  const [dirtyHours, setDirtyHours] = useState(false);
  const [dirtyLark, setDirtyLark] = useState(false);
  useUnsavedGuard(dirtyHours || dirtyLark);
  const onHours = useCallback((d: boolean) => setDirtyHours(d), []);
  const onLark = useCallback((d: boolean) => setDirtyLark(d), []);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 sm:p-6 lg:py-8">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Cài đặt</h1>
        <p className="text-sm text-muted-foreground">
          Giờ làm việc dùng cho chatbot, thông báo Lark khi cần người thật, và công tắc dừng toàn bộ AI.
        </p>
      </header>
      <AiCard />
      <BusinessHoursCard onDirtyChange={onHours} />
      <LarkCard onDirtyChange={onLark} />
    </main>
  );
}
