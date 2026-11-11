'use client';

import { AlertTriangle, CheckCircle2, Hand, Loader2, PauseCircle, Play, Siren } from 'lucide-react';
import { isAiPausedIndefinitely, type ConversationSummary } from '@dezon/shared';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';
import {
  aiPausedText,
  chatbotControlState,
  chatbotLockedHint,
  chatbotSelectOptions,
  handoffAckedText,
  handoffButtonLabels,
  handoffReasonLabel,
  isAiPaused,
} from '@/lib/inbox-ai';
import {
  useAckHandoff,
  useChatbotOptions,
  useResolveHandoff,
  useResumeAi,
  useSetConversationChatbot,
} from '@/lib/inbox-ai-queries';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';

const OFF = '';

/**
 * Ô chọn nổi bật "🤖 Chatbot: Tắt / <tên bot>" ở đầu khung chat. Chỉ tô "đang bật" khi ai_mode auto; còn gắn
 * bot mà ai_mode off (sau "Xong" / chuyển người) ⇒ "Bot đang tắt — Bật lại". Đang chờ người ⇒ khóa ô chọn.
 */
export function ChatbotSelect({ conversation: c }: { conversation: ConversationSummary }) {
  const bots = useChatbotOptions();
  const setBot = useSetConversationChatbot(c.id);
  const current = c.chatbot ?? null;
  const options = chatbotSelectOptions(bots.data ?? [], current);
  const state = chatbotControlState(c);
  const on = state === 'on';
  const botOff = state === 'off' && current !== null;
  const locked = state === 'handoff';
  // Bot đang gắn đã bị admin tắt hẳn (is_active false — agent không thấy trong danh sách) thì không "Bật lại"
  // được. Danh sách chưa tải xong thì vẫn cho bấm (máy chủ kiểm lại).
  const canReEnable = botOff && (!bots.data || bots.data.some((b) => b.id === current.id && b.isActive));
  const busy = setBot.isPending || bots.isPending;

  let title = 'Chưa bật chatbot';
  if (locked) title = chatbotLockedHint(current);
  else if (on && current && isAiPausedIndefinitely(c.aiPausedUntil))
    title = `Chatbot "${current.name}" đã dừng vì nhân viên nhắn tin — bấm "Tiếp tục AI" để bot trả lời tiếp`;
  else if (on && current) title = `Chatbot "${current.name}" đang trả lời khách trong hội thoại này`;
  else if (botOff)
    title = `Chatbot "${current.name}" đang tắt cho hội thoại này — bấm "Bật lại" để bot trả lời tiếp`;

  return (
    <label
      className={cn(
        'flex h-8 max-w-full min-w-0 items-center gap-1.5 rounded-full border pr-1 pl-2.5 text-xs transition-colors',
        on
          ? 'border-violet-300 bg-violet-50 text-violet-800'
          : 'border-input bg-background text-muted-foreground',
      )}
      title={title}
    >
      <span aria-hidden>🤖</span>
      <span className="shrink-0 font-medium">Chatbot:</span>
      <select
        aria-label="Chatbot trả lời hội thoại"
        className={cn(
          'h-6 max-w-[11rem] min-w-0 cursor-pointer truncate rounded-full bg-transparent pr-1 text-xs font-semibold outline-none',
          'focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60',
          on ? 'text-violet-900' : botOff ? 'text-muted-foreground' : 'text-foreground',
        )}
        value={current?.id ?? OFF}
        disabled={busy || locked}
        onChange={(e) => {
          const id = e.target.value;
          if (id === (current?.id ?? OFF) && !botOff) return;
          const opt = options.find((o) => o.id === id);
          const bot = id && opt ? { id, name: bots.data?.find((b) => b.id === id)?.name ?? opt.label } : null;
          setBot.mutate(bot);
        }}
      >
        <option value={OFF}>Tắt</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {botOff && (
        <span className="flex shrink-0 items-center gap-1 whitespace-nowrap">
          <span className="text-muted-foreground">Bot đang tắt —</span>
          {canReEnable ? (
            <button
              type="button"
              className="rounded-full px-1.5 py-0.5 font-semibold text-violet-700 hover:bg-violet-50 disabled:opacity-60"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                setBot.mutate(current);
              }}
            >
              Bật lại
            </button>
          ) : (
            <span className="text-muted-foreground">bot đã bị tắt trong Quản trị</span>
          )}
        </span>
      )}
      {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
      {bots.isError && (
        <button
          type="button"
          className="rounded-full p-0.5 text-amber-600 hover:bg-amber-50"
          title="Không tải được danh sách chatbot — bấm để thử lại"
          aria-label="Không tải được danh sách chatbot, thử lại"
          onClick={(e) => {
            e.preventDefault();
            void bots.refetch();
          }}
        >
          <AlertTriangle className="size-3.5" aria-hidden />
        </button>
      )}
    </label>
  );
}

