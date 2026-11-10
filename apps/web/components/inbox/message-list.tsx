'use client';

import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Loader2, MessageSquare, RefreshCw } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { flattenMessages, isTempMessage, type ChatMessage } from '@/lib/inbox-cache';
import { dayKey, formatDayLabel } from '@/lib/inbox-format';
import { errorText, useMessages } from '@/lib/inbox-queries';
import { useAiTyping } from '@/lib/realtime';
import { AiTypingBubble } from './ai-typing';
import { MessageBubble, senderName } from './message-bubble';
import { countNewCustomerMessages } from './unseen-messages';

/** Cách đáy dưới ngưỡng này (px) thì coi như đang ở cuối danh sách. */
const BOTTOM_THRESHOLD = 80;
const TOP_THRESHOLD = 120;

function sameSender(a: ChatMessage | undefined, b: ChatMessage): boolean {
  return !!a && a.senderType === b.senderType && senderName(a) === senderName(b);
}

export function MessageList({
  conversationId,
  onRetry,
  onAtBottomChange,
}: {
  conversationId: string;
  onRetry: (m: ChatMessage) => void;
  /** Báo khi nhân viên cuộn tới/rời cuối danh sách (để chỉ đánh dấu đã đọc khi thấy tin mới nhất). */
  onAtBottomChange?: (atBottom: boolean) => void;
}) {
  const query = useMessages(conversationId);
  const messages = useMemo(() => flattenMessages(query.data), [query.data]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  /** Khoảng cách tới đáy trước khi tải tin cũ, để giữ nguyên vị trí đang đọc. */
  const restoreRef = useRef<number | null>(null);
  const lastRef = useRef<ChatMessage | undefined>(undefined);
  const initialScrollDone = useRef(false);
  /** Số tin khách đến khi đang cuộn lên xem tin cũ (hiện nút "tin mới"). */
  const [unseen, setUnseen] = useState(0);
  const aiTyping = !!useAiTyping(conversationId);

  const setAtBottom = useCallback(
    (value: boolean) => {
      if (value) setUnseen(0);
      if (atBottomRef.current === value) return;
      atBottomRef.current = value;
      onAtBottomChange?.(value);
    },
    [onAtBottomChange],
  );

  const loadOlder = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !hasNextPage || isFetchingNextPage) return;
    restoreRef.current = el.scrollHeight - el.scrollTop;
    void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD);
    if (el.scrollTop < TOP_THRESHOLD) loadOlder();
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (restoreRef.current !== null && !isFetchingNextPage) {
      el.scrollTop = el.scrollHeight - restoreRef.current;
      restoreRef.current = null;
    }
    const last = messages[messages.length - 1];
    if (!initialScrollDone.current && last) {
      el.scrollTop = el.scrollHeight;
      initialScrollDone.current = true;
    } else if (last && last !== lastRef.current) {
      // Tin cuối mới/đổi (tin mới, đổi trạng thái, lỗi gửi): tự cuộn nếu đang ở cuối
      // hoặc đó là tin mình vừa gửi.
      const justSent = last.id !== lastRef.current?.id && isTempMessage(last);
      if (atBottomRef.current || justSent) {
        el.scrollTop = el.scrollHeight;
        setAtBottom(true);
      } else {
        const added = countNewCustomerMessages(lastRef.current?.id, messages);
        if (added > 0) setUnseen((n) => n + added);
      }
    }
    lastRef.current = last;
  }, [messages, isFetchingNextPage, setAtBottom]);

  // Hiện "AI đang soạn tin…" ở cuối: giữ ở cuối nếu nhân viên đang xem tin mới nhất.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (aiTyping && el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [aiTyping]);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  // Ảnh tải xong làm danh sách cao lên: giữ ở cuối nếu đang ở cuối.
  const onMediaLoad = useCallback(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current && restoreRef.current === null) el.scrollTop = el.scrollHeight;
  }, []);

  if (query.isPending) {
    return (
      <div className="flex flex-1 flex-col gap-4 p-4" aria-hidden>
        <Skeleton className="h-10 w-2/3 rounded-2xl" />
        <Skeleton className="ml-auto h-10 w-1/2 rounded-2xl" />
        <Skeleton className="h-16 w-3/5 rounded-2xl" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="flex-1 p-4">
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col gap-2">
            {errorText(query.error, 'Không tải được tin nhắn.')}
            <Button variant="outline" size="sm" className="w-fit" onClick={() => void query.refetch()}>
              <RefreshCw aria-hidden />
              Thử lại
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-3 py-3 sm:px-4"
        role="log"
        aria-label="Tin nhắn"
        aria-live="polite"
      >
        {hasNextPage && (
          <div className="flex justify-center pb-2">
            <Button variant="ghost" size="sm" onClick={loadOlder} disabled={isFetchingNextPage}>
              {isFetchingNextPage && <Loader2 className="animate-spin" aria-hidden />}
              {isFetchingNextPage ? 'Đang tải tin cũ...' : 'Tải tin cũ hơn'}
            </Button>
          </div>
        )}
        {messages.length === 0 ? (
          aiTyping ? (
            <div className="mt-auto">
              <AiTypingBubble conversationId={conversationId} />
            </div>
          ) : (
            <EmptyState icon={MessageSquare} title="Chưa có tin nhắn" />
          )
        ) : (
          <div className="mt-auto flex flex-col gap-2">
            {messages.map((m, i) => {
              const prev = messages[i - 1];
              const newDay = !prev || dayKey(prev.sentAt) !== dayKey(m.sentAt);
              return (
                <Fragment key={m.id}>
                  {newDay && (
                    <div
                      className="flex items-center gap-3 py-2 text-xs text-muted-foreground"
                      role="separator"
                    >
                      <span className="h-px flex-1 bg-border" />
                      {formatDayLabel(m.sentAt)}
                      <span className="h-px flex-1 bg-border" />
                    </div>
                  )}
                  <MessageBubble
                    message={m}
                    showSender={newDay || !sameSender(prev, m)}
                    onRetry={onRetry}
                    onMediaLoad={onMediaLoad}
                  />
                </Fragment>
              );
            })}
            <AiTypingBubble conversationId={conversationId} />
          </div>
        )}
      </div>
      {unseen > 0 && (
        <Button
          variant="brand"
          size="sm"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-md"
          onClick={scrollToBottom}
        >
          <ArrowDown aria-hidden />
          {unseen > 99 ? '99+' : unseen} tin mới
        </Button>
      )}
    </div>
  );
}
