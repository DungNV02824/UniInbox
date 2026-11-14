'use client';

import { useId, useState } from 'react';
import { ChevronDown, MapPin, Trash2 } from 'lucide-react';
import type { ProjectLogDto } from '@dezon/shared';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/inbox-format';
import { useDeleteProjectLog } from '@/lib/inbox-queries';
import { requestMessageJump } from '@/lib/message-jump';
import { canJumpToProjectLog, projectLogJumpTarget, projectLogView } from '@/lib/project-logs';
import { cn } from '@/lib/utils';

function LogItem({
  log,
  onJump,
  onDelete,
  deleting,
}: {
  log: ProjectLogDto;
  onJump: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const view = projectLogView(log);
  const empty = !view.title && view.lines.length === 0;
  return (
    <li className="relative">
      <button
        type="button"
        onClick={onJump}
        title="Xem tin nhắn và ảnh của công trình này"
        className="flex w-full flex-col gap-1 rounded-md border bg-background p-2 pr-9 text-left text-xs transition-colors outline-none hover:border-brand/40 hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <time dateTime={log.createdAt} className="text-[11px] text-muted-foreground">
          {formatDateTime(log.createdAt)}
        </time>
        {view.title && (
          <span className="flex items-start gap-1 text-sm font-medium break-words text-foreground">
            <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0">{view.title}</span>
          </span>
        )}
        {view.lines.map((f) => (
          <span key={f.key} className="break-words">
            <span className="text-muted-foreground">{f.label}:</span>{' '}
            <span className="text-foreground/90">{f.value}</span>
          </span>
        ))}
        {empty && <span className="text-muted-foreground italic">Chưa đọc được thông tin công trình</span>}
      </button>
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-1 right-1 size-7 text-muted-foreground hover:text-destructive"
        aria-label="Xóa dòng nhật ký này"
        title="Xóa dòng nhật ký"
        disabled={deleting}
        onClick={onDelete}
      >
        <Trash2 aria-hidden />
      </Button>
    </li>
  );
}

/**
 * "Nhật ký công trình": mỗi công trình bot đã xác nhận tiếp nhận là một dòng (mới nhất trước). Bấm một dòng ⇒
 * khung chat cuộn tới các tin (kèm ảnh) của lượt đó và làm nổi chúng.
 */
export function ProjectLogSection({
  conversationId,
  logs,
  onJump,
}: {
  conversationId: string;
  logs: readonly ProjectLogDto[];
  /** Gọi trước khi cuộn (vd. đóng khung Thông tin khách trên điện thoại để thấy khung chat). */
  onJump?: () => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(true);
  const remove = useDeleteProjectLog(conversationId);
  const toast = useToast();

  const jump = (log: ProjectLogDto) => {
    if (!canJumpToProjectLog(log)) {
      toast({ title: 'Dòng nhật ký này không gắn với tin nhắn nào', variant: 'destructive' });
      return;
    }
    onJump?.();
    const target = projectLogJumpTarget(log);
    requestMessageJump(conversationId, target.anchorId, target.highlightIds, { notBefore: target.notBefore });
  };

  const confirmDelete = (log: ProjectLogDto) => {
    if (!window.confirm('Xóa dòng nhật ký này?')) return;
    remove.mutate(log.id);
  };

  return (
    <section className="flex flex-col gap-2 border-b p-4 last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-body`}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <ChevronDown className={cn('size-3.5 transition-transform', !open && '-rotate-90')} aria-hidden />
        Nhật ký công trình
        <span
          className="ml-1 rounded-full bg-muted px-1.5 py-px text-[11px] font-medium tracking-normal text-muted-foreground tabular-nums"
          aria-label={`${logs.length} công trình`}
        >
          {logs.length}
        </span>
      </button>
      {open && (
        <div id={`${id}-body`}>
          {logs.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Chưa có công trình nào. Khi bot xác nhận tiếp nhận bộ ảnh, công trình sẽ hiện ở đây.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {logs.map((log) => (
                <LogItem
                  key={log.id}
                  log={log}
                  onJump={() => jump(log)}
                  onDelete={() => confirmDelete(log)}
                  deleting={remove.isPending && remove.variables === log.id}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
