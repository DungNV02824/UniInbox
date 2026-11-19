'use client';

import { useState } from 'react';
import { AlertCircle, AlertTriangle, Loader2, Play } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import {
  AI_OUTAGE_ADMIN_HINT,
  AI_OUTAGE_CONFIRM_TITLE,
  AI_OUTAGE_PENDING_LABEL,
  AI_OUTAGE_RESUME_LABEL,
  aiOutageCanResume,
  aiOutageConfirmText,
  aiOutageErrorText,
  aiOutageStripText,
  aiOutageView,
  type AiOutageView,
} from '@/lib/ai-outage';
import { useAuth } from '@/lib/auth';
import { useAiOutageStatus, useResumeAiOutage } from '@/lib/inbox-ai-queries';
import { cn } from '@/lib/utils';

/**
 * Hộp thoại xác nhận "Bật lại AI?": máy chủ gọi thử AI; được ⇒ toast (trong hook) và đóng; lỗi ⇒ giữ hộp thoại,
 * hiện lời máy chủ (vd. "AI vẫn chưa hoạt động lại: hết hạn mức…").
 */
function AiOutageResumeDialog({ status, onClose }: { status: AiOutageView; onClose: () => void }) {
  const resume = useResumeAiOutage();
  const pending = resume.isPending;

  function close() {
    if (pending) return;
    resume.reset();
    onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      title={AI_OUTAGE_CONFIRM_TITLE}
      description={aiOutageConfirmText(status)}
      footer={
        <>
          <Button type="button" variant="outline" onClick={close} disabled={pending}>
            Hủy
          </Button>
          <Button
            type="button"
            data-autofocus
            disabled={pending}
            onClick={() => resume.mutate(undefined, { onSuccess: () => onClose() })}
          >
            {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Play aria-hidden />}
            {pending ? AI_OUTAGE_PENDING_LABEL : AI_OUTAGE_RESUME_LABEL}
          </Button>
        </>
      }
    >
      {resume.isError && (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertDescription>{aiOutageErrorText(resume.error)}</AlertDescription>
        </Alert>
      )}
    </Dialog>
  );
}

/**
 * Nút mở hộp thoại "Bật lại AI?" (dải đầu danh sách và banner Cần người). Công tắc AI chung đang tắt mà người xem
 * không phải admin ⇒ thay nút bằng lời nhắc "Nhờ quản trị viên bật lại AI" (máy chủ sẽ trả 403).
 */
export function AiOutageResumeButton({
  label = AI_OUTAGE_RESUME_LABEL,
  className,
}: {
  label?: string;
  className?: string;
}) {
  const { user } = useAuth();
  const status = aiOutageView(useAiOutageStatus().data);
  const [open, setOpen] = useState(false);
  if (!aiOutageCanResume(status, user?.role))
    return <span className={cn('shrink-0 text-xs italic', className)}>{AI_OUTAGE_ADMIN_HINT}</span>;
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={cn(
          'h-7 shrink-0 border-amber-400 bg-background px-2.5 text-xs text-amber-900 hover:bg-amber-100 hover:text-amber-950',
          className,
        )}
        onClick={() => setOpen(true)}
      >
        <Play aria-hidden />
        {label}
      </Button>
      {open && <AiOutageResumeDialog status={status} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Dải vàng mảnh đầu danh sách hội thoại: "⚠ AI đang tắt toàn hệ thống · N hội thoại chờ bot trả lời" hoặc
 * "⚠ N hội thoại đang chờ vì AI lỗi…" + "Bật lại AI". Không có gì đáng báo ⇒ ẩn.
 */
export function AiOutageStrip() {
  const status = useAiOutageStatus();
  const text = aiOutageStripText(aiOutageView(status.data));
  if (!text) return null;
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900"
      role="status"
    >
      <span className="flex min-w-0 flex-1 items-start gap-1.5">
        <AlertTriangle className="mt-px size-3.5 shrink-0 text-amber-600" aria-hidden />
        <span className="min-w-0">{text}</span>
      </span>
      <AiOutageResumeButton className="ml-auto" />
    </div>
  );
}
