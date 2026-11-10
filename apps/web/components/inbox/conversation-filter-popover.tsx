'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import type { ConversationStatus } from '@dezon/shared';
import { NativeSelect } from '@/components/ui/select';
import { Feature } from '@/lib/config';
import type { ConversationFilters } from '@/lib/inbox-api';
import { useDirectory } from '@/lib/inbox-queries';
import { cn } from '@/lib/utils';
import { FilterChip } from './filter-chip';
import { activeAiFilter, applyAiFilter, clearPopoverFilters, countPopoverFilters } from './list-filters';
import { useDismiss } from './use-dismiss';

/** Admin lọc theo một nhân viên cụ thể (agent chỉ thấy hội thoại của mình + chưa phân công nên không cần). */
function AssigneeStaffSelect({
  value,
  onChange,
}: {
  value: ConversationFilters['assignee'];
  onChange: (assignee: ConversationFilters['assignee']) => void;
}) {
  const directory = useDirectory();
  const staffId = value && value !== 'me' && value !== 'none' ? value : '';
  return (
    <NativeSelect
      className="w-full"
      aria-label="Lọc theo nhân viên phụ trách"
      value={staffId}
      onChange={(e) => onChange(e.target.value || undefined)}
      disabled={directory.isPending || directory.isError}
    >
      <option value="">Nhân viên cụ thể...</option>
      {(directory.data ?? []).map((u) => (
        <option key={u.id} value={u.id}>
          {u.name}
        </option>
      ))}
    </NativeSelect>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label={title}>
      <span className="text-xs font-medium text-muted-foreground">{title}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

/** Nút "Bộ lọc" (icon) + popover: trạng thái, người phụ trách, xóa bộ lọc. */
export function ConversationFilterPopover({
  filters,
  onChange,
  isAdmin,
}: {
  filters: ConversationFilters;
  onChange: (update: (f: ConversationFilters) => ConversationFilters) => void;
  isAdmin: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const count = countPopoverFilters(filters);
  const aiFilter = activeAiFilter(filters);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  useDismiss(open, close, [triggerRef, panelRef]);

  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  }, [open]);

  const setStatus = (status: ConversationStatus | undefined) => onChange((f) => ({ ...f, status }));
  const setAssignee = (assignee: ConversationFilters['assignee']) => onChange((f) => ({ ...f, assignee }));

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${id}-panel` : undefined}
        aria-label={count > 0 ? `Bộ lọc (${count} đang bật)` : 'Bộ lọc'}
        title="Bộ lọc"
        onClick={() => (open ? close(false) : setOpen(true))}
        className={cn(
          'relative inline-flex size-8 items-center justify-center rounded-md border bg-background text-muted-foreground shadow-xs outline-none transition-colors hover:bg-accent hover:text-foreground',
          'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
          (open || count > 0) && 'border-brand/60 text-brand',
        )}
      >
        <SlidersHorizontal className="size-4" aria-hidden />
        {count > 0 && (
          <span
            className="absolute -top-1.5 -right-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] leading-none font-semibold text-brand-foreground"
            aria-hidden
          >
            {count}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          id={`${id}-panel`}
          role="dialog"
          aria-label="Bộ lọc hội thoại"
          className="absolute top-full right-0 z-30 mt-1 flex w-[18rem] max-w-[calc(100vw-1.5rem)] flex-col gap-3 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg"
        >
          <Section title="Trạng thái">
            <FilterChip label="Tất cả" active={!filters.status} onClick={() => setStatus(undefined)} />
            <FilterChip
              label="Đang mở"
              active={filters.status === 'open'}
              onClick={() => setStatus('open')}
            />
            <FilterChip
              label="Đã xong"
              active={filters.status === 'resolved'}
              onClick={() => setStatus('resolved')}
            />
          </Section>

          <Feature flag="featureAiEnabled">
            <Section title="Chatbot AI">
              <FilterChip
                label="Tất cả"
                active={aiFilter === 'all'}
                onClick={() => onChange((f) => applyAiFilter(f, 'all'))}
              />
              <FilterChip
                label="Cần người"
                title="Hội thoại AI đã chuyển cho người thật, đang chờ nhân viên"
                active={aiFilter === 'needs_human'}
                onClick={() => onChange((f) => applyAiFilter(f, 'needs_human'))}
              />
              <FilterChip
                label="AI đang lo"
                title="Hội thoại đang có chatbot tự trả lời"
                active={aiFilter === 'ai_handled'}
                onClick={() => onChange((f) => applyAiFilter(f, 'ai_handled'))}
              />
            </Section>
          </Feature>

          <Section title="Người phụ trách">
            <FilterChip label="Mọi người" active={!filters.assignee} onClick={() => setAssignee(undefined)} />
            <FilterChip
              label="Của tôi"
              active={filters.assignee === 'me'}
              onClick={() => setAssignee('me')}
            />
            <FilterChip
              label="Chưa phân công"
              active={filters.assignee === 'none'}
              onClick={() => setAssignee('none')}
            />
          </Section>
          {isAdmin && <AssigneeStaffSelect value={filters.assignee} onChange={setAssignee} />}

          <div className="flex items-center justify-between border-t pt-2">
            <button
              type="button"
              className="rounded text-xs font-medium text-brand outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
              disabled={!filters.status && !filters.assignee && !filters.aiState}
              onClick={() => onChange(clearPopoverFilters)}
            >
              Xóa bộ lọc
            </button>
            <button
              type="button"
              className="rounded px-2 py-1 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onClick={() => close(true)}
            >
              Đóng
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
