'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  History,
  KeyRound,
  Loader2,
  Plus,
  XCircle,
} from 'lucide-react';
import type { ConnectFacebookPageResult, FacebookLoginPageDto } from '@dezon/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import {
  FACEBOOK_ERROR_MESSAGES,
  readFacebookReturnParams,
  stripFacebookReturnParams,
} from '@/lib/channel-groups';
import { channelsApi } from '@/lib/inbox-api';
import { channelsKey } from '@/lib/inbox-keys';
import { errorText } from '@/lib/inbox-queries';
import { cn } from '@/lib/utils';

/** Biểu tượng "f" đơn giản (lucide không có logo thương hiệu). */
function FacebookMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex size-4 items-center justify-center rounded-full bg-[#1877F2] text-[11px] leading-none font-bold text-white',
        className,
      )}
      aria-hidden
    >
      f
    </span>
  );
}

/** Bắt đầu Facebook Login: lấy URL từ API rồi chuyển hẳn trình duyệt sang facebook.com. */
export function useStartFacebookLogin() {
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: channelsApi.startFacebookLogin,
    onSuccess: ({ authorizeUrl }) => window.location.assign(authorizeUrl),
    onError: (err) =>
      toast({
        title: 'Không mở được đăng nhập Facebook',
        description: errorText(err, 'Vui lòng thử lại.'),
        variant: 'destructive',
      }),
  });
  const { reset } = mutation;
  // Bấm Back trên facebook.com: trình duyệt khôi phục trang từ bfcache với trạng thái "đang mở" → đặt lại.
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) reset();
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, [reset]);
  return mutation;
}

/** Nút "Kết nối" + menu: Facebook (Facebook Login) / Dán Page Access Token. */
export function ConnectMenu({ onPasteToken }: { onPasteToken: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const start = useStartFacebookLogin();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <Button
        variant="brand"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={start.isPending || start.isSuccess}
      >
        {start.isPending || start.isSuccess ? (
          <Loader2 className="animate-spin" aria-hidden />
        ) : (
          <Plus aria-hidden />
        )}
        {start.isPending || start.isSuccess ? 'Đang mở Facebook...' : 'Kết nối'}
        <ChevronDown aria-hidden />
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-2 flex w-72 flex-col gap-1 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            className="flex items-start gap-3 rounded-md px-3 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            onClick={() => {
              setOpen(false);
              start.mutate();
            }}
          >
            <FacebookMark className="mt-0.5" />
            <span className="flex flex-col">
              <span className="text-sm font-medium">Facebook</span>
              <span className="text-xs text-muted-foreground">
                Đăng nhập Facebook và chọn các Trang bạn quản lý (khuyên dùng)
              </span>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex items-start gap-3 rounded-md px-3 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            onClick={() => {
              setOpen(false);
              onPasteToken();
            }}
          >
            <KeyRound className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
            <span className="flex flex-col">
              <span className="text-sm font-medium">Dán Page Access Token</span>
              <span className="text-xs text-muted-foreground">
                Cách thủ công khi không dùng được Facebook Login
              </span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Đọc `?fbSession` / `?fbError` một lần khi vào trang, xóa khỏi URL ngay (không để lại khi tải lại / chia sẻ link).
 * Trả sessionId cần mở hộp thoại chọn Trang.
 */
export function useFacebookReturn(): [string | null, () => void] {
  const toast = useToast();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    const params = readFacebookReturnParams(window.location.search);
    if (!params.hasParams) return;
    window.history.replaceState(window.history.state, '', stripFacebookReturnParams(window.location.href));
    if (params.error) {
      toast({
        title: 'Kết nối Facebook chưa thành công',
        description: FACEBOOK_ERROR_MESSAGES[params.error],
        variant: 'destructive',
        duration: 10_000,
      });
    } else if (params.sessionId) {
      setSessionId(params.sessionId);
    }
  }, [toast]);

  return [sessionId, () => setSessionId(null)];
}

function PageRow({
  page,
  checked,
  onToggle,
  result,
}: {
  page: FacebookLoginPageDto;
  checked: boolean;
  onToggle: () => void;
  result?: ConnectFacebookPageResult;
}) {
  const disabled = !page.canMessage || !!result;
  const id = `fb-page-${page.id}`;
  return (
    <li
      className={cn('flex items-center gap-3 px-3 py-2.5', !page.canMessage && 'opacity-60')}
      title={page.canMessage ? undefined : (page.cannotMessageReason ?? 'Không đủ quyền trên Trang')}
    >
      <input
        id={id}
        type="checkbox"
        className="size-4 shrink-0 accent-brand"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
      />
      <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
        <Avatar src={page.pictureUrl} name={page.name} className="size-9" />
        <span className="flex min-w-0 flex-col">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{page.name}</span>
            {page.alreadyConnected && (
              <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                Đã kết nối
              </span>
            )}
          </span>
          <span className="font-mono text-xs text-muted-foreground">{page.id}</span>
          {!page.canMessage && page.cannotMessageReason && (
            <span className="text-xs text-muted-foreground">{page.cannotMessageReason}</span>
          )}
          {result &&
            (result.ok ? (
              <span className="flex items-center gap-1 text-xs text-emerald-700">
                <CheckCircle2 className="size-3.5" aria-hidden />
                Đã kết nối thành công
              </span>
            ) : (
              <span className="flex items-start gap-1 text-xs text-destructive">
                <XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {result.error ?? 'Không kết nối được'}
              </span>
            ))}
        </span>
      </label>
    </li>
  );
}

