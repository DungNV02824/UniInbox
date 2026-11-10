'use client';

import { useEffect, useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  KeyRound,
  Loader2,
  RefreshCw,
  Save,
  Send,
  Trash2,
  Undo2,
  Webhook,
  XCircle,
} from 'lucide-react';
import { updateLarkSettingsSchema, type LarkSettingsDto } from '@dezon/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { errorText } from '@/lib/inbox-queries';
import {
  buildLarkRequest,
  isLarkDirty,
  settingsApi,
  settingsKeys,
  type LarkFormValues,
} from '@/lib/settings-api';
import { Field } from '../chatbots/fields';
import { SettingsSection } from './settings-section';

function LarkForm({
  saved,
  onDirtyChange,
}: {
  saved: LarkSettingsDto;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const id = useId();
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<LarkFormValues>({
    webhookUrl: saved.webhookUrl ?? '',
    secret: { mode: 'keep' },
  });
  const [urlError, setUrlError] = useState<string | null>(null);
  const dirty = isLarkDirty(form, saved);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const save = useMutation({
    mutationFn: settingsApi.putLark,
    onSuccess: (data) => {
      qc.setQueryData(settingsKeys.lark, data);
      toast({ title: 'Đã lưu cấu hình Lark', variant: 'success' });
    },
  });

  const test = useMutation({ mutationFn: () => settingsApi.testLark() });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const body = buildLarkRequest(form);
    const parsed = updateLarkSettingsSchema.safeParse(body);
    if (!parsed.success) {
      setUrlError('Webhook phải là URL https hợp lệ (tối đa 500 ký tự).');
      return;
    }
    setUrlError(null);
    test.reset();
    save.mutate(parsed.data);
  }

  const secretSaved = saved.hasSecret && form.secret.mode === 'keep';
  const secretValue = form.secret.mode === 'set' ? form.secret.value : '';

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Field
        label="Webhook URL của bot nhóm Lark"
        htmlFor={`${id}-url`}
        error={urlError}
        errorId={`${id}-url-err`}
        hint="Trong nhóm Lark: Cài đặt → Bot → Thêm bot → Custom Bot, chép Webhook URL dán vào đây. Để trống = không gửi Lark."
      >
        <Input
          id={`${id}-url`}
          type="url"
          inputMode="url"
          value={form.webhookUrl}
          onChange={(e) => {
            setForm((f) => ({ ...f, webhookUrl: e.target.value }));
            setUrlError(null);
          }}
          placeholder="https://open.larksuite.com/open-apis/bot/v2/hook/…"
          aria-invalid={!!urlError}
          aria-describedby={urlError ? `${id}-url-err` : undefined}
          className="font-mono text-xs md:text-xs"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>

      <Field
        label="Secret ký tin (tùy chọn)"
        htmlFor={`${id}-secret`}
        hint={
          form.secret.mode === 'clear'
            ? 'Secret sẽ bị xóa khi bấm Lưu.'
            : 'Nếu bot Lark bật “Signature verification”, dán secret vào đây. Secret được mã hóa và không bao giờ hiển thị lại.'
        }
        aside={
          secretSaved ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="size-3.5" aria-hidden />
              Đã lưu
            </span>
          ) : undefined
        }
      >
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <KeyRound
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id={`${id}-secret`}
              type="password"
              value={secretValue}
              onChange={(e) => setForm((f) => ({ ...f, secret: { mode: 'set', value: e.target.value } }))}
              placeholder={
                form.secret.mode === 'clear'
                  ? 'Sẽ xóa secret'
                  : saved.hasSecret
                    ? '•••••••• (đã lưu — nhập để thay secret mới)'
                    : 'Chưa có secret'
              }
              className="pl-8"
              autoComplete="new-password"
              disabled={form.secret.mode === 'clear'}
            />
          </div>
          {saved.hasSecret && form.secret.mode !== 'clear' && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setForm((f) => ({ ...f, secret: { mode: 'clear' } }))}
              aria-label="Xóa secret đã lưu"
            >
              <Trash2 aria-hidden />
              <span className="hidden sm:inline">Xóa</span>
            </Button>
          )}
          {form.secret.mode === 'clear' && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setForm((f) => ({ ...f, secret: { mode: 'keep' } }))}
            >
              <Undo2 aria-hidden />
              Giữ lại
            </Button>
          )}
        </div>
      </Field>

      {save.isError && (
        <Alert variant="destructive">
          <AlertDescription>{errorText(save.error, 'Không lưu được cấu hình Lark.')}</AlertDescription>
        </Alert>
      )}

      {test.isSuccess && (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
          Đã gửi thẻ thử. Kiểm tra nhóm Lark — thẻ có nút “Mở hội thoại”.
        </div>
      )}
      {test.isError && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            <span className="font-medium">Gửi thử thất bại:</span>{' '}
            {errorText(test.error, 'Lark không nhận thẻ.')}
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {dirty && (
          <span className="mr-auto inline-flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
            <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />
            Có thay đổi chưa lưu
          </span>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => test.mutate()}
          disabled={!saved.webhookUrl || dirty || test.isPending || save.isPending}
          title={
            !saved.webhookUrl
              ? 'Lưu Webhook URL trước khi gửi thử'
              : dirty
                ? 'Lưu thay đổi trước khi gửi thử'
                : 'Gửi một thẻ thử vào nhóm Lark'
          }
        >
          {test.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
          Gửi thử
        </Button>
        <Button type="submit" variant="brand" size="sm" disabled={!dirty || save.isPending}>
          {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
          Lưu
        </Button>
      </div>
    </form>
  );
}

export function LarkCard({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const query = useQuery({ queryKey: settingsKeys.lark, queryFn: () => settingsApi.getLark() });
  return (
    <SettingsSection
      icon={Webhook}
      title="Thông báo Lark"
      description="Khi bot chuyển hội thoại cho người thật, hệ thống gửi thẻ vào nhóm Lark (tên khách, Trang, lý do, tóm tắt, nút mở hội thoại) và nhắc lại nếu 15 phút chưa ai nhận. Thông báo trong hệ thống luôn bật."
    >
      {query.isPending ? (
        <div className="flex flex-col gap-3" aria-hidden>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : query.isError ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col gap-2">
            {errorText(query.error, 'Không tải được cấu hình Lark.')}
            <Button variant="outline" size="sm" className="w-fit" onClick={() => void query.refetch()}>
              <RefreshCw aria-hidden />
              Thử lại
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <LarkForm key={JSON.stringify(query.data)} saved={query.data} onDirtyChange={onDirtyChange} />
      )}
    </SettingsSection>
  );
}
