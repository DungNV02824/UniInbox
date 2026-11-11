'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SEARCH_QUERY_MAX } from '@dezon/shared';
import { Inbox, Loader2, RefreshCw, Search, SearchX } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/lib/auth';
import { matchesAiState } from '@/lib/inbox-ai';
import { normalizeFilters, type ConversationFilters } from '@/lib/inbox-api';
import { errorText, useChannels, useConversation, useConversations } from '@/lib/inbox-queries';
import { useRealtimeStatus } from '@/lib/realtime';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import { ChannelFilterMenu } from './channel-filter-menu';
import { ConversationFilterPopover } from './conversation-filter-popover';
import { ConversationRow } from './conversation-row';
import {
  INBOX_CHANNEL_STORAGE_KEY,
  QUICK_TABS,
  activeQuickTab,
  applyQuickTab,
  defaultChannelId,
  toggleTagFilter,
} from './list-filters';
import { TagQuickTabs } from './tag-quick-tabs';

function readStoredChannel(): string | null {
  try {
    return window.localStorage.getItem(INBOX_CHANNEL_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeChannel(id: string | undefined) {
  try {
    if (id) window.localStorage.setItem(INBOX_CHANNEL_STORAGE_KEY, id);
  } catch {
    // Trình duyệt chặn lưu trữ: chỉ mất phần ghi nhớ kênh.
  }
}

/** Chấm trạng thái realtime (xanh: đang nhận tin, vàng: đang kết nối lại). */
function ConnectionDot() {
  const { connected } = useRealtimeStatus();
  const text = connected ? 'Đang nhận tin realtime' : 'Mất kết nối realtime, đang thử lại...';
  return (
    <span className="flex size-6 shrink-0 items-center justify-center" title={text} role="status">
      <span
        className={cn('size-2 rounded-full', connected ? 'bg-emerald-500' : 'animate-pulse bg-amber-500')}
      />
      <span className="sr-only">{connected ? 'Trực tuyến' : 'Đang kết nối...'}</span>
    </span>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-1 p-2" aria-hidden>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 p-2">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ConversationListPanel({
  className,
  selectedId,
}: {
  className?: string;
  selectedId?: string;
}) {
  const { user } = useAuth();
  const router = useRouter();
  const [filters, setFilters] = useState<ConversationFilters>({});
  // Ô tìm kiếm: gõ xong 300 ms mới gửi lên máy chủ.
  const [searchText, setSearchText] = useState('');
  useEffect(() => {
    const q = searchText.trim();
    const timer = setTimeout(
      () => setFilters((f) => ((f.q ?? '') === q ? f : { ...f, q: q || undefined })),
      300,
    );
    return () => clearTimeout(timer);
  }, [searchText]);
  const channels = useChannels();
  const channelList = channels.data;

  // Hộp thư luôn xem MỘT kênh: vào trang thì mở kênh đã chọn lần trước, không thì kênh đầu tiên.
  useEffect(() => {
    if (!channelList) return;
    setFilters((f) => {
      if (f.channelAccountId && channelList.some((c) => c.id === f.channelAccountId)) return f;
      const id = defaultChannelId(channelList, readStoredChannel());
      return id === f.channelAccountId && !f.channelType
        ? f
        : { ...f, channelType: undefined, channelAccountId: id };
    });
  }, [channelList]);

  // Mở thẳng một hội thoại (link Lark, thông báo...) thuộc kênh khác ⇒ chuyển danh sách sang kênh đó.
  const selected = useConversation(selectedId);
  const selectedChannelId = selected.data?.id === selectedId ? selected.data?.channel.id : undefined;
  useEffect(() => {
    if (!selectedChannelId) return;
    setFilters((f) =>
      f.channelAccountId === selectedChannelId
        ? f
        : { ...f, channelType: undefined, channelAccountId: selectedChannelId },
    );
    storeChannel(selectedChannelId);
  }, [selectedId, selectedChannelId]);

  // Chờ chọn xong kênh rồi mới tải danh sách (tránh tải "tất cả kênh" rồi đổi). Lỗi tải kênh ⇒ vẫn tải.
  const channelReady =
    channels.isError || (!!channelList && (!!filters.channelAccountId || channelList.length === 0));
  const query = useConversations(filters, { enabled: channelReady });

  const chooseChannel = (next: Pick<ConversationFilters, 'channelType' | 'channelAccountId'>) => {
    if (!next.channelAccountId) return;
    storeChannel(next.channelAccountId);
    setFilters((f) => ({ ...f, channelType: undefined, channelAccountId: next.channelAccountId }));
    // Đang mở hội thoại của kênh khác ⇒ đóng để khung chat khớp với kênh vừa chọn.
    if (selectedId && selectedChannelId && selectedChannelId !== next.channelAccountId) router.push('/inbox');
  };
  const now = useNow(30_000);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // "AI đang lo" chưa có bộ lọc phía máy chủ: lọc thêm trên các trang đã tải (xem inbox-api.ts).
  const clientFiltered = !!filters.aiState;
  const items = useMemo(
    () => (query.data?.pages.flatMap((p) => p.items) ?? []).filter((c) => matchesAiState(c, filters.aiState)),
    [query.data, filters.aiState],
  );
  // Kênh luôn được chọn nên không tính là "bộ lọc" khi báo danh sách trống.
  const hasFilters =
    Object.keys(normalizeFilters({ ...filters, channelAccountId: undefined, channelType: undefined }))
      .length > 0;

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  // Cuộn tới cuối danh sách thì tải trang kế (cursor).
  useEffect(() => {
    const el = sentinelRef.current;
    // Đang lọc phía web: không tự tải dồn mọi trang, để nhân viên bấm "Tải thêm".
    if (!el || !hasNextPage || clientFiltered) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, clientFiltered]);

  const tab = activeQuickTab(filters);

  return (
    <section className={cn('flex min-h-0 flex-col bg-background', className)} aria-label="Hội thoại">
      <h2 className="sr-only">Hội thoại</h2>
      {/* Bộ lọc gọn (~130px): kênh / tìm kiếm + nút bộ lọc / tab nhanh. Cùng chiều cao header với cột bên cạnh. */}
      <div className="flex h-12 shrink-0 items-center border-b px-3">
        <ChannelFilterMenu
          channels={channels.data ?? []}
          loading={channels.isPending}
          value={filters}
          onChange={chooseChannel}
        />
      </div>
      <div className="flex shrink-0 flex-col gap-1.5 border-b px-3 py-2">
        <div className="flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <input
              type="search"
              placeholder="Tìm khách hàng, tin nhắn..."
              className="h-8 w-full min-w-0 rounded-md border bg-background pr-2 pl-8 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              value={searchText}
              maxLength={SEARCH_QUERY_MAX}
              onChange={(e) => setSearchText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && searchText) {
                  e.preventDefault();
                  setSearchText('');
                }
              }}
              title="Tìm theo tên khách hoặc nội dung tin nhắn (gõ không dấu cũng được)"
              aria-label="Tìm hội thoại theo tên khách hoặc nội dung tin nhắn"
            />
          </div>
          <ConversationFilterPopover
            filters={filters}
            onChange={setFilters}
            isAdmin={user?.role === 'admin'}
          />
        </div>
        <div className="flex items-center gap-1">
          <div className="flex min-w-0 items-center gap-1" role="group" aria-label="Lọc nhanh">
            {QUICK_TABS.map((t) => (
              <button
                key={t.value}
                type="button"
                aria-pressed={tab === t.value}
                onClick={() => setFilters((f) => applyQuickTab(f, t.value))}
                className={cn(
                  'h-7 rounded-full px-3 text-xs whitespace-nowrap outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  tab === t.value
                    ? 'bg-brand/10 font-medium text-brand'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="ml-auto">
            <ConnectionDot />
          </div>
        </div>
        <TagQuickTabs value={filters.tag} onChange={(tag) => setFilters((f) => toggleTagFilter(f, tag))} />
      </div>

      {/* Chỉ vùng này cuộn; `relative` để phần tử absolute (sr-only...) trong dòng không làm cả trang cuộn. */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
        {query.isPending || !channelReady ? (
          <ListSkeleton />
        ) : query.isError ? (
          <div className="p-3">
            <Alert variant="destructive">
              <AlertDescription className="flex flex-col gap-2">
                {errorText(query.error, 'Không tải được danh sách hội thoại.')}
                <Button variant="outline" size="sm" className="w-fit" onClick={() => void query.refetch()}>
                  <RefreshCw aria-hidden />
                  Thử lại
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        ) : items.length === 0 && !(clientFiltered && hasNextPage) ? (
          hasFilters ? (
            <EmptyState
              icon={SearchX}
              title={filters.q ? `Không tìm thấy "${filters.q}"` : 'Không có hội thoại phù hợp'}
              description={
                filters.q
                  ? 'Không có khách hoặc tin nhắn nào khớp trong kênh này. Thử từ khóa khác hoặc chọn kênh khác.'
                  : 'Thử bỏ bớt bộ lọc để xem thêm hội thoại.'
              }
            />
          ) : (
            <EmptyState
              icon={Inbox}
              title="Chưa có hội thoại"
              description={
                filters.channelAccountId
                  ? 'Kênh này chưa có hội thoại. Chọn kênh khác ở ô phía trên.'
                  : 'Tin nhắn từ các kênh đã kết nối (Fanpage...) sẽ hiện ở đây.'
              }
            />
          )
        ) : (
          <>
            <ul className="flex flex-col p-1.5" aria-label="Danh sách hội thoại">
              {items.map((conv) => (
                <li key={conv.id}>
                  <ConversationRow
                    conversation={conv}
                    active={conv.id === selectedId}
                    now={now}
                    viewerId={user?.id}
                  />
                </li>
              ))}
            </ul>
            {clientFiltered && hasNextPage ? (
              <div className="flex shrink-0 flex-col items-center gap-1 px-3 pt-1 pb-3 text-center">
                {items.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    Chưa thấy hội thoại phù hợp trong phần đã tải.
                  </p>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isFetchingNextPage}
                  onClick={() => void fetchNextPage()}
                >
                  {isFetchingNextPage && <Loader2 className="animate-spin" aria-hidden />}
                  Tải thêm hội thoại
                </Button>
              </div>
            ) : (
              <div ref={sentinelRef} className="flex h-10 shrink-0 items-center justify-center">
                {isFetchingNextPage && (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
