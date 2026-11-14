'use client';

import { useState } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Hand,
  Loader2,
  PauseCircle,
  Play,
  Siren,
} from 'lucide-react';
import { isAiPausedIndefinitely, type ConversationSummary } from '@dezon/shared';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';
import { useHandoffBannerCollapsed } from '@/lib/handoff-banner-pref';
import {
  aiPausedText,
  botContinuesDuringHandoff,
  chatbotControlState,
  chatbotLockedHint,
  chatbotSelectOptions,
  handoffAckedText,
  handoffBotNote,
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
/** Tóm tắt dài hơn mức này (≈ 2 dòng ở khung chat hẹp) mới hiện nút "Xem thêm". */
const SUMMARY_CLAMP_CHARS = 140;

/**
 * Ô chọn nổi bật "🤖 Chatbot: Tắt / <tên bot>" ở đầu khung chat. Chỉ tô "đang bật" khi ai_mode auto; còn gắn
 * bot mà ai_mode off (sau "Xong" / chuyển người) ⇒ "Bot đang tắt — Bật lại". Đang chờ người ⇒ khóa ô chọn
 * (bot đặt "vẫn trả lời khách" thì vẫn tô "đang bật").
 */
export function ChatbotSelect({ conversation: c }: { conversation: ConversationSummary }) {
  const bots = useChatbotOptions();
  const setBot = useSetConversationChatbot(c.id);
  const current = c.chatbot ?? null;
  const options = chatbotSelectOptions(bots.data ?? [], current);
  const state = chatbotControlState(c);
  const locked = state === 'handoff';
  // Chờ người nhưng bot đặt "vẫn trả lời khách": ô vẫn khóa (đóng yêu cầu bằng nút trên banner) nhưng tô "đang bật".
  const continuing = locked && botContinuesDuringHandoff(c);
  const on = state === 'on' || continuing;
  const botOff = state === 'off' && current !== null;
  // Bot đang gắn đã bị admin tắt hẳn (is_active false — agent không thấy trong danh sách) thì không "Bật lại"
  // được. Danh sách chưa tải xong thì vẫn cho bấm (máy chủ kiểm lại).
  const canReEnable = botOff && (!bots.data || bots.data.some((b) => b.id === current.id && b.isActive));
  const busy = setBot.isPending || bots.isPending;

  let title = 'Chưa bật chatbot';
  if (continuing && current)
    title = `Chatbot "${current.name}" vẫn đang trả lời khách trong lúc chờ nhân viên xử lý`;
  else if (locked) title = chatbotLockedHint(current);
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
  // Chờ người ở chế độ bot dừng ⇒ banner "Cần người" đã nói; bot vẫn trả lời khi chờ người ⇒ vẫn báo tạm dừng.
  if (!c.chatbot || c.aiMode !== 'auto' || !isAiPaused(c, now)) return null;
  if (c.status === 'pending_human' && !botContinuesDuringHandoff(c)) return null;
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
 * riêng cho hai nút, vd. "Nghiệm thu" / "Đã chuyển tiền"). Bot đặt "vẫn trả lời khách" ⇒ thêm dòng "Bot vẫn đang
 * trả lời khách" (nút nhận chỉ ghi nhận; nút xong đóng yêu cầu, bot vốn đã bật).
 */
function HandoffBanner({ conversation: c }: { conversation: ConversationSummary }) {
  const { user } = useAuth();
  const now = useNow(30_000);
  const ack = useAckHandoff(c.id);
  const resolve = useResolveHandoff(c.id);
  const [expanded, setExpanded] = useState(false);
  // Ẩn/hiện cả banner (chỉ còn dòng tiêu đề + nút) — nhớ trên trình duyệt, chung mọi hội thoại.
  const [collapsed, setCollapsed] = useHandoffBannerCollapsed();
  if (c.status !== 'pending_human') return null;
  const botNote = handoffBotNote(c, now);
  const h = c.handoff ?? null;
  const ackedBy = h?.acknowledgedBy ?? null;
  const busy = ack.isPending || resolve.isPending;
  const labels = handoffButtonLabels(c.chatbot);
  const summary = h?.summary?.trim() || null;
  const longSummary = !!summary && summary.length > SUMMARY_CLAMP_CHARS;

  return (
    <div
      className={cn(
        'flex gap-2 border-b border-blue-200 bg-blue-50 px-3 text-sm text-blue-900 sm:px-4',
        collapsed ? 'flex-wrap items-center py-1.5' : 'flex-col py-2 sm:flex-row sm:items-center',
      )}
      role="alert"
    >
      <div className={cn('flex min-w-0 flex-1 gap-2', collapsed ? 'items-center' : 'items-start')}>
        <Siren className={cn('size-4 shrink-0 text-blue-600', !collapsed && 'mt-0.5')} aria-hidden />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className={cn('font-semibold', collapsed && 'truncate')}>
            Cần người: {h ? handoffReasonLabel(h.reasonCode) : 'Hội thoại đang chờ nhân viên xử lý'}
          </p>
          {!collapsed && summary && (
            <div className="text-sm">
              {/* Tóm tắt dài (bot cộng dồn nhiều lần chuyển) đẩy khung chat xuống: mặc định 2 dòng, mở ra thì
                  cuộn trong khung có giới hạn chiều cao. */}
              <p
                className={cn(
                  'break-words whitespace-pre-line',
                  expanded ? 'max-h-60 overflow-y-auto pr-1' : 'line-clamp-2',
                )}
                title={expanded ? undefined : summary}
              >
                {summary}
              </p>
              {longSummary && (
                <button
                  type="button"
                  className="mt-0.5 text-xs font-semibold text-blue-700 hover:underline"
                  aria-expanded={expanded}
                  onClick={() => setExpanded((v) => !v)}
                >
                  {expanded ? 'Thu gọn' : 'Xem thêm'}
                </button>
              )}
            </div>
          )}
          {!collapsed && ackedBy && (
            <p className="text-xs text-blue-800/80">
              {handoffAckedText(labels, ackedBy.id === user?.id ? 'bạn' : ackedBy.name)}
            </p>
          )}
          {!collapsed && botNote && (
            <p className="flex items-center gap-1 text-xs text-violet-800">
              <Bot className="size-3.5 shrink-0" aria-hidden />
              {botNote}
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
        <Button
          variant="ghost"
          size="sm"
          className="size-8 p-0 text-blue-700 hover:bg-blue-100 hover:text-blue-900"
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Hiện chi tiết thông báo Cần người' : 'Ẩn chi tiết thông báo Cần người'}
          title={collapsed ? 'Hiện chi tiết thông báo' : 'Ẩn bớt thông báo'}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? <ChevronDown aria-hidden /> : <ChevronUp aria-hidden />}
        </Button>
      </div>
    </div>
  );
}

/** Các dải thông báo AI ngay dưới đầu khung chat. */
export function ConversationAiNotices({ conversation }: { conversation: ConversationSummary }) {
  return (
    <>
      {/* key ⇒ đổi hội thoại thì banner thu gọn lại. */}
      <HandoffBanner key={conversation.id} conversation={conversation} />
      <AiPausedNotice conversation={conversation} />
    </>
  );
}
