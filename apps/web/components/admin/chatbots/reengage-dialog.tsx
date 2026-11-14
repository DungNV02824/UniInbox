'use client';

import { useEffect, useId, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useMutation } from '@tanstack/react-query';
import {
  AlertCircle,
  CircleCheck,
  Clock,
  Eraser,
  ExternalLink,
  Info,
  Loader2,
  Search,
  Send,
} from 'lucide-react';
import {
  REENGAGE_LIMITS,
  type ReengageConversationItem,
  type ReengagePreview,
  type ReengageStartResult,
} from '@dezon/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  excerptText,
  formatWaitingSince,
  guidanceBody,
  guidanceError,
  guidanceLength,
  inboxConversationHref,
  initialSelection,
  isAllSelected,
  isStartResultError,
  loadReengageGuidance,
  parseReengageDays,
  previewSummaryText,
  reengageErrorText,
  saveReengageGuidance,
  selectedIds,
  selectionCapText,
  skippedText,
  startResultText,
  toggleSelection,
  EMPTY_REENGAGE_GUIDANCE,
  type ReengageGuidanceDraft,
} from '@/lib/chatbot-reengage';
import { chatbotsApi } from '@/lib/chatbots-api';
import { CHANNEL_TYPE_LABELS } from '@/lib/inbox-format';
import { useNow } from '@/lib/use-now';

const MAX = REENGAGE_LIMITS.maxPerRun;
const GUIDANCE_MAX = REENGAGE_LIMITS.guidanceMaxChars;

/** Một ô chỉ dẫn gõ tay (nhãn + textarea + gợi ý/bộ đếm ký tự). */
function GuidanceField({
  id,
  label,
  hint,
  placeholder,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  hint: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const hintId = `${id}-hint`;
  const error = guidanceError(value);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={4}
        className="max-h-64 min-h-24 resize-y"
        aria-invalid={!!error}
        aria-describedby={hintId}
        disabled={disabled}
      />
      <p
        id={hintId}
        className={`flex justify-between gap-3 text-xs ${error ? 'text-destructive' : 'text-muted-foreground'}`}
      >
        <span>{error ?? hint}</span>
        <span className="shrink-0 tabular-nums">
          {guidanceLength(value)}/{GUIDANCE_MAX}
        </span>
      </p>
    </div>
  );
}

function channelText(item: ReengageConversationItem): string {
  return `${CHANNEL_TYPE_LABELS[item.channelType] ?? item.channelType} · ${item.channelName}`;
}

function contactText(item: ReengageConversationItem): string {
  return item.contactName?.trim() || 'Khách chưa có tên';
}

function EligibleRow({
  item,
  checked,
  disabled,
  onToggle,
  now,
}: {
  item: ReengageConversationItem;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
  now: Date;
}) {
  const id = useId();
  return (
    <li>
      <label
        htmlFor={id}
        className="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-accent/50 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
      >
        <input
          id={id}
          type="checkbox"
          className="mt-0.5 size-4 shrink-0 accent-brand"
          checked={checked}
          disabled={disabled}
          onChange={onToggle}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="truncate text-sm font-medium">{contactText(item)}</span>
            <span className="truncate text-xs text-muted-foreground">{channelText(item)}</span>
          </span>
          <span className="line-clamp-2 text-xs break-words text-muted-foreground">
            “{excerptText(item)}”
          </span>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3" aria-hidden />
              Tin cuối {formatWaitingSince(item.lastCustomerMessageAt, now)}
            </span>
            <span className="tabular-nums">{item.waitingMessages} tin đang chờ</span>
          </span>
        </span>
      </label>
    </li>
  );
}

function OutsideRow({ item, now }: { item: ReengageConversationItem; now: Date }) {
  return (
    <li className="flex flex-col gap-1 px-3 py-2.5 sm:flex-row sm:items-start sm:gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="truncate text-sm font-medium">{contactText(item)}</span>
          <span className="truncate text-xs text-muted-foreground">{channelText(item)}</span>
        </span>
        <span className="line-clamp-2 text-xs break-words text-muted-foreground">“{excerptText(item)}”</span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Clock className="size-3" aria-hidden />
            Tin cuối {formatWaitingSince(item.lastCustomerMessageAt, now)}
          </span>
          <span className="tabular-nums">{item.waitingMessages} tin đang chờ</span>
        </span>
        {item.reason && <span className="text-xs text-amber-700 dark:text-amber-400">{item.reason}</span>}
      </div>
      <Button variant="outline" size="sm" className="w-fit shrink-0" asChild>
        <Link href={inboxConversationHref(item.conversationId)} target="_blank" rel="noopener">
          <ExternalLink aria-hidden />
          Mở hội thoại
          <span className="sr-only"> với {contactText(item)} (mở tab mới)</span>
        </Link>
      </Button>
    </li>
  );
}

