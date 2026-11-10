'use client';

// "AI đang soạn tin…": bong bóng ba chấm ở cuối khung chat + dòng xem trước trong danh sách hội thoại.
import { aiTypingLabel } from '@/lib/ai-typing';
import { useAiTyping } from '@/lib/realtime';
import { cn } from '@/lib/utils';

/** Ba chấm nhảy lần lượt (tắt chuyển động khi người dùng chọn giảm chuyển động). */
export function TypingDots({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)} aria-hidden>
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="size-1.5 animate-bounce rounded-full bg-current motion-reduce:animate-none"
          style={{ animationDelay: `${delay}ms`, animationDuration: '1s' }}
        />
      ))}
    </span>
  );
}

/** Bong bóng phía bot (bên phải, tông tím như tin bot) khi bot đang soạn ở hội thoại này. */
export function AiTypingBubble({ conversationId }: { conversationId: string }) {
  const typing = useAiTyping(conversationId);
  if (!typing) return null;
  const label = aiTypingLabel(typing.chatbotName);
  return (
    <div className="flex justify-end" role="status" aria-label={label}>
      <div className="flex max-w-[80%] items-center gap-2 rounded-2xl rounded-br-md border border-violet-200 bg-violet-50/70 px-3 py-2 text-xs text-violet-700 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-300">
        <TypingDots className="text-violet-500" />
        <span className="truncate">{label}</span>
      </div>
    </div>
  );
}

/** Dòng xem trước ở danh sách hội thoại: "AI đang soạn tin…" thay cho tin cuối khi bot đang soạn. */
export function ConversationPreviewText({
  conversationId,
  preview,
  className,
}: {
  conversationId: string;
  preview: string;
  className?: string;
}) {
  const typing = useAiTyping(conversationId);
  if (!typing) return <span className={className}>{preview}</span>;
  return (
    <span
      className={cn(className, 'flex items-center gap-1.5 font-normal text-violet-700 dark:text-violet-300')}
      title={aiTypingLabel(typing.chatbotName)}
    >
      <TypingDots className="shrink-0 text-violet-500" />
      <span className="truncate">AI đang soạn tin…</span>
    </span>
  );
}
