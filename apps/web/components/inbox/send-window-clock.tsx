'use client';

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Clock } from 'lucide-react';
import type { SendWindowInfo } from '@dezon/shared';
import { inboxKeys } from '@/lib/inbox-keys';
import { formatDateTime } from '@/lib/inbox-format';
import { sendWindowState, type WindowTone } from '@/lib/send-window';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';

const TONE_CLASSES: Record<WindowTone, string> = {
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  warn: 'border-amber-200 bg-amber-50 text-amber-700',
  expired: 'border-red-200 bg-red-50 text-red-700',
  unlimited: 'border-border bg-muted text-muted-foreground',
};

/** Đồng hồ đếm ngược cửa sổ gửi (xanh > 2 giờ, vàng < 2 giờ, đỏ khi hết). */
export function SendWindowClock({ conversationId, info }: { conversationId: string; info: SendWindowInfo }) {
  const now = useNow(1000);
  const state = sendWindowState(info, now);
  const qc = useQueryClient();
  const refetchedFor = useRef<string | null>(null);

  // Hết hạn tại máy khách nhưng máy chủ còn báo allowed: tải lại để lấy cửa sổ mới (vd. HUMAN_AGENT).
  const expiredLocally = info.allowed && state.tone === 'expired';
  useEffect(() => {
    if (!expiredLocally || refetchedFor.current === info.expiresAt) return;
    refetchedFor.current = info.expiresAt;
    void qc.invalidateQueries({ queryKey: inboxKeys.detail(conversationId) });
  }, [expiredLocally, info.expiresAt, conversationId, qc]);

  if (state.tone === 'unlimited') return null;
  const title = [
    info.expiresAt ? `Cửa sổ gửi đóng lúc ${formatDateTime(info.expiresAt)}` : null,
    state.reason,
  ]
    .filter(Boolean)
    .join('. ');

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium tabular-nums',
        TONE_CLASSES[state.tone],
      )}
      title={title || undefined}
      role="timer"
      aria-label={`Cửa sổ gửi: ${state.label}`}
    >
      <Clock className="size-3.5" aria-hidden />
      {state.label}
    </span>
  );
}