/** Hộp thoại "Tái chăm sóc khách bị bỏ sót": kiểm tra (không tốn AI) rồi xếp hàng bot trả lời. */
export function ReengageDialog({
  chatbotId,
  botName,
  botActive,
  onOpenChange,
}: {
  chatbotId: string;
  botName: string;
  /** Trạng thái bật/tắt ĐÃ LƯU của bot. */
  botActive: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const idPrefix = useId();
  const daysId = `${idPrefix}-days`;
  const daysHintId = `${idPrefix}-days-hint`;
  const [days, setDays] = useState(String(REENGAGE_LIMITS.daysDefault));
  const [daysError, setDaysError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Hai ô chỉ dẫn gõ tay: nhớ bản gõ lần trước của bot này (chỉ trên trình duyệt này) để sửa tiếp.
  const [guidance, setGuidance] = useState<ReengageGuidanceDraft>(() => loadReengageGuidance(chatbotId));
  const now = new Date(useNow(60_000));

  useEffect(() => {
    saveReengageGuidance(chatbotId, guidance);
  }, [chatbotId, guidance]);

  const preview = useMutation<ReengagePreview, unknown, number>({
    mutationFn: (n) => chatbotsApi.reengagePreview(chatbotId, { days: n }),
    onSuccess: (data) => setSelected(initialSelection(data.eligible, MAX)),
  });
  const start = useMutation<
    ReengageStartResult,
    unknown,
    { days: number; conversationIds: string[]; rules?: string; content?: string }
  >({
    mutationFn: (body) => chatbotsApi.reengageStart(chatbotId, body),
  });

  const busy = preview.isPending || start.isPending;
  const data = preview.data;
  const done = start.data;
  const eligible = data?.eligible ?? [];
  const ids = selectedIds(selected, eligible);
  const allChecked = isAllSelected(selected, eligible, MAX);
  const guidanceInvalid = !!guidanceError(guidance.rules) || !!guidanceError(guidance.content);
  const hasGuidance = !!guidance.rules.trim() || !!guidance.content.trim();
  // Chỉ dẫn đã gửi kèm lần "Bắt đầu" vừa rồi (để báo khách đã xếp hàng từ trước vẫn dùng chỉ dẫn cũ).
  const sentGuidance = !!start.variables && (!!start.variables.rules || !!start.variables.content);

  function onCheck(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const parsed = parseReengageDays(days);
    if (!parsed.ok) {
      setDaysError(parsed.error);
      return;
    }
    setDaysError(null);
    start.reset();
    preview.mutate(parsed.days);
  }

  function onDaysChange(value: string) {
    setDays(value);
    setDaysError(null);
    // Kết quả cũ thuộc số ngày cũ: bỏ đi để không bắt đầu nhầm.
    if (preview.data || preview.error) preview.reset();
    if (start.data || start.error) start.reset();
  }

  function onStart() {
    if (!data || ids.length === 0 || busy || done || guidanceInvalid) return;
    start.mutate({ days: data.days, conversationIds: ids, ...guidanceBody(guidance) });
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title="Tái chăm sóc khách bị bỏ sót"
      description={`Tìm khách đã nhắn "${botName}" mà chưa ai trả lời, rồi cho bot trả lời lần lượt.`}
      className="sm:max-w-2xl"
    >
      {!botActive && (
        <Alert>
          <Info aria-hidden />
          <AlertDescription>Bot đang tắt — bật bot và lưu trước thì bot mới trả lời được.</AlertDescription>
        </Alert>
      )}

      <form className="flex flex-col gap-2" onSubmit={onCheck} noValidate>
        <Label htmlFor={daysId}>Khách nhắn trong bao nhiêu ngày gần nhất</Label>
        <div className="flex gap-2">
          <Input
            id={daysId}
            data-autofocus
            type="number"
            inputMode="numeric"
            min={REENGAGE_LIMITS.daysMin}
            max={REENGAGE_LIMITS.daysMax}
            step={1}
            value={days}
            onChange={(e) => onDaysChange(e.target.value)}
            aria-invalid={!!daysError}
            aria-describedby={daysHintId}
            className="w-24"
            disabled={busy}
          />
          <Button type="submit" variant="outline" disabled={busy}>
            {preview.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Search aria-hidden />}
            {data ? 'Kiểm tra lại' : 'Kiểm tra'}
          </Button>
        </div>
        <p
          id={daysHintId}
          className={daysError ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
        >
          {daysError ??
            `Từ ${REENGAGE_LIMITS.daysMin} đến ${REENGAGE_LIMITS.daysMax} ngày. Kiểm tra không gọi AI và không gửi tin.`}
        </p>
      </form>

      <section className="flex flex-col gap-3" aria-labelledby={`${idPrefix}-guidance`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <h3 id={`${idPrefix}-guidance`} className="text-sm font-semibold">
              Huấn luyện cho lần tái chăm sóc này
            </h3>
            <p className="text-xs text-muted-foreground">
              Gõ tay cho từng chủ đề, áp dụng cho các khách bấm “Bắt đầu” lần này (không sửa Hướng dẫn của
              bot). Để trống thì bot trả lời như bình thường. Nội dung gõ lần trước được giữ lại — kiểm tra
              trước khi bắt đầu.
            </p>
          </div>
          {hasGuidance && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={busy}
              onClick={() => setGuidance(EMPTY_REENGAGE_GUIDANCE)}
            >
              <Eraser aria-hidden />
              Xóa nội dung
            </Button>
          )}
        </div>
        <GuidanceField
          id={`${idPrefix}-rules`}
          label="Quy tắc chăm sóc"
          hint="Cách bot chăm sóc lại: giọng văn, điều nên/không nên nói. Ưu tiên hơn Hướng dẫn của bot trong lần này."
          placeholder="Ví dụ: Xưng em, gọi anh/chị. Nhắn ngắn gọn, thân thiện, không hối thúc. Không báo giá cụ thể, mời khách để lại SĐT."
          value={guidance.rules}
          onChange={(rules) => setGuidance((g) => ({ ...g, rules }))}
          disabled={busy}
        />
        <GuidanceField
          id={`${idPrefix}-content`}
          label="Nội dung chăm sóc lại"
          hint="Chủ đề / thông tin bot cần nhắn khách lần này. Bot viết lại tự nhiên và vẫn trả lời tin khách đang chờ."
          placeholder="Ví dụ: Tháng này bên em có chương trình tặng gói thiết kế 3D khi ký hợp đồng trước 30/11, mời anh/chị đặt lịch khảo sát miễn phí."
          value={guidance.content}
          onChange={(content) => setGuidance((g) => ({ ...g, content }))}
          disabled={busy}
        />
      </section>

      <Alert>
        <Info aria-hidden />
        <AlertDescription className="flex flex-col gap-1 text-xs">
          <span>
            Chỉ liệt kê khách <strong>bị bỏ sót</strong>: tin cuối là của khách và chưa ai trả lời. Tin trước
            lần trả lời cuối của nhân viên coi như nhân viên đã lo.
          </span>
          <span>
            Facebook chỉ cho bot nhắn trong <strong>24 giờ</strong> kể từ tin cuối của khách; khách quá khung
            giờ được liệt kê riêng để nhân viên tự xử lý.
          </span>
          <span>
            Chi phí: <strong>1 khách ≈ 1 lần gọi AI</strong>. Mỗi lần tối đa {MAX} khách.
          </span>
        </AlertDescription>
      </Alert>

      {preview.isError && (
        <Alert variant="destructive">
          <AlertCircle aria-hidden />
          <AlertDescription>{reengageErrorText(preview.error, 'preview')}</AlertDescription>
        </Alert>
      )}

      {data && (
        <div className="flex flex-col gap-4" aria-live="polite">
          <p className="text-sm font-medium">{previewSummaryText(data)}</p>
          {data.truncated && (
            <p className="text-xs text-muted-foreground">
              Danh sách dài nên chỉ hiện {REENGAGE_LIMITS.previewMaxItems} dòng đầu mỗi mục. Bắt đầu xong bấm
              “Kiểm tra lại” để xem tiếp (khách đã xếp hàng không hiện lại; lần sau tự nối tiếp sau hàng đang
              chờ).
            </p>
          )}

          {eligible.length > 0 && !done && (
            <section className="flex flex-col gap-2" aria-labelledby={`${idPrefix}-eligible`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id={`${idPrefix}-eligible`} className="text-sm font-semibold">
                  Bot sẽ trả lời ({eligible.length})
                </h3>
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-brand"
                    checked={allChecked}
                    disabled={busy}
                    onChange={() => setSelected(allChecked ? new Set() : initialSelection(eligible, MAX))}
                  />
                  {eligible.length > MAX ? `Chọn ${MAX} khách đầu` : 'Chọn tất cả'}
                </label>
              </div>
              <p className="text-xs text-muted-foreground" aria-live="polite">
                {selectionCapText(ids.length, eligible.length, MAX)}
              </p>
              <ul
                className="max-h-80 divide-y overflow-y-auto rounded-lg border"
                aria-label="Khách bot sẽ trả lời"
              >
                {eligible.map((item) => {
                  const checked = selected.has(item.conversationId);
                  return (
                    <EligibleRow
                      key={item.conversationId}
                      item={item}
                      checked={checked}
                      disabled={busy || (!checked && ids.length >= MAX)}
                      onToggle={() => setSelected((s) => toggleSelection(s, item.conversationId, MAX))}
                      now={now}
                    />
                  );
                })}
              </ul>
            </section>
          )}

          {start.isError && (
            <Alert variant="destructive">
              <AlertCircle aria-hidden />
              <AlertDescription>{reengageErrorText(start.error, 'start')}</AlertDescription>
            </Alert>
          )}

          {done && (
            <Alert variant={isStartResultError(done) ? 'destructive' : 'default'}>
              {isStartResultError(done) ? <AlertCircle aria-hidden /> : <CircleCheck aria-hidden />}
              <AlertDescription className="flex flex-col gap-1">
                <span>{startResultText(done)}</span>
                {skippedText(done.skipped) && (
                  <span className="text-xs text-muted-foreground">{skippedText(done.skipped)}</span>
                )}
                {sentGuidance && done.alreadyQueued > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {done.alreadyQueued} khách đã xếp hàng từ lần bấm trước vẫn dùng chỉ dẫn của lần bấm đó.
                  </span>
                )}
              </AlertDescription>
            </Alert>
          )}

          {done && done.outsideWindow.length > 0 && (
            <section className="flex flex-col gap-2" aria-labelledby={`${idPrefix}-done-outside`}>
              <h3 id={`${idPrefix}-done-outside`} className="text-sm font-semibold">
                Bot không kịp gửi — nhân viên trả lời ngay ({done.outsideWindow.length})
              </h3>
              <p className="text-xs text-muted-foreground">
                Khung gửi tin của kênh đã hoặc sẽ đóng trước lượt của bot, nên bot không gửi những khách này.
                Mở hội thoại để nhân viên trả lời.
              </p>
              <ul
                className="max-h-72 divide-y overflow-y-auto rounded-lg border"
                aria-label="Khách đã chọn mà bot không kịp gửi"
              >
                {done.outsideWindow.map((item) => (
                  <OutsideRow key={item.conversationId} item={item} now={now} />
                ))}
              </ul>
            </section>
          )}

          {data.outsideWindow.length > 0 && (
            <section className="flex flex-col gap-2" aria-labelledby={`${idPrefix}-outside`}>
              <h3 id={`${idPrefix}-outside`} className="text-sm font-semibold">
                Quá khung giờ Facebook — nhân viên tự xử lý ({data.outsideWindow.length})
              </h3>
              <p className="text-xs text-muted-foreground">
                Kênh không cho bot nhắn những khách này nữa; bot sẽ không gửi. Mở hội thoại để nhân viên trả
                lời.
              </p>
              <ul
                className="max-h-72 divide-y overflow-y-auto rounded-lg border"
                aria-label="Khách nhân viên tự xử lý"
              >
                {data.outsideWindow.map((item) => (
                  <OutsideRow key={item.conversationId} item={item} now={now} />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
          Đóng
        </Button>
        {data && eligible.length > 0 && !done && (
          <Button
            type="button"
            variant="brand"
            onClick={onStart}
            disabled={busy || ids.length === 0 || guidanceInvalid}
          >
            {start.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
            Bắt đầu ({ids.length} khách)
          </Button>
        )}
      </div>
    </Dialog>
  );
}
