'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, MessageSquare, SearchX, ShieldAlert } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { canView } from '@/lib/inbox-cache';
import { errorText, useConversation, useMarkRead, useSendMessage } from '@/lib/inbox-queries';
import { usePageVisible } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import { ChatHeader } from './chat-header';
import { Composer } from './composer';
import { MessageList } from './message-list';
import { Panel } from './panel';

function BackToList() {
  return (
    <Button variant="outline" size="sm" asChild className="lg:hidden">
      <Link href="/inbox">
        <ArrowLeft aria-hidden />
        Về danh sách
      </Link>
    </Button>
  );
}

function ChatView({ conversationId, onShowInfo }: { conversationId: string; onShowInfo: () => void }) {
  const { user } = useAuth();
  const detail = useConversation(conversationId);
  const { send, retry } = useSendMessage(conversationId);
  const markRead = useMarkRead();
  const pageVisible = usePageVisible();
  const markingRef = useRef(false);
  /** Tăng khi một lần đánh dấu xong để xét lại tin đến trong lúc đang gửi yêu cầu. */
  const [markTick, setMarkTick] = useState(0);
  /** Đang xem cuối danh sách tin (cuộn lên xem tin cũ thì chưa tính là đã đọc tin mới). */
  const [atBottom, setAtBottom] = useState(true);

  const conv = detail.data;
  const unread = conv?.unreadCount ?? 0;

  // Mở hội thoại có tin chưa đọc (hoặc có tin mới khi đang mở) → đánh dấu đã đọc.
  useEffect(() => {
    if (!pageVisible || !atBottom || unread <= 0 || markingRef.current) return;
    markingRef.current = true;
    void markRead(conversationId).finally(() => {
      markingRef.current = false;
      setMarkTick((n) => n + 1);
    });
  }, [conversationId, unread, pageVisible, atBottom, markRead, markTick]);

  if (detail.isPending) {
    return (
      <div className="flex flex-1 flex-col">
        <div className="flex items-center gap-3 border-b p-3">
          <Skeleton className="size-8 rounded-full" />
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="flex-1" />
      </div>
    );
  }

  if (detail.isError || !conv) {
    const status = detail.error instanceof ApiError ? detail.error.status : 0;
    const notFound = status === 404 || status === 403 || status === 400;
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4">
        {notFound ? (
          <EmptyState
            icon={SearchX}
            title="Không tìm thấy hội thoại"
            description="Hội thoại không tồn tại hoặc bạn không có quyền xem."
            className="flex-none"
          />
        ) : (
          <Alert variant="destructive" className="max-w-md">
            <AlertDescription>{errorText(detail.error, 'Không tải được hội thoại.')}</AlertDescription>
          </Alert>
        )}
        <BackToList />
      </div>
    );
  }

  const viewable = user ? canView(conv, user) : true;

  return (
    <>
      <ChatHeader conversation={conv} onShowInfo={onShowInfo} />
      {!viewable && (
        <Alert className="rounded-none border-x-0 border-t-0 border-amber-200 bg-amber-50 text-amber-800">
          <ShieldAlert aria-hidden />
          <AlertDescription>
            Hội thoại đã được phân công cho {conv.assignedUser?.name ?? 'nhân viên khác'}. Bạn không còn quyền
            xem tin mới của hội thoại này.
          </AlertDescription>
        </Alert>
      )}
      <MessageList conversationId={conversationId} onRetry={retry} onAtBottomChange={setAtBottom} />
      <Composer conversation={conv} canViewConv={viewable} onSend={(input) => void send(input)} />
    </>
  );
}

export function ChatPanel({
  conversationId,
  onShowInfo,
  className,
}: {
  conversationId?: string;
  onShowInfo: () => void;
  className?: string;
}) {
  if (!conversationId) {
    return (
      <Panel title="Khung chat" className={className}>
        <EmptyState
          icon={MessageSquare}
          title="Chọn một hội thoại để bắt đầu"
          description="Nội dung trò chuyện và ô soạn tin sẽ hiển thị tại đây."
        />
      </Panel>
    );
  }
  return (
    <section
      className={cn('relative flex min-h-0 flex-col bg-background', className)}
      aria-label="Khung chat"
    >
      <ChatView key={conversationId} conversationId={conversationId} onShowInfo={onShowInfo} />
    </section>
  );
}
