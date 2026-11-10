'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, CopyCheck, Loader2, Plus, RefreshCw, Save, Undo2, X } from 'lucide-react';
import { WEEKDAY_LABELS, WEEKDAYS, type BusinessHours, type Weekday } from '@dezon/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import {
  addRange,
  copyDayToAll,
  fromDraft,
  isDraftDirty,
  MAX_RANGES_PER_DAY,
  normalizeTimeInput,
  removeRange,
  setClosed,
  summarizeDay,
  timezoneOptions,
  toDraft,
  updateRange,
  validateDraft,
  type BusinessHoursDraft,
  type DayDraft,
} from '@/lib/business-hours-editor';
import { errorText } from '@/lib/inbox-queries';
import { settingsApi, settingsKeys } from '@/lib/settings-api';
import { cn } from '@/lib/utils';
import { Switch } from '../switch';
import { SettingsSection } from './settings-section';

const TIME_INPUT =
  'h-9 w-[4.75rem] rounded-md text-center border border-input bg-background px-2 text-sm tabular-nums shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive';

function DayRow({
  day,
  label,
  value,
  validation,
  onChange,
  onCopyToAll,
  onTouched,
  copied,
}: {
  day: Weekday;
  label: string;
  value: DayDraft;
  validation: { ranges: (string | null)[]; day: string | null };
  onChange: (next: DayDraft) => void;
  onCopyToAll: () => void;
  onTouched: () => void;
  copied: boolean;
}) {
  const open = !value.closed;
  return (
    <li className="flex flex-col gap-3 py-3.5 sm:flex-row sm:items-start sm:gap-4">
      <div className="flex items-center gap-3 sm:w-44 sm:shrink-0 sm:pt-1.5">
        <Switch
          size="sm"
          checked={open}
          onCheckedChange={(v) => onChange(setClosed(value, !v))}
          aria-label={`${label}: ${open ? 'đang làm việc, bấm để chuyển thành nghỉ' : 'đang nghỉ, bấm để mở'}`}
        />
        <span className={cn('text-sm font-medium', !open && 'text-muted-foreground')}>{label}</span>
        {!open && <span className="ml-auto text-xs text-muted-foreground sm:hidden">Nghỉ</span>}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {open ? (
          <>
            {value.ranges.map((r, i) => {
              const err = validation.ranges[i];
              const errId = `bh-${day}-${i}-err`;
              return (
                <div key={i} className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={5}
                      placeholder="08:00"
                      value={r.start}
                      onChange={(e) => onChange(updateRange(value, i, { start: e.target.value }))}
                      onBlur={(e) => {
                        onChange(updateRange(value, i, { start: normalizeTimeInput(e.target.value) }));
                        onTouched();
                      }}
                      className={TIME_INPUT}
                      aria-label={`${label} — khung ${i + 1}: giờ bắt đầu`}
                      aria-invalid={!!err}
                      aria-describedby={err ? errId : undefined}
                    />
                    <span className="text-muted-foreground" aria-hidden>
                      –
                    </span>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={5}
                      placeholder="17:30"
                      value={r.end}
                      onChange={(e) => onChange(updateRange(value, i, { end: e.target.value }))}
                      onBlur={(e) => {
                        onChange(updateRange(value, i, { end: normalizeTimeInput(e.target.value) }));
                        onTouched();
                      }}
                      className={TIME_INPUT}
                      aria-label={`${label} — khung ${i + 1}: giờ kết thúc`}
                      aria-invalid={!!err}
                      aria-describedby={err ? errId : undefined}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground hover:text-destructive"
                      onClick={() => onChange(removeRange(value, i))}
                      aria-label={`Xóa khung ${r.start}–${r.end} của ${label}`}
                    >
                      <X aria-hidden />
                    </Button>
                  </div>
                  {err && (
                    <p id={errId} className="text-xs text-destructive">
                      {err}
                    </p>
                  )}
                </div>
              );
            })}
            {validation.day && <p className="text-xs text-destructive">{validation.day}</p>}
          </>
        ) : (
          <p className="hidden text-sm text-muted-foreground sm:block sm:pt-1.5">
            Nghỉ — bot coi là ngoài giờ cả ngày
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1 sm:pt-0.5">
        {open && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange(addRange(value))}
            disabled={value.ranges.length >= MAX_RANGES_PER_DAY}
            title={
              value.ranges.length >= MAX_RANGES_PER_DAY ? `Tối đa ${MAX_RANGES_PER_DAY} khung giờ` : undefined
            }
          >
            <Plus aria-hidden />
            Thêm khung
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCopyToAll}
          className="text-muted-foreground"
          title={`Áp dụng giờ của ${label} (${summarizeDay(value)}) cho cả tuần`}
        >
          <CopyCheck aria-hidden />
          {copied ? 'Đã áp dụng' : 'Áp dụng mọi ngày'}
        </Button>
      </div>
    </li>
  );
}

function Editor({ saved, onDirtyChange }: { saved: BusinessHours; onDirtyChange: (dirty: boolean) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<BusinessHoursDraft>(() => toDraft(saved));
  const [copiedFrom, setCopiedFrom] = useState<Weekday | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  // Ngày đã rời ô giờ (blur) => hiện lỗi của ngày đó; còn lại chờ bấm Lưu để không báo lỗi khi đang gõ.
  const [touched, setTouched] = useState<ReadonlySet<Weekday>>(new Set());
  const validation = validateDraft(draft);
  const dirty = isDraftDirty(draft, saved);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const save = useMutation({
    mutationFn: (body: BusinessHours) => settingsApi.putBusinessHours(body),
    onSuccess: (data) => {
      // Đổi dữ liệu => Editor được dựng lại (key) từ bản đã lưu.
      qc.setQueryData(settingsKeys.businessHours, data);
      toast({ title: 'Đã lưu giờ làm việc', variant: 'success' });
    },
  });

  function onSave() {
    setShowErrors(true);
    if (validation.hasErrors) return;
    save.mutate(fromDraft(draft));
  }

  function setDay(d: Weekday, next: DayDraft) {
    setDraft((prev) => ({ ...prev, days: { ...prev.days, [d]: next } }));
    setCopiedFrom(null);
  }

  const emptyValidation = { ranges: [], day: null };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="text-sm font-medium">Múi giờ</span>
          <NativeSelect
            value={draft.timezone}
            onChange={(e) => setDraft((p) => ({ ...p, timezone: e.target.value }))}
            className="w-full sm:w-80"
          >
            {timezoneOptions(draft.timezone).map((tz) => (
              <option key={tz.value} value={tz.value}>
                {tz.label}
              </option>
            ))}
          </NativeSelect>
        </label>
      </div>

      <ul className="divide-y rounded-lg border bg-background px-3 sm:px-4">
        {WEEKDAYS.map((d) => (
          <DayRow
            key={d}
            day={d}
            label={WEEKDAY_LABELS[d]}
            value={draft.days[d]}
            validation={showErrors || touched.has(d) ? validation.days[d] : emptyValidation}
            onTouched={() => setTouched((prev) => (prev.has(d) ? prev : new Set(prev).add(d)))}
            onChange={(next) => setDay(d, next)}
            onCopyToAll={() => {
              setDraft((prev) => copyDayToAll(prev, d));
              setCopiedFrom(d);
            }}
            copied={copiedFrom === d}
          />
        ))}
      </ul>

      {save.isError && (
        <Alert variant="destructive">
          <AlertDescription>{errorText(save.error, 'Không lưu được giờ làm việc.')}</AlertDescription>
        </Alert>
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
          onClick={() => {
            setDraft(toDraft(saved));
            setShowErrors(false);
            save.reset();
          }}
          disabled={!dirty || save.isPending}
        >
          <Undo2 aria-hidden />
          Hoàn tác
        </Button>
        <Button type="button" variant="brand" size="sm" onClick={onSave} disabled={!dirty || save.isPending}>
          {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
          Lưu giờ làm việc
        </Button>
      </div>
    </div>
  );
}

export function BusinessHoursCard({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const query = useQuery({
    queryKey: settingsKeys.businessHours,
    queryFn: () => settingsApi.getBusinessHours(),
  });
  return (
    <SettingsSection
      icon={Clock}
      title="Giờ làm việc"
      description="Bot biết đang trong hay ngoài giờ để trả lời phù hợp (VD: “Ngoài giờ, nhân viên sẽ gọi lại lúc 8:00 sáng mai”). Mỗi ngày tối đa 4 khung giờ."
    >
      {query.isPending ? (
        <div className="flex flex-col gap-2" aria-hidden>
          <Skeleton className="h-9 w-80" />
          {WEEKDAYS.map((d) => (
            <Skeleton key={d} className="h-10 w-full" />
          ))}
        </div>
      ) : query.isError ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col gap-2">
            {errorText(query.error, 'Không tải được giờ làm việc.')}
            <Button variant="outline" size="sm" className="w-fit" onClick={() => void query.refetch()}>
              <RefreshCw aria-hidden />
              Thử lại
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <Editor key={JSON.stringify(query.data)} saved={query.data} onDirtyChange={onDirtyChange} />
      )}
    </SettingsSection>
  );
}
