'use client';

import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, ExternalLink, FileText, ImageOff } from 'lucide-react';
import type { MessageAttachmentDto } from '@dezon/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { inboxKeys } from '@/lib/inbox-keys';
import { cn } from '@/lib/utils';

/** Xem ảnh cỡ lớn trong hộp thoại, kèm nút mở tab mới. */
function ImageViewer({ url, name, onClose }: { url: string; name?: string; onClose: () => void }) {
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={name || 'Ảnh'}
      className="max-w-4xl"
      footer={
        <Button variant="outline" asChild>
          <a href={url} target="_blank" rel="noopener noreferrer">
            <ExternalLink aria-hidden />
            Mở trong tab mới
          </a>
        </Button>
      }
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- URL ký có thời hạn từ S3 */}
      <img
        src={url}
        alt={name || 'Ảnh đính kèm'}
        className="mx-auto max-h-[70dvh] w-auto rounded-md object-contain"
      />
    </Dialog>
  );
}

function Unavailable({ label, title }: { label: string; title?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1.5 text-xs opacity-80"
      title={title}
    >
      <ImageOff className="size-3.5" aria-hidden />
      {label}
    </span>
  );
}

/**
 * URL ký hết hạn (TTL ngắn hơn chu kỳ làm mới 20 phút, máy ngủ lâu...): tải lại trang tin để lấy URL mới.
 * Mỗi tệp chỉ thử một lần trong vòng đời bubble để không lặp vô hạn khi S3 thực sự lỗi.
 */
function useRefreshOnMediaError(conversationId: string | undefined) {
  const qc = useQueryClient();
  const tried = useRef(new Set<number>());
  return useCallback(
    (index: number) => {
      if (!conversationId || tried.current.has(index)) return;
      tried.current.add(index);
      void qc.invalidateQueries({ queryKey: inboxKeys.messages(conversationId) });
    },
    [conversationId, qc],
  );
}

export function MessageAttachments({
  attachments,
  outbound,
  conversationId,
  onMediaLoad,
}: {
  attachments: MessageAttachmentDto[];
  outbound: boolean;
  /** Có thì tự làm mới URL ký khi ảnh/video không tải được. */
  conversationId?: string;
  onMediaLoad?: () => void;
}) {
  const [viewing, setViewing] = useState<MessageAttachmentDto | null>(null);
  const onMediaError = useRefreshOnMediaError(conversationId);
  if (attachments.length === 0) return null;

  return (
    <div className={cn('flex flex-wrap gap-1.5', outbound ? 'justify-end' : 'justify-start')}>
      {attachments.map((a, i) => {
        const key = `${a.url ?? a.name ?? 'att'}-${i}`;
        // Không có URL = tải tệp từ nền tảng thất bại; hệ thống không thử lại nên báo rõ cách xử lý.
        if (!a.url) {
          return outbound ? (
            <Unavailable key={key} label="Không hiển thị được tệp" />
          ) : (
            <Unavailable
              key={key}
              label="Không tải được tệp — hãy nhờ khách gửi lại"
              title={a.name ? `Tệp: ${a.name}` : undefined}
            />
          );
        }
        if (a.type === 'image' || a.type === 'sticker') {
          return (
            <button
              key={key}
              type="button"
              onClick={() => setViewing(a)}
              className="overflow-hidden rounded-lg border bg-muted outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              aria-label="Xem ảnh cỡ lớn"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- URL ký có thời hạn từ S3 */}
              <img
                src={a.url}
                alt={a.name || 'Ảnh đính kèm'}
                width={a.width}
                height={a.height}
                loading="lazy"
                onLoad={onMediaLoad}
                onError={() => onMediaError(i)}
                className={cn(
                  'block h-auto max-h-60 w-auto max-w-[min(15rem,60vw)] object-cover',
                  a.type === 'sticker' && 'max-h-28 bg-transparent',
                )}
              />
            </button>
          );
        }
        if (a.type === 'video') {
          return (
            <video
              key={key}
              src={a.url}
              controls
              preload="metadata"
              onLoadedMetadata={onMediaLoad}
              onError={() => onMediaError(i)}
              className="max-h-60 max-w-[min(18rem,70vw)] rounded-lg border bg-black"
            />
          );
        }
        if (a.type === 'audio') {
          return (
            <audio key={key} src={a.url} controls preload="metadata" className="max-w-[min(18rem,70vw)]" />
          );
        }
        return (
          <a
            key={key}
            href={a.url}
            target="_blank"
            rel="noopener noreferrer"
            download={a.name}
            className={cn(
              'flex max-w-[min(18rem,70vw)] items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-accent',
              outbound ? 'border-brand/30 bg-brand/5' : 'bg-background',
            )}
          >
            <FileText className="size-5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{a.name || 'Tệp đính kèm'}</span>
            <Download className="size-4 shrink-0" aria-label="Tải xuống" />
          </a>
        );
      })}
      {viewing?.url && <ImageViewer url={viewing.url} name={viewing.name} onClose={() => setViewing(null)} />}
    </div>
  );
}