/** Hộp thoại "Chọn Trang để kết nối" sau khi đăng nhập Facebook. */
export function FacebookPagesDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const start = useStartFacebookLogin();
  const session = useQuery({
    queryKey: ['facebook-login-session', sessionId],
    queryFn: () => channelsApi.facebookLoginSession(sessionId),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const pages = useMemo(() => session.data?.pages ?? [], [session.data]);
  const selectable = useMemo(() => pages.filter((p) => p.canMessage), [pages]);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  // Mặc định chọn các Trang nhắn được và chưa kết nối.
  const current = selected ?? new Set(selectable.filter((p) => !p.alreadyConnected).map((p) => p.id));

  const connect = useMutation({
    mutationFn: (pageIds: string[]) => channelsApi.connectFacebookPages(sessionId, { pageIds }),
    onSuccess: ({ results }) => {
      void qc.invalidateQueries({ queryKey: channelsKey });
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      const ok = results.filter((r) => r.ok).length;
      toast({
        title: ok > 0 ? `Đã kết nối ${ok}/${results.length} Trang` : 'Chưa kết nối được Trang nào',
        description: ok > 0 ? 'Đang đồng bộ lịch sử tin nhắn ở nền.' : undefined,
        variant: ok === results.length ? 'success' : ok > 0 ? 'default' : 'destructive',
      });
    },
  });
  const results = useMemo(
    () => new Map((connect.data?.results ?? []).map((r) => [r.pageId, r])),
    [connect.data],
  );
  const done = connect.isSuccess;
  const connectedCount = connect.data?.results.filter((r) => r.ok).length ?? 0;

  const toggle = (id: string) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const allChecked = selectable.length > 0 && selectable.every((p) => current.has(p.id));
  const expired = session.error instanceof ApiError && session.error.status === 404;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !connect.isPending && onClose()}
      title="Chọn Trang để kết nối"
      className="max-w-xl"
      description={
        session.data ? (
          <span className="flex items-center gap-1.5">
            <FacebookMark />
            Đăng nhập với <strong className="font-medium text-foreground">
              {session.data.fbUser.name}
            </strong>{' '}
            · {pages.length} Trang
          </span>
        ) : (
          'Các Trang mà tài khoản Facebook vừa đăng nhập đang quản lý.'
        )
      }
      footer={
        session.data && pages.length > 0 ? (
          done ? (
            <Button variant="brand" onClick={onClose}>
              Xong
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={onClose} disabled={connect.isPending}>
                Hủy
              </Button>
              <Button
                variant="brand"
                disabled={connect.isPending || current.size === 0}
                onClick={() => connect.mutate([...current])}
              >
                {connect.isPending && <Loader2 className="animate-spin" aria-hidden />}
                Kết nối ({current.size})
              </Button>
            </>
          )
        ) : undefined
      }
    >
      {session.isPending ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Đang tải danh sách Trang...
        </div>
      ) : session.isError ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertDescription className="flex flex-col gap-2">
            {expired
              ? 'Phiên đăng nhập Facebook đã hết hạn (15 phút) hoặc đã được dùng.'
              : errorText(session.error, 'Không tải được danh sách Trang.')}
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => start.mutate()}
              disabled={start.isPending}
            >
              <FacebookMark />
              Đăng nhập Facebook lại
            </Button>
          </AlertDescription>
        </Alert>
      ) : pages.length === 0 ? (
        <Alert>
          <AlertCircle aria-hidden />
          <AlertDescription>
            Tài khoản này không quản lý Trang nào, hoặc bạn chưa chọn Trang khi Facebook hỏi. Hãy đăng nhập
            lại và chọn “Chỉnh sửa cài đặt” để cấp quyền cho các Trang cần kết nối.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="flex flex-col gap-2">
          {connect.isError && (
            <Alert variant="destructive">
              <AlertCircle aria-hidden />
              <AlertDescription>{errorText(connect.error, 'Không kết nối được.')}</AlertDescription>
            </Alert>
          )}
          {done && connectedCount > 0 && (
            <Alert>
              <History aria-hidden />
              <AlertDescription>
                Hệ thống đang đồng bộ lịch sử tin nhắn gần đây của {connectedCount} Trang ở nền; hội thoại sẽ
                dần xuất hiện trong hộp thư. Xem tiến độ ở dòng trạng thái của từng kênh, hoặc bấm “Đồng bộ
                lịch sử” để kéo thêm.
              </AlertDescription>
            </Alert>
          )}
          {!done && selectable.length > 0 && (
            <label className="flex w-fit cursor-pointer items-center gap-2 px-3 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-brand"
                checked={allChecked}
                onChange={() => setSelected(allChecked ? new Set() : new Set(selectable.map((p) => p.id)))}
              />
              Chọn tất cả
            </label>
          )}
          <ul className="divide-y rounded-lg border" aria-label="Danh sách Trang">
            {pages.map((page) => (
              <PageRow
                key={page.id}
                page={page}
                checked={current.has(page.id)}
                onToggle={() => toggle(page.id)}
                result={done ? results.get(page.id) : undefined}
              />
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
