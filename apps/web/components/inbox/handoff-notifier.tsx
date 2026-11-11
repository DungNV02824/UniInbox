'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { BellRing, Siren, X } from 'lucide-react';
import type { HandoffCreatedPayload } from '@dezon/shared';
import { useHandoffEvents } from '@/lib/realtime';
import {
  handoffToastText,
  playHandoffBeep,
  stripTitleCounter,
  titleWithCounter,
  unlockHandoffAudio,
} from '@/lib/realtime-handoff';
import { cn } from '@/lib/utils';

const TOAST_MS = 15_000;
const MAX_TOASTS = 3;

interface HandoffToast {
  id: number;
  payload: HandoffCreatedPayload;
}

function tabInactive(): boolean {
  return document.visibilityState !== 'visible' || !document.hasFocus();
}

/** Bộ đếm "(n)" trên tiêu đề tab cho tới khi nhân viên quay lại tab. */
function useTitleCounter() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    document.title = titleWithCounter(document.title, count);
  }, [count]);

  useEffect(() => {
    const reset = () => {
      if (!tabInactive()) setCount(0);
    };
    window.addEventListener('focus', reset);
    document.addEventListener('visibilitychange', reset);
    return () => {
      window.removeEventListener('focus', reset);
      document.removeEventListener('visibilitychange', reset);
      document.title = stripTitleCounter(document.title);
    };
  }, []);

  return useCallback(() => {
    if (tabInactive()) setCount((n) => n + 1);
  }, []);
}

/**
 * Thông báo "Cần người" khi AI chuyển hội thoại cho người thật (`handoff.created`):
 * tiếng bíp + thẻ thông báo có link mở hội thoại + bộ đếm trên tiêu đề tab. `botContinues` (từ khóa "bot VẪN
 * trả lời") chỉ là thông báo: hội thoại không đổi trạng thái (trạng thái luôn đến qua `conversation.updated`).
 */
export function HandoffNotifier() {
  const [toasts, setToasts] = useState<HandoffToast[]>([]);
  const nextId = useRef(1);
  const bumpTitle = useTitleCounter();

  // Trình duyệt chỉ cho phát âm thanh sau thao tác đầu tiên của người dùng.
  useEffect(() => {
    const unlock = () => unlockHandoffAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  useHandoffEvents((payload) => {
    const id = nextId.current++;
    setToasts((list) => [...list.slice(-(MAX_TOASTS - 1)), { id, payload }]);
    setTimeout(() => dismiss(id), TOAST_MS);
    playHandoffBeep();
    bumpTitle();
  });

  if (toasts.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-14 z-[90] flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:right-0 sm:items-end"
      aria-live="assertive"
      role="alert"
    >
      {toasts.map(({ id, payload }) => {
        const text = handoffToastText(payload);
        // Chỉ báo (bot vẫn trả lời): tông vàng "thông báo", không phải đỏ "Cần người".
        const Icon = text.botContinues ? BellRing : Siren;
        return (
          <div
            key={id}
            className={cn(
              'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border bg-background p-3 text-sm shadow-lg',
              text.botContinues
                ? 'border-amber-200 border-l-4 border-l-amber-500'
                : 'border-red-200 border-l-4 border-l-red-500',
            )}
          >
            <Icon
              className={cn('mt-0.5 size-4 shrink-0', text.botContinues ? 'text-amber-600' : 'text-red-600')}
              aria-hidden
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className={cn('font-medium', text.botContinues ? 'text-amber-800' : 'text-red-700')}>
                {text.title}
              </p>
              {text.description && (
                <p className="line-clamp-3 text-xs text-muted-foreground">{text.description}</p>
              )}
              <Link
                href={`/inbox/${payload.conversationId}`}
                onClick={() => dismiss(id)}
                className="w-fit text-xs font-medium text-brand hover:underline"
              >
                Mở hội thoại
              </Link>
            </div>
            <button
              type="button"
              onClick={() => dismiss(id)}
              className="rounded p-0.5 text-muted-foreground hover:bg-accent"
              aria-label="Đóng thông báo"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
