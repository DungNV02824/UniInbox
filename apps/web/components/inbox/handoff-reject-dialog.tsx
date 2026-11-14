'use client';

import { useId, useState, type FormEvent } from 'react';
import { AlertCircle, Loader2, Send } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import {
  REJECT_REASON_MAX,
  rejectErrorText,
  rejectHandoffBody,
  rejectReasonError,
  rejectReasonLength,
} from '@/lib/handoff-reject';
import type { useRejectHandoff } from '@/lib/inbox-ai-queries';

const PLACEHOLDER =
  'Vd: Công trình mới làm móng, chưa lên tầng; công trình dự án lớn bên em không nghiệm thu';

/**
 * Hộp thoại "Không đạt": nhân viên gõ lý do ⇒ AI (giọng văn của bot đang gắn) soạn tin báo khách khéo léo rồi
 * gửi ngay. Banner Cần người giữ nguyên. Gửi lỗi ⇒ giữ lý do đã gõ, báo lỗi ngay trong hộp thoại.
 */
export function HandoffRejectDialog({
  reject,
  onClose,
}: {
  /** Mutation tạo ở banner (để banner khóa các nút khác khi đang gửi). */
  reject: ReturnType<typeof useRejectHandoff>;
  onClose: () => void;
}) {
  const toast = useToast();
  const id = useId();
  const hintId = `${id}-hint`;
  const [reason, setReason] = useState('');
  // Chỉ báo "chưa nhập lý do" sau khi bấm gửi (mới mở hộp thoại thì không đỏ sẵn).
  const [submitted, setSubmitted] = useState(false);
  const pending = reject.isPending;
  const error = rejectReasonError(reason, submitted);
  const length = rejectReasonLength(reason);

  function close() {
    if (pending) return;
    reject.reset();
    onClose();
  }

  function onSubmit(e?: FormEvent) {
    e?.preventDefault();
    if (pending) return;
    setSubmitted(true);
    const body = rejectHandoffBody(reason);
    if (!body) return;
    reject.mutate(body, {
      onSuccess: () => {
        toast({
          title: 'Đã gửi tin báo không đạt cho khách',
          description: 'Banner Cần người vẫn giữ nguyên.',
          variant: 'success',
        });
        reject.reset();
        onClose();
      },
    });
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      title="Không đạt — AI trả lời khách"
      description="AI sẽ dựa vào lý do này và giọng văn của bot để soạn tin báo khách khéo léo rồi gửi ngay. Banner Cần người vẫn giữ nguyên."
      footer={
        <>
          <Button type="button" variant="outline" onClick={close} disabled={pending}>
            Hủy
          </Button>
          <Button type="submit" form={`${id}-form`} disabled={pending || (submitted && !!error)}>
            {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
            {pending ? 'AI đang soạn và gửi…' : 'AI trả lời khách'}
          </Button>
        </>
      }
    >
      <form id={`${id}-form`} className="flex flex-col gap-1.5" onSubmit={onSubmit} noValidate>
        <Label htmlFor={`${id}-reason`}>Lý do không đạt</Label>
        <Textarea
          id={`${id}-reason`}
          data-autofocus
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            if (reject.isError) reject.reset();
          }}
          onKeyDown={(e) => {
            // Ctrl/⌘ + Enter ⇒ gửi luôn.
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onSubmit();
          }}
          placeholder={PLACEHOLDER}
          rows={4}
          className="max-h-64 min-h-24 resize-y"
          aria-invalid={!!error}
          aria-describedby={hintId}
          disabled={pending}
        />
        <p
          id={hintId}
          className={`flex justify-between gap-3 text-xs ${error ? 'text-destructive' : 'text-muted-foreground'}`}
        >
          <span>
            {error ?? 'Ghi ngắn gọn lý do (và cách khắc phục nếu có) — AI sẽ diễn đạt lại cho khách.'}
          </span>
          <span className="shrink-0 tabular-nums">
            {length}/{REJECT_REASON_MAX}
          </span>
        </p>
      </form>

      {reject.isError && (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertDescription>{rejectErrorText(reject.error)}</AlertDescription>
        </Alert>
      )}
    </Dialog>
  );
}
