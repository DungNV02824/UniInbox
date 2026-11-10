'use client';

import { useId, useState } from 'react';
import { ChevronDown, Loader2, RefreshCw } from 'lucide-react';
import type { AiRunDto } from '@dezon/shared';
import { Button } from '@/components/ui/button';
import { AI_RUN_DECISION_LABELS, AI_RUN_DECISION_TONES, formatLatency } from '@/lib/inbox-ai';
import { useAiRuns } from '@/lib/inbox-ai-queries';
import { formatDateTime } from '@/lib/inbox-format';
import { errorText } from '@/lib/inbox-queries';
import { cn } from '@/lib/utils';

function RunItem({ run }: { run: AiRunDto }) {
  const note = run.error || run.reasoningSummary;
  return (
    <li className="flex flex-col gap-1 rounded-md border bg-background p-2 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={cn(
            'rounded border px-1.5 py-px text-[11px] font-medium',
            AI_RUN_DECISION_TONES[run.decision] ?? AI_RUN_DECISION_TONES.no_reply,
          )}
        >
          {AI_RUN_DECISION_LABELS[run.decision] ?? run.decision}
        </span>
        <time dateTime={run.createdAt} className="ml-auto text-muted-foreground">
          {formatDateTime(run.createdAt)}
        </time>
      </div>
      <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-muted-foreground">
        {run.chatbotName && <span className="font-medium text-foreground/80">🤖 {run.chatbotName}</span>}
        <span className="break-all">{run.model || '—'}</span>
        <span>{formatLatency(run.latencyMs)}</span>
        <span title="Token vào / ra">
          {run.inputTokens.toLocaleString('vi-VN')} / {run.outputTokens.toLocaleString('vi-VN')} token
        </span>
      </div>
      {note && (
        <p
          className={cn(
            'break-words whitespace-pre-wrap',
            run.error ? 'text-destructive' : 'text-foreground/80',
          )}
        >
          {note}
        </p>
      )}
    </li>
  );
}

/** "Nhật ký AI" (chỉ admin): 20 lần chạy AI gần nhất của hội thoại, mở ra mới tải. */
export function AiRunsSection({ conversationId }: { conversationId: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const runs = useAiRuns(conversationId, open);

  return (
    <section className="flex flex-col gap-2 border-b p-4 last:border-b-0">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 items-center gap-1 rounded text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <ChevronDown className={cn('size-3.5 transition-transform', !open && '-rotate-90')} aria-hidden />
          Nhật ký AI
        </button>
        {open && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Tải lại nhật ký AI"
            disabled={runs.isFetching}
            onClick={() => void runs.refetch()}
          >
            <RefreshCw className={cn(runs.isFetching && 'animate-spin')} aria-hidden />
          </Button>
        )}
      </div>
      {open && (
        <div id={`${id}-body`}>
          {runs.isPending ? (
            <div className="flex justify-center py-3">
              <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
            </div>
          ) : runs.isError ? (
            <p className="text-xs text-destructive">{errorText(runs.error, 'Không tải được nhật ký AI.')}</p>
          ) : runs.data.length === 0 ? (
            <p className="text-xs text-muted-foreground">Chưa có lần chạy AI nào.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {runs.data.map((run) => (
                <RunItem key={run.id} run={run} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
