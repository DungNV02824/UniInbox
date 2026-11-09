'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, History, Info, Loader2, RefreshCw } from 'lucide-react';
import type { ChannelAccountDto } from '@dezon/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import {
  DEFAULT_SYNC_DAYS,
  describeSyncStatus,
  parseSyncDays,
  showSyncStatus,
  SYNC_DAY_OPTIONS,
  syncErrorText,
} from '@/lib/channel-sync';
import { channelsApi } from '@/lib/inbox-api';
import { channelsKey } from '@/lib/inbox-keys';
import { useNow } from '@/lib/use-now';

/** Dòng trạng thái đồng bộ ngắn gọn dưới tên kênh Messenger. */
export function ChannelSyncStatus({ channel }: { channel: ChannelAccountDto }) {
  const now = useNow(30_000);
  if (!showSyncStatus(channel)) return null;
  const view = describeSyncStatus(channel.sync, new Date(now));
  return (
    <div className="flex flex-col gap-1.5 text-xs" aria-live="polite">
      {view.running ? (
        <p className="flex items-center gap-2 text-brand">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          Đang đồng bộ lịch sử…
        </p>
      ) : (
        view.lastSynced && (
          <p className="flex items-start gap-2 text-muted-foreground" title={view.backfill ?? undefined}>
            <RefreshCw className="mt-px size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
            {view.lastSynced}
          </p>
        )
      )}
      {view.warnings.map((w) => (
        <p key={w} className="flex items-start gap-2 text-amber-700 dark:text-amber-400">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{w}</span>
        </p>
      ))}
      {view.error && (
        <p className="flex items-start gap-2 text-destructive">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            Lỗi đồng bộ: {view.error.message}
            {view.error.at && <span className="text-destructive/80"> ({view.error.at})</span>}
          </span>
        </p>
      )}
    </div>
  );
}

/** Hộp thoại "Đồng bộ lịch sử": chọn số ngày rồi gọi POST /channels/:id/sync. */
export function SyncHistoryDialog({
  channel,
  onOpenChange,
}: {
  channel: ChannelAccountDto;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [days, setDays] = useState(String(DEFAULT_SYNC_DAYS));
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (n: number) => channelsApi.sync(channel.id, { days: n }),
    onSuccess: (_data, n) => {
      // Tải lại để thấy "Đang đồng bộ lịch sử…" (trang Kênh tự tải lại mỗi 5s khi đang đồng bộ).
      void qc.invalidateQueries({ queryKey: channelsKey });
      toast({
        title: `Đã bắt đầu đồng bộ lịch sử ${n} ngày`,
        description: channel.displayName,
        variant: 'success',
      });
      onOpenChange(false);
    },
    onError: (err) => {
      setError(syncErrorText(err));
      void qc.invalidateQueries({ queryKey: channelsKey });
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = parseSyncDays(days);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    mutation.mutate(parsed.days);
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}
      title="Đồng bộ lịch sử"
      description={`Kéo các hội thoại và tin nhắn gần đây của "${channel.displayName}" từ Facebook về hộp thư.`}
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        {error && (
          <Alert variant="destructive">
            <AlertCircle aria-hidden />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-col gap-2">
          <Label htmlFor="sync-days">Khoảng thời gian</Label>
          <NativeSelect
            id="sync-days"
            data-autofocus
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="w-full sm:w-56"
          >
            {SYNC_DAY_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n} ngày gần nhất
              </option>
            ))}
          </NativeSelect>
          <p className="text-xs text-muted-foreground">
            Tin đã có trong hộp thư sẽ không bị nhân đôi. Hội thoại cũ đã được trả lời sẽ vào mục “Đã xong”.
            Đồng bộ chạy ở nền, có thể mất vài phút.
          </p>
        </div>
        <Alert>
          <Info aria-hidden />
          <AlertDescription className="flex flex-col gap-1.5 text-xs">
            <span>
              Webhook chỉ nhận <strong>tin mới</strong>. Khi Meta App ở chế độ <strong>Phát triển</strong>,
              Facebook chỉ gửi webhook cho tin của người có vai trò trong app; đồng bộ giúp kéo đủ mọi hội
              thoại (tin chỉ về qua đồng bộ định kỳ có thể đến trễ một chu kỳ, mặc định khoảng 1 phút).
            </span>
            <span>
              Muốn <strong>trả lời khách thật</strong>, app cần được Meta duyệt quyền{' '}
              <code className="font-mono">pages_messaging</code> (Advanced Access) và chuyển sang chế độ{' '}
              <strong>Chính thức</strong>.
            </span>
          </AlertDescription>
        </Alert>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Hủy
          </Button>
          <Button type="submit" variant="brand" disabled={mutation.isPending}>
            {mutation.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <History aria-hidden />}
            Đồng bộ
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