/**
 * Dòng "AI tạm dừng đến HH:mm[ ngày mai | dd/MM] vì nhân viên vừa nhắn" (hoặc "Bot đã dừng vì nhân viên nhắn tin" khi bot dừng
 * hẳn) + nút "Tiếp tục AI".
 */
function AiPausedNotice({ conversation: c }: { conversation: ConversationSummary }) {
  const now = useNow(30_000);
  const resume = useResumeAi(c.id);
  if (!c.chatbot || c.aiMode !== 'auto' || c.status === 'pending_human' || !isAiPaused(c, now)) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-violet-200 bg-violet-50 px-3 py-1.5 text-xs text-violet-900 sm:px-4">
      <span className="flex min-w-0 items-center gap-1.5">
        <PauseCircle className="size-3.5 shrink-0" aria-hidden />
        {aiPausedText(c.aiPausedUntil!, now)}
      </span>
      <Button
        variant="outline"
        size="sm"
        className="ml-auto h-7 border-violet-300 bg-background text-violet-800 hover:bg-violet-100"
        disabled={resume.isPending}
        onClick={() => resume.mutate()}
      >
        {resume.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Play aria-hidden />}
        Tiếp tục AI
      </Button>
    </div>
  );
}

/**
 * Banner đỏ "Cần người: <lý do> — <tóm tắt>" + "Nhận xử lý" / "Đã xong, trả lại cho AI" (bot có thể đặt tên
 * riêng cho hai nút, vd. "Nghiệm thu" / "Đã chuyển tiền").
 */
function HandoffBanner({ conversation: c }: { conversation: ConversationSummary }) {
  const { user } = useAuth();
  const ack = useAckHandoff(c.id);
  const resolve = useResolveHandoff(c.id);
  if (c.status !== 'pending_human') return null;
  const h = c.handoff ?? null;
  const ackedBy = h?.acknowledgedBy ?? null;
  const busy = ack.isPending || resolve.isPending;
  const labels = handoffButtonLabels(c.chatbot);

  return (
    <div
      className="flex flex-col gap-2 border-b border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900 sm:flex-row sm:items-center sm:px-4"
      role="alert"
    >
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <Siren className="mt-0.5 size-4 shrink-0 text-blue-600" aria-hidden />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="font-semibold">
            Cần người: {h ? handoffReasonLabel(h.reasonCode) : 'Hội thoại đang chờ nhân viên xử lý'}
            {h?.summary && <span className="font-normal"> — {h.summary}</span>}
          </p>
          {ackedBy && (
            <p className="text-xs text-blue-800/80">
              {handoffAckedText(labels, ackedBy.id === user?.id ? 'bạn' : ackedBy.name)}
            </p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
        {h && !ackedBy && (
          <Button
            size="sm"
            className="h-8 bg-blue-600 text-white hover:bg-blue-700"
            disabled={busy}
            onClick={() => ack.mutate()}
          >
            {ack.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Hand aria-hidden />}
            {labels.ack}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-8 border-blue-300 bg-background text-blue-800 hover:bg-blue-100"
          disabled={busy}
          onClick={() => resolve.mutate()}
        >
          {resolve.isPending ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <CheckCircle2 aria-hidden />
          )}
          {labels.resolve}
        </Button>
      </div>
    </div>
  );
}

/** Các dải thông báo AI ngay dưới đầu khung chat. */
export function ConversationAiNotices({ conversation }: { conversation: ConversationSummary }) {
  return (
    <>
      <HandoffBanner conversation={conversation} />
      <AiPausedNotice conversation={conversation} />
    </>
  );
}
