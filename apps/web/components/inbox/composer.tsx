'use client';

import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { AlertCircle, FileText, Loader2, Lock, Paperclip, SendHorizonal, X } from 'lucide-react';
import {
  COMPOSER_TEXT_MAX_CHARS,
  type ConversationSummary,
  type MessageAttachmentDto,
  type OutboundAttachmentInput,
  type UploadedMediaDto,
} from '@dezon/shared';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/lib/auth';
import { inboxApi } from '@/lib/inbox-api';
import { formatFileSize } from '@/lib/inbox-format';
import { errorText } from '@/lib/inbox-queries';
import { sendWindowState } from '@/lib/send-window';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import { getDraft, setDraft } from './composer-drafts';
import { enterSends, useCoarsePointer } from './composer-keys';

const MAX_ATTACHMENTS = 10;
const MAX_TEXTAREA_PX = 160;

interface PendingUpload {
  localId: string;
  file: File;
  /** object URL để xem trước ảnh ngay khi đang upload */
  previewUrl: string | null;
  status: 'uploading' | 'done' | 'error';
  result?: UploadedMediaDto;
  error?: string;
}

function toOutbound(r: UploadedMediaDto): OutboundAttachmentInput {
  return {
    storageKey: r.storageKey,
    type: r.type,
    mime: r.mime,
    ...(r.width !== undefined && { width: r.width }),
    ...(r.height !== undefined && { height: r.height }),
    ...(r.name !== undefined && { name: r.name }),
  };
}

function toPreview(r: UploadedMediaDto): MessageAttachmentDto {
  return { type: r.type, mime: r.mime, url: r.url, width: r.width, height: r.height, name: r.name };
}

/** Lý do khóa ô soạn (null = gửi được). */
export function composerLockReason(
  conv: ConversationSummary,
  now: number,
  canViewConv: boolean,
): string | null {
  if (!canViewConv) return 'Bạn không còn quyền trả lời hội thoại này.';
  if (conv.channel.status !== 'connected') {
    return `Kênh "${conv.channel.displayName}" đang mất kết nối. Quản trị viên cần kết nối lại trong trang Kênh.`;
  }
  const state = sendWindowState(conv.sendWindow, now);
  return state.canSend ? null : (state.reason ?? 'Không thể gửi tin lúc này.');
}

