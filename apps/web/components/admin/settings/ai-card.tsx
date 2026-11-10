'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Power, RefreshCw } from 'lucide-react';
import type { AiSettings } from '@dezon/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { errorText } from '@/lib/inbox-queries';
import { settingsApi, settingsKeys } from '@/lib/settings-api';
import { cn } from '@/lib/utils';
import { Switch } from '../switch';
import { SettingsSection } from './settings-section';

export function AiCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const query = useQuery({ queryKey: settingsKeys.ai, queryFn: () => settingsApi.getAi() });

  const mutation = useMutation({
    mutationFn: (enabled: boolean) => settingsApi.putAi({ enabled }),
    onMutate: async (enabled) => {
      await qc.cancelQueries({ queryKey: settingsKeys.ai });
      const prev = qc.getQueryData<AiSettings>(settingsKeys.ai);
      qc.setQueryData<AiSettings>(settingsKeys.ai, { enabled });
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(settingsKeys.ai, ctx.prev);
      toast({ title: 'Không đổi được công tắc AI', description: errorText(err), variant: 'destructive' });
    },
    onSuccess: (data) => {
      qc.setQueryData(settingsKeys.ai, data);
      toast({
        title: data.enabled ? 'Đã bật AI' : 'Đã tắt toàn bộ AI',
        description: data.enabled
          ? 'Bot tiếp tục trả lời ở các hội thoại đang gắn bot.'
          : 'Mọi chatbot ngừng trả lời cho tới khi bật lại.',
        variant: 'success',
      });
    },
  });

  function toggle(enabled: boolean) {
    if (
      !enabled &&
      !window.confirm('Tắt AI cho toàn hệ thống? Mọi chatbot sẽ ngừng trả lời ngay ở tất cả hội thoại.')
    ) {
      return;
    }
    mutation.mutate(enabled);
  }

  const enabled = query.data?.enabled ?? false;

  return (
    <SettingsSection
      icon={Power}
      title="Công tắc AI tổng"
      description="Tắt để dừng ngay mọi chatbot trên toàn hệ thống (VD: khi phát hiện bot trả lời sai). Cấu hình bot và việc gắn bot vào hội thoại vẫn được giữ."
      aside={
        query.isSuccess ? (
          <div className="flex items-center gap-2 pt-1">
            {mutation.isPending && (
              <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
            )}
            <Switch
              checked={enabled}
              onCheckedChange={toggle}
              disabled={mutation.isPending}
              aria-label={enabled ? 'Tắt AI toàn hệ thống' : 'Bật AI toàn hệ thống'}
            />
          </div>
        ) : undefined
      }
    >
      {query.isPending ? (
        <Skeleton className="h-10 w-full" aria-hidden />
      ) : query.isError ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col gap-2">
            {errorText(query.error, 'Không tải được trạng thái AI.')}
            <Button variant="outline" size="sm" className="w-fit" onClick={() => void query.refetch()}>
              <RefreshCw aria-hidden />
              Thử lại
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <div
          className={cn(
            'flex items-center gap-2 rounded-lg px-3 py-2 text-sm',
            enabled
              ? 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100'
              : 'bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-100',
          )}
          role="status"
        >
          <span
            className={cn('size-2 rounded-full', enabled ? 'bg-emerald-500' : 'bg-amber-500')}
            aria-hidden
          />
          {enabled
            ? 'AI đang bật — bot trả lời ở những hội thoại được gắn bot (và đúng điều kiện).'
            : 'AI đang tắt — không chatbot nào trả lời, kể cả hội thoại đã gắn bot.'}
        </div>
      )}
    </SettingsSection>
  );
}
