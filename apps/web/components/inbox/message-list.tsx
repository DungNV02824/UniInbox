'use client';

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Loader2, MessageSquare, RefreshCw } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { flattenMessages, isTempMessage, type ChatMessage } from '@/lib/inbox-cache';
import { dayKey, formatDayLabel } from '@/lib/inbox-format';
import { errorText, useMessages } from '@/lib/inbox-queries';
import { MESSAGE_HIGHLIGHT_MS, messageJumpStore, planMessageJump, useMessageJump } from '@/lib/message-jump';
import { useAiTyping } from '@/lib/realtime';
import { cn } from '@/lib/utils';
import { AiTypingBubble } from './ai-typing';
import { MessageBubble, senderName } from './message-bubble';
import { countNewCustomerMessages } from './unseen-messages';

/** Cách đáy dưới ngưỡng này (px) thì coi như đang ở cuối danh sách. */
const BOTTOM_THRESHOLD = 80;
const TOP_THRESHOLD = 120;

const JUMP_MISSING_TEXT = 'Không tìm thấy tin nhắn của công trình này (có thể đã bị xóa)';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function findMessageEl(root: HTMLElement, id: string): HTMLElement | null {
  const sel = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\\"');
  return root.querySelector<HTMLElement>(`[data-message-id="${sel}"]`);
}

/** scrollTop khi căn `target` vào giữa khung cuộn `el` (như scrollIntoView block center, đã kẹp trong giới hạn). */
function centeredScrollTop(el: HTMLElement, target: HTMLElement): number {
  const box = el.getBoundingClientRect();
  const r = target.getBoundingClientRect();
  const top = el.scrollTop + (r.top - box.top) - (el.clientHeight - r.height) / 2;
  return Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight));
}