export function Composer({
  conversation,
  canViewConv,
  onSend,
}: {
  conversation: ConversationSummary;
  canViewConv: boolean;
  onSend: (input: {
    text?: string;
    attachments: OutboundAttachmentInput[];
    preview: MessageAttachmentDto[];
  }) => void;
}) {
  const id = conversation.id;
  const userId = useAuth().user?.id;
  const coarse = useCoarsePointer();
  const [text, setText] = useState(() => getDraft(userId, id));
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadsRef = useRef(uploads);
  const now = useNow(5000);

  const lockReason = composerLockReason(conversation, now, canViewConv);
  const locked = lockReason !== null;
  const uploading = uploads.some((u) => u.status === 'uploading');
  const ready = uploads.filter((u) => u.status === 'done' && u.result);
  const tooLong = text.length > COMPOSER_TEXT_MAX_CHARS;
  const canSubmit = !locked && !uploading && !tooLong && (text.trim().length > 0 || ready.length > 0);

  useEffect(() => {
    uploadsRef.current = uploads;
  }, [uploads]);

  // Thu hồi object URL khi rời hội thoại.
  useEffect(
    () => () => {
      for (const u of uploadsRef.current) if (u.previewUrl) URL.revokeObjectURL(u.previewUrl);
    },
    [],
  );

  useEffect(() => {
    setDraft(userId, id, text);
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // scrollHeight không gồm viền: cộng thêm để không hiện thanh cuộn khi chưa tới chiều cao tối đa.
    const border = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(el.scrollHeight + border, MAX_TEXTAREA_PX)}px`;
  }, [userId, id, text]);

  function addFiles(files: File[]) {
    const room = MAX_ATTACHMENTS - uploadsRef.current.length;
    const accepted = files.slice(0, Math.max(0, room));
    const entries: PendingUpload[] = accepted.map((file) => ({
      localId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      status: 'uploading',
    }));
    setUploads((list) => [...list, ...entries]);
    for (const entry of entries) {
      inboxApi
        .uploadMedia(entry.file)
        .then((result) =>
          setUploads((list) =>
            list.map((u) => (u.localId === entry.localId ? { ...u, status: 'done', result } : u)),
          ),
        )
        .catch((err: unknown) =>
          setUploads((list) =>
            list.map((u) =>
              u.localId === entry.localId
                ? { ...u, status: 'error', error: errorText(err, 'Tải tệp lên thất bại') }
                : u,
            ),
          ),
        );
    }
  }

  function removeUpload(localId: string) {
    setUploads((list) => {
      const target = list.find((u) => u.localId === localId);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return list.filter((u) => u.localId !== localId);
    });
  }

  function submit() {
    if (!canSubmit) return;
    const trimmed = text.trim();
    const results = ready.map((u) => u.result!);
    onSend({
      text: trimmed || undefined,
      attachments: results.map(toOutbound),
      preview: results.map(toPreview),
    });
    setText('');
    for (const u of uploads) if (u.previewUrl) URL.revokeObjectURL(u.previewUrl);
    setUploads([]);
    textareaRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (enterSends({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing }, coarse)) {
      e.preventDefault();
      submit();
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.files);
    if (files.length > 0 && !locked) {
      e.preventDefault();
      addFiles(files);
    }
  }

  if (locked) {
    return (
      <div className="shrink-0 border-t bg-muted/40 p-3">
        <div className="flex items-start gap-2 rounded-md border border-dashed bg-background px-3 py-2.5 text-sm text-muted-foreground">
          <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            <span className="font-medium text-foreground">Không thể gửi tin. </span>
            {lockReason}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t p-3">
      {uploads.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Tệp đính kèm">
          {uploads.map((u) => (
            <li
              key={u.localId}
              className={cn(
                'relative flex h-16 items-center gap-2 overflow-hidden rounded-md border bg-muted text-xs',
                u.previewUrl ? 'w-16' : 'max-w-48 px-2 pr-7',
                u.status === 'error' && 'border-destructive/60',
              )}
              title={u.error ?? `${u.file.name} · ${formatFileSize(u.file.size)}`}
            >
              {u.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- object URL xem trước tại máy
                <img src={u.previewUrl} alt={u.file.name} className="size-full object-cover" />
              ) : (
                <>
                  <FileText className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 truncate">{u.file.name}</span>
                </>
              )}
              {u.status === 'uploading' && (
                <span className="absolute inset-0 flex items-center justify-center bg-background/60">
                  <Loader2 className="size-4 animate-spin" aria-label="Đang tải lên" />
                </span>
              )}
              {u.status === 'error' && (
                <span className="absolute inset-0 flex items-center justify-center bg-destructive/15 text-destructive">
                  <AlertCircle className="size-4" aria-label={u.error ?? 'Lỗi tải lên'} />
                </span>
              )}
              <button
                type="button"
                onClick={() => removeUpload(u.localId)}
                className="absolute top-0.5 right-0.5 rounded-full bg-background/90 p-0.5 shadow-sm hover:bg-background"
                aria-label={`Bỏ tệp ${u.file.name}`}
              >
                <X className="size-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {uploads.some((u) => u.status === 'error') && (
        <p className="text-xs text-destructive">
          {uploads.find((u) => u.status === 'error')?.error} — bỏ tệp lỗi để gửi phần còn lại.
        </p>
      )}

      <div className="flex items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => fileRef.current?.click()}
          disabled={uploads.length >= MAX_ATTACHMENTS}
          aria-label="Đính kèm ảnh hoặc tệp"
          title="Đính kèm ảnh hoặc tệp"
        >
          <Paperclip aria-hidden />
        </Button>
        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={1}
          placeholder={
            coarse ? 'Nhập tin nhắn...' : 'Nhập tin nhắn... (Enter để gửi, Shift+Enter xuống dòng)'
          }
          enterKeyHint={coarse ? 'enter' : 'send'}
          aria-label="Nội dung tin nhắn"
          aria-invalid={tooLong || undefined}
          className="max-h-40 min-h-9 resize-none py-2"
        />
        <Button
          type="button"
          variant="brand"
          size="icon"
          onClick={submit}
          disabled={!canSubmit}
          aria-label="Gửi"
        >
          {uploading ? <Loader2 className="animate-spin" aria-hidden /> : <SendHorizonal aria-hidden />}
        </Button>
      </div>
      {tooLong && (
        <p className="text-xs text-destructive">
          Tin nhắn quá dài ({text.length}/{COMPOSER_TEXT_MAX_CHARS} ký tự).
        </p>
      )}
    </div>
  );
}