/** Phần tử đang focus đã mất (body) hoặc bị ẩn (vd. khung Thông tin khách đóng trên điện thoại). */
function focusLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || active.getClientRects().length === 0;
}

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
  const toast = useToast();

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  /** Khoảng cách tới đáy trước khi tải tin cũ, để giữ nguyên vị trí đang đọc. */
  const restoreRef = useRef<number | null>(null);
  const lastRef = useRef<ChatMessage | undefined>(undefined);
  const initialScrollDone = useRef(false);
  /** Số tin khách đến khi đang cuộn lên xem tin cũ (hiện nút "tin mới"). */
  const [unseen, setUnseen] = useState(0);
  const aiTyping = !!useAiTyping(conversationId);
  const jump = useMessageJump();
  const jumpRequest = jump.request?.conversationId === conversationId ? jump.request : null;
  const highlighted = jump.highlight?.conversationId === conversationId ? jump.highlight.ids : null;
  /**
   * Lần nhảy đang xử lý: số trang đã tải thêm, đang chờ lần tải trang của chính nó xong. Xét theo lúc lần tải
   * kết thúc (kể cả bị hủy do làm mới danh sách) chứ không theo số trang ⇒ không treo khi trang không về.
   */
  const jumpRef = useRef<{ seq: number; pages: number; awaiting: boolean } | null>(null);
  /** Tăng khi lần tải trang của lần nhảy kết thúc ⇒ chạy lại effect nhảy. */
  const [jumpTick, setJumpTick] = useState(0);
  /** Tin vừa nhảy tới: ảnh tải xong làm lệch vị trí ⇒ căn lại tới khi hết hạn / người dùng tự cuộn. */
  const focusRef = useRef<{ id: string; until: number } | null>(null);

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
    if (!el || restoreRef.current !== null) return;
    const focus = focusRef.current;
    if (focus && Date.now() < focus.until) {
      findMessageEl(el, focus.id)?.scrollIntoView({ block: 'center' });
      return;
    }
    focusRef.current = null;
    if (atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, []);

  // Người dùng tự cuộn (chuột/chạm/phím) ⇒ thôi giữ tin vừa nhảy tới ở giữa.
  const releaseFocus = useCallback(() => {
    focusRef.current = null;
  }, []);

  // Nhảy tới tin (bấm dòng Nhật ký công trình): tin đã có ⇒ cuộn tới; chưa có ⇒ tải dần tin cũ hơn (không đặt
  // restoreRef nên không giành vị trí với phần giữ chỗ khi tải tin cũ). Chạy sau các layout effect ở trên nên lần
  // cuộn xuống cuối lúc mở hội thoại không đè lên lần nhảy.
  useEffect(() => {
    const req = jumpRequest;
    if (!req || query.isPending) return;
    const el = scrollRef.current;
    if (query.isError || !el) {
      if (query.isError) {
        jumpRef.current = null;
        messageJumpStore.finishJump(req.seq, false);
        toast({ title: JUMP_MISSING_TEXT, variant: 'destructive' });
      }
      return;
    }
    let state = jumpRef.current;
    if (!state || state.seq !== req.seq)
      state = jumpRef.current = { seq: req.seq, pages: 0, awaiting: false };
    // Đang tải trang (của lần nhảy hoặc do người dùng cuộn lên) ⇒ chờ xong rồi xét tiếp.
    if (state.awaiting || isFetchingNextPage) return;

    const step = planMessageJump({
      request: req,
      loaded: messages,
      hasNextPage: !!hasNextPage,
      pagesFetched: state.pages,
    });
    if (step.kind === 'fetch') {
      const seq = req.seq;
      state.pages += 1;
      state.awaiting = true;
      void fetchNextPage()
        .then((r) => {
          if (r.isError && jumpRef.current?.seq === seq) {
            jumpRef.current = null;
            messageJumpStore.finishJump(seq, false);
            toast({
              title: 'Không tải được tin cũ',
              description: errorText(r.error),
              variant: 'destructive',
            });
          }
        })
        .catch(() => undefined)
        .finally(() => {
          // Xong / lỗi / bị hủy (invalidate tin nhắn hủy lần tải trang đang chạy) ⇒ xét tiếp.
          const cur = jumpRef.current;
          if (cur?.seq !== seq) return;
          cur.awaiting = false;
          setJumpTick((n) => n + 1);
        });
      return;
    }
    jumpRef.current = null;
    const target = step.kind === 'scroll' ? findMessageEl(el, step.targetId) : null;
    if (!target || step.kind !== 'scroll') {
      messageJumpStore.finishJump(req.seq, false);
      toast({ title: JUMP_MISSING_TEXT, variant: 'destructive' });
      return;
    }
    // Đặt "đang ở cuối" theo vị trí sẽ cuộn tới (tin ở xa đáy ⇒ rời cuối ngay để ảnh tải xong / tin mới không kéo
    // khung chat về cuối giữa chừng). Tin đã ở sát đáy thì khung không cuộn, không có sự kiện scroll ⇒ không được
    // đặt false cố định (sẽ kẹt: không đánh dấu đã đọc, tin mới không tự cuộn).
    setAtBottom(el.scrollHeight - centeredScrollTop(el, target) - el.clientHeight < BOTTOM_THRESHOLD);
    focusRef.current = { id: step.targetId, until: Date.now() + MESSAGE_HIGHLIGHT_MS };
    target.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    // Nút vừa bấm bị ẩn (điện thoại: đóng khung Thông tin khách) ⇒ đưa focus tới tin để bàn phím / trình đọc màn
    // hình ở đúng chỗ.
    if (focusLost()) target.focus({ preventScroll: true });
    messageJumpStore.finishJump(req.seq, true);
  }, [
    jumpRequest,
    jumpTick,
    messages,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    query.isPending,
    query.isError,
    setAtBottom,
    toast,
  ]);

  // Rời hội thoại (đổi hội thoại / đóng khung chat) ⇒ bỏ yêu cầu nhảy còn dở, khỏi chạy lại khi mở lại sau này.
  useEffect(() => () => messageJumpStore.clear(conversationId), [conversationId]);

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
        onWheel={releaseFocus}
        onTouchStart={releaseFocus}
        onKeyDown={releaseFocus}
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
                  <div
                    data-message-id={m.id}
                    data-highlighted={highlighted?.has(m.id) || undefined}
                    tabIndex={-1}
                    className={cn(
                      '-mx-1.5 -my-1 rounded-xl outline-none px-1.5 py-1 ring-0 ring-transparent transition-[background-color,box-shadow] duration-1000 ease-out motion-reduce:transition-none',
                      highlighted?.has(m.id) &&
                        'bg-amber-100/80 ring-2 ring-amber-400/70 duration-200 dark:bg-amber-400/15 dark:ring-amber-400/50',
                    )}
                  >
                    <MessageBubble
                      message={m}
                      showSender={newDay || !sameSender(prev, m)}
                      onRetry={onRetry}
                      onMediaLoad={onMediaLoad}
                    />
                  </div>
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
