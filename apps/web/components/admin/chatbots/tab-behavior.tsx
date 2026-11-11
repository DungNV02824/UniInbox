'use client';

// Nội dung 3 tab: Chuyển người thật, Phối hợp nhân viên, Nâng cao.
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  AlarmClock,
  BellRing,
  Gauge,
  Plus,
  Power,
  ShieldAlert,
  Siren,
  TriangleAlert,
  UserCog,
  X,
  Zap,
} from 'lucide-react';
import {
  AGENT_REPLY_MODE_LABELS,
  AGENT_REPLY_MODES,
  CHATBOT_DEFAULTS,
  CHATBOT_LIMITS,
  DEFAULT_HANDOFF_ACK_LABEL,
  DEFAULT_HANDOFF_RESOLVE_LABEL,
  HANDOFF_MESSAGE_CONTACT_PLACEHOLDER,
  RESPONSE_SPEED_HINTS,
  RESPONSE_SPEED_LABELS,
  RESPONSE_SPEEDS,
  type AgentReplyMode,
  type ResponseSpeed,
} from '@dezon/shared';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  addKeywords,
  DEFAULT_AGENT_PAUSE_MIN,
  DEFAULT_HANDOFF_REMINDER_MIN,
  FAST_REPLY_TIP,
  hasKeyword,
  isFastReplySetup,
  keywordOverlap,
  overlapMessage,
  slowReplyWarning,
  SUGGESTED_HANDOFF_KEYWORDS,
  SUGGESTED_NOTIFY_KEYWORDS,
  temperatureHint,
  toggleHandoffReminder,
  type FormErrors,
} from '@/lib/chatbot-form';
import { cn } from '@/lib/utils';
import { InfoTip } from '../info-tip';
import { Switch } from '../switch';
import { Callout, CharCounter, Field, FieldError } from './fields';
import type { TabProps } from './tab-content';

function KeywordChips({
  field,
  value,
  onChange,
  errors,
  inputId,
  suggested,
  other,
  conflicts,
  liveError,
}: {
  /** Trường của form (đường dẫn lỗi `field` / `field.<i>`). */
  field: 'handoffKeywords' | 'notifyKeywords';
  value: string[];
  onChange: (next: string[]) => void;
  errors: FormErrors;
  inputId: string;
  suggested: readonly string[];
  /** Danh sách còn lại: gợi ý đã có ở đó thì không hiện. */
  other: readonly string[];
  /** Từ khóa trùng danh sách kia ⇒ tô đỏ chip (kiểm tra ngay khi gõ). */
  conflicts?: readonly string[];
  /** Lỗi hiện ngay (trước khi bấm Lưu), vd. trùng danh sách kia. */
  liveError?: string;
}) {
  const [text, setText] = useState('');
  const full = value.length >= CHATBOT_LIMITS.keywordsMax;
  const suggestions = suggested.filter((k) => !hasKeyword(value, k) && !hasKeyword(other, k));
  const chipErrors = Object.entries(errors).filter(([k]) => k.startsWith(`${field}.`));
  const message = errors[field] ?? chipErrors[0]?.[1] ?? liveError;

  function commit(raw = text) {
    if (!raw.trim()) return;
    onChange(addKeywords(value, raw));
    setText('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Backspace' && !text && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        className={cn(
          'flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50',
          message && 'border-destructive',
        )}
        onClick={() => document.getElementById(inputId)?.focus()}
      >
        {value.map((k, i) => (
          <span
            key={`${k}-${i}`}
            className={cn(
              'inline-flex max-w-full items-center gap-1 rounded-full bg-secondary py-0.5 pr-1 pl-2.5 text-xs font-medium',
              (errors[`${field}.${i}`] || (conflicts && hasKeyword(conflicts, k))) &&
                'bg-destructive/10 text-destructive',
            )}
          >
            <span className="truncate">{k}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onChange(value.filter((_, j) => j !== i));
              }}
              className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              aria-label={`Bỏ từ khóa ${k}`}
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
        <input
          id={inputId}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => commit()}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text');
            if (/[,;\n]/.test(pasted)) {
              e.preventDefault();
              commit(text + pasted);
            }
          }}
          disabled={full}
          placeholder={value.length ? 'Thêm từ khóa…' : 'Gõ từ khóa rồi nhấn Enter'}
          maxLength={CHATBOT_LIMITS.keywordMax}
          className="h-7 min-w-32 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          aria-describedby={`${inputId}-hint`}
        />
      </div>
      <FieldError message={message} />
      {suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Gợi ý:</span>
          {suggestions.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => onChange(addKeywords(value, k))}
              disabled={full}
              className="inline-flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-xs text-muted-foreground transition-colors outline-none hover:border-brand/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Plus className="size-3" aria-hidden />
              {k}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const UNSURE_OPTIONS = [
  {
    value: true,
    label: 'Chuyển cho người thật',
    hint: 'Bot không đoán: hội thoại chuyển sang “Cần người” để nhân viên trả lời.',
  },
  {
    value: false,
    label: 'Vẫn trả lời',
    hint: 'Bot tự trả lời theo hiểu biết tốt nhất — có thể thiếu chính xác.',
  },
] as const;

export function HandoffTab({ form, update, errors }: TabProps) {
  const id = useId();
  const msgId = `${id}-msg`;
  const overlap = keywordOverlap(form.handoffKeywords, form.notifyKeywords);
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">Từ khóa báo nhân viên</h3>
        <p className="text-xs text-muted-foreground">
          Không bắt buộc — bot mới chưa có từ khóa nào. Tin của khách chứa một trong các từ dưới đây (không
          phân biệt dấu, hoa thường — “hoan tien” cũng khớp “hoàn tiền”) thì nhân viên được báo. Phân tách
          bằng Enter hoặc dấu phẩy; mỗi từ khóa chỉ nằm ở một danh sách.
        </p>
      </section>

      <Field
        label={
          <span className="flex items-center gap-1.5">
            <Siren className="size-4 text-red-600" aria-hidden />
            Báo nhân viên + DỪNG bot
          </span>
        }
        htmlFor={`${id}-kw`}
        aside={
          <span className="text-xs text-muted-foreground">
            {form.handoffKeywords.length}/{CHATBOT_LIMITS.keywordsMax}
          </span>
        }
      >
        <KeywordChips
          field="handoffKeywords"
          inputId={`${id}-kw`}
          value={form.handoffKeywords}
          onChange={(handoffKeywords) => update({ handoffKeywords })}
          errors={errors}
          suggested={SUGGESTED_HANDOFF_KEYWORDS}
          other={form.notifyKeywords}
        />
        <p id={`${id}-kw-hint`} className="text-xs text-muted-foreground">
          Bot <strong>không trả lời</strong> mà chuyển hội thoại sang “Cần người” và ngừng trả lời tới khi
          nhân viên trả lại cho AI.
        </p>
      </Field>

      <Field
        label={
          <span className="flex items-center gap-1.5">
            <BellRing className="size-4 text-amber-600" aria-hidden />
            Báo nhân viên, bot VẪN trả lời
          </span>
        }
        htmlFor={`${id}-nkw`}
        aside={
          <span className="text-xs text-muted-foreground">
            {form.notifyKeywords.length}/{CHATBOT_LIMITS.keywordsMax}
          </span>
        }
      >
        <KeywordChips
          field="notifyKeywords"
          inputId={`${id}-nkw`}
          value={form.notifyKeywords}
          onChange={(notifyKeywords) => update({ notifyKeywords })}
          errors={errors}
          suggested={SUGGESTED_NOTIFY_KEYWORDS}
          other={form.handoffKeywords}
          conflicts={form.handoffKeywords}
          liveError={overlap.length > 0 ? overlapMessage(overlap) : undefined}
        />
        <p id={`${id}-nkw-hint`} className="text-xs text-muted-foreground">
          Gửi thông báo cho nhân viên (trong app + Lark) nhưng bot <strong>vẫn tiếp tục nhắn</strong> với
          khách; hội thoại không chuyển sang “Cần người”. Ví dụ: gửi công trình, nghiệm thu.
        </p>
      </Field>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">Khi bot không chắc chắn câu trả lời</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {UNSURE_OPTIONS.map((opt) => {
            const checked = form.escalateWhenUnsure === opt.value;
            return (
              <label
                key={String(opt.value)}
                className={cn(
                  'flex cursor-pointer items-start gap-2.5 rounded-lg border bg-background p-3 transition-colors focus-within:ring-[3px] focus-within:ring-ring/50 hover:border-brand/40',
                  checked && 'border-brand bg-brand/5',
                )}
              >
                <input
                  type="radio"
                  name={`${id}-unsure`}
                  checked={checked}
                  onChange={() => update({ escalateWhenUnsure: opt.value })}
                  className="mt-0.5 size-4 shrink-0 accent-[var(--brand)] outline-none"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium">
                    {opt.label}
                    {opt.value && (
                      <span className="ml-1.5 text-xs font-normal text-muted-foreground">(mặc định)</span>
                    )}
                  </span>
                  <span className="text-xs leading-snug text-muted-foreground">{opt.hint}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <Callout icon={ShieldAlert} title="Khi nào bot chuyển cho người thật?" tone="muted">
        <p>
          Khi tin khách chứa từ khóa “Báo nhân viên + DỪNG bot” ở trên, khi gặp tình huống bạn dặn chuyển
          trong phần <strong className="text-foreground">Hướng dẫn</strong>, và khi không chắc câu trả lời
          (nếu chọn “Chuyển cho người thật”).
        </p>
        <p>
          Nếu phần Hướng dẫn không dặn khác, bot cũng tự chuyển khi khách muốn gặp người thật hoặc phàn
          nàn/bực tức. Muốn tắt, ghi trong Hướng dẫn, ví dụ: “Không chuyển nhân viên khi khách phàn nàn; tự
          xin lỗi và trả lời.”
        </p>
        <p>
          Khi chuyển, hội thoại hiện “Cần người” trong hộp thư, nhân viên nhận âm thanh + thông báo (và Lark
          nếu đã cấu hình ở mục Cài đặt). Bot dừng ở hội thoại đó cho tới khi nhân viên bấm “Trả lại cho AI”.
        </p>
      </Callout>

      <Field
        label="Tin nhắn giữ chỗ khi chuyển người (tùy chọn)"
        htmlFor={msgId}
        error={errors.handoffMessage}
        errorId={`${msgId}-err`}
        aside={<CharCounter value={form.handoffMessage} max={CHATBOT_LIMITS.handoffMessageMax} />}
        hint={
          <>
            Gửi cho khách ngay lúc chuyển, để khách biết đang có người hỗ trợ.{' '}
            <strong>Để trống = im lặng</strong>: khách không nhận được tin gì, nhân viên trả lời sau.
          </>
        }
      >
        <Textarea
          id={msgId}
          value={form.handoffMessage}
          onChange={(e) => update({ handoffMessage: e.target.value })}
          rows={3}
          placeholder="Ví dụ: Bạn chờ một chút nhé, nhân viên sẽ trả lời bạn ngay."
          aria-invalid={!!errors.handoffMessage}
          aria-describedby={errors.handoffMessage ? `${msgId}-err` : undefined}
          className="resize-y"
        />
      </Field>

      <HandoffButtonsSection form={form} update={update} errors={errors} />
    </div>
  );
}

/** "Tin gửi khách khi bấm nút «…»": bot gửi tin này cho khách khi nhân viên bấm nút trên banner. */
function ButtonMessageField({
  id,
  buttonLabel,
  value,
  onChange,
  error,
  placeholder,
}: {
  id: string;
  buttonLabel: string;
  value: string;
  onChange: (next: string) => void;
  error?: string;
  placeholder: string;
}) {
  return (
    <Field
      label={`Tin gửi khách khi bấm nút «${buttonLabel}»`}
      htmlFor={id}
      error={error}
      errorId={`${id}-err`}
      aside={
        value.length > CHATBOT_LIMITS.handoffMessageMax * 0.8 ? (
          <CharCounter value={value} max={CHATBOT_LIMITS.handoffMessageMax} />
        ) : undefined
      }
      hint={
        <>
          <strong>Để trống = không gửi.</strong> Dùng{' '}
          <code className="rounded bg-muted px-1 font-mono text-[11px]">
            {HANDOFF_MESSAGE_CONTACT_PLACEHOLDER}
          </code>{' '}
          để chèn tên khách. Chỉ gửi khi còn trong 24 giờ kể từ tin cuối của khách; bấm lại nút không gửi
          trùng.
        </>
      }
    >
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        placeholder={placeholder}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-err` : undefined}
        className="resize-y"
      />
    </Field>
  );
}

/** "Nút khi cần người": tên riêng cho hai nút trên banner đỏ ở hộp thư + thông báo Lark khi bấm. */
function HandoffButtonsSection({ form, update, errors }: TabProps) {
  const id = useId();
  const ackId = `${id}-ack`;
  const resolveId = `${id}-resolve`;
  const max = CHATBOT_LIMITS.handoffButtonLabelMax;
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">Nút khi cần người</h3>
        <p className="text-xs text-muted-foreground">
          Tên hai nút trên dải đỏ “Cần người” ở hộp thư, cho hội thoại đang gắn bot này (để trống = dùng tên
          mặc định), và tin bot tự gửi cho khách khi nhân viên bấm từng nút.
        </p>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="flex flex-col gap-4">
          <Field
            label="Tên nút nhận xử lý"
            htmlFor={ackId}
            error={errors.handoffAckLabel}
            errorId={`${ackId}-err`}
            aside={<CharCounter value={form.handoffAckLabel} max={max} />}
            hint="Ví dụ: Nghiệm thu"
          >
            <Input
              id={ackId}
              value={form.handoffAckLabel}
              onChange={(e) => update({ handoffAckLabel: e.target.value })}
              placeholder={DEFAULT_HANDOFF_ACK_LABEL}
              maxLength={max}
              aria-invalid={!!errors.handoffAckLabel}
              aria-describedby={errors.handoffAckLabel ? `${ackId}-err` : undefined}
            />
          </Field>
          <ButtonMessageField
            id={`${id}-ack-msg`}
            buttonLabel={form.handoffAckLabel.trim() || DEFAULT_HANDOFF_ACK_LABEL}
            value={form.handoffAckMessage}
            onChange={(handoffAckMessage) => update({ handoffAckMessage })}
            error={errors.handoffAckMessage}
            placeholder={`Ví dụ: Công trình của ${HANDOFF_MESSAGE_CONTACT_PLACEHOLDER} đã được nghiệm thu ạ.`}
          />
        </div>
        <div className="flex flex-col gap-4">
          <Field
            label="Tên nút xong việc (trả lại cho AI)"
            htmlFor={resolveId}
            error={errors.handoffResolveLabel}
            errorId={`${resolveId}-err`}
            aside={<CharCounter value={form.handoffResolveLabel} max={max} />}
            hint="Ví dụ: Đã chuyển tiền"
          >
            <Input
              id={resolveId}
              value={form.handoffResolveLabel}
              onChange={(e) => update({ handoffResolveLabel: e.target.value })}
              placeholder={DEFAULT_HANDOFF_RESOLVE_LABEL}
              maxLength={max}
              aria-invalid={!!errors.handoffResolveLabel}
              aria-describedby={errors.handoffResolveLabel ? `${resolveId}-err` : undefined}
            />
          </Field>
          <ButtonMessageField
            id={`${id}-resolve-msg`}
            buttonLabel={form.handoffResolveLabel.trim() || DEFAULT_HANDOFF_RESOLVE_LABEL}
            value={form.handoffResolveMessage}
            onChange={(handoffResolveMessage) => update({ handoffResolveMessage })}
            error={errors.handoffResolveMessage}
            placeholder={`Ví dụ: Dezon đã chuyển tiền cho ${HANDOFF_MESSAGE_CONTACT_PLACEHOLDER}, anh/chị kiểm tra giúp em nhé.`}
          />
        </div>
      </div>
      <div className="flex items-start gap-3 rounded-lg border bg-background p-3">
        <BellRing className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <label htmlFor={`${id}-lark`} className="text-sm font-medium">
            Gửi thông báo Lark khi bấm hai nút này
          </label>
          <p className="text-xs text-muted-foreground">
            Lark nhận tên khách, người bấm, giờ bấm và tóm tắt yêu cầu (ví dụ: công trình, số ảnh, thù lao).
            Cần cấu hình Lark ở mục Cài đặt.
          </p>
        </div>
        <Switch
          id={`${id}-lark`}
          checked={form.handoffActionLark}
          onCheckedChange={(handoffActionLark) => update({ handoffActionLark })}
        />
      </div>
    </section>
  );
}

/** Gợi ý ngắn dưới từng lựa chọn "Khi nhân viên vào nhắn tin với khách". */
const AGENT_REPLY_MODE_HINTS: Record<AgentReplyMode, string> = {
  continue: 'Nhân viên và bot cùng nhắn với khách. Hợp khi nhân viên chỉ chen vào bổ sung thông tin.',
  pause: 'Bot im lặng một lúc sau tin của nhân viên, hết thời gian thì tự trả lời tiếp.',
  stop: 'Bot ngừng hẳn ở hội thoại đó. Bấm “Tiếp tục AI” hoặc bật lại bot trong khung chat để bot trả lời tiếp.',
};

/** Tab "Phối hợp nhân viên": bot làm gì khi nhân viên nhắn + nhắc lại khi chưa ai nhận hội thoại. */
export function StaffTab({ form, update, errors }: TabProps) {
  const id = useId();
  const max = CHATBOT_LIMITS.handoffReminderMinMax.toLocaleString('vi-VN');
  return (
    <div className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 flex items-center gap-1.5 text-sm font-medium">
          <UserCog className="size-4 text-muted-foreground" aria-hidden />
          Khi nhân viên vào nhắn tin với khách
        </legend>
        <p className="-mt-1 mb-1 text-xs text-muted-foreground">
          Áp dụng khi nhân viên tự gửi tin cho khách (từ hộp thư hoặc Business Suite) ở hội thoại đang gắn bot
          này.
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          {AGENT_REPLY_MODES.map((mode) => {
            const checked = form.agentReplyMode === mode;
            return (
              <label
                key={mode}
                className={cn(
                  'flex cursor-pointer items-start gap-2.5 rounded-lg border bg-background p-3 transition-colors focus-within:ring-[3px] focus-within:ring-ring/50 hover:border-brand/40',
                  checked && 'border-brand bg-brand/5',
                  errors.agentReplyMode && 'border-destructive',
                )}
              >
                <input
                  type="radio"
                  name={`${id}-agent-mode`}
                  value={mode}
                  checked={checked}
                  onChange={() => update({ agentReplyMode: mode })}
                  className="mt-0.5 size-4 shrink-0 accent-[var(--brand)] outline-none"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium">
                    {AGENT_REPLY_MODE_LABELS[mode]}
                    {mode === CHATBOT_DEFAULTS.agentReplyMode && (
                      <span className="ml-1.5 text-xs font-normal text-muted-foreground">(mặc định)</span>
                    )}
                  </span>
                  <span className="text-xs leading-snug text-muted-foreground">
                    {AGENT_REPLY_MODE_HINTS[mode]}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        <FieldError message={errors.agentReplyMode} />
        {form.agentReplyMode === 'pause' && (
          <div className="mt-2">
            <NumberField
              id={`${id}-pause`}
              label="Thời gian bot tạm nghỉ"
              value={form.agentPauseMinutes}
              onChange={(agentPauseMinutes) => update({ agentPauseMinutes })}
              unit="phút"
              min={CHATBOT_LIMITS.agentPauseMinutesMin}
              max={CHATBOT_LIMITS.agentPauseMinutesMax}
              placeholder={String(DEFAULT_AGENT_PAUSE_MIN)}
              hint={`${CHATBOT_LIMITS.agentPauseMinutesMin}–${CHATBOT_LIMITS.agentPauseMinutesMax.toLocaleString('vi-VN')} phút. Để trống = mặc định hệ thống (${DEFAULT_AGENT_PAUSE_MIN} phút). Tính từ tin gần nhất của nhân viên.`}
              error={errors.agentPauseMinutes}
            />
          </div>
        )}
      </fieldset>

      <section className="flex flex-col gap-3">
        <div className="flex items-start gap-3 rounded-lg border bg-background p-3">
          <AlarmClock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <label htmlFor={`${id}-remind`} className="text-sm font-medium">
              Nhắc lại khi chưa ai nhận hội thoại
            </label>
            <p className="text-xs text-muted-foreground">
              Gửi lại thông báo “Nhắc lại: chưa ai nhận hội thoại” qua Lark và trong app nếu sau{' '}
              {form.handoffReminderEnabled && form.handoffReminderMin.trim()
                ? `${form.handoffReminderMin.trim()} phút`
                : 'N phút'}{' '}
              kể từ khi bot chuyển người mà chưa ai bấm nhận.
            </p>
          </div>
          <Switch
            id={`${id}-remind`}
            checked={form.handoffReminderEnabled}
            onCheckedChange={(enabled) => update(toggleHandoffReminder(form, enabled))}
          />
        </div>
        {form.handoffReminderEnabled && (
          <NumberField
            id={`${id}-remind-min`}
            label="Nhắc lại sau"
            value={form.handoffReminderMin}
            onChange={(handoffReminderMin) => update({ handoffReminderMin })}
            unit="phút"
            min={1}
            max={CHATBOT_LIMITS.handoffReminderMinMax}
            placeholder={String(DEFAULT_HANDOFF_REMINDER_MIN)}
            hint={`1–${max} phút, tính từ lúc bot chuyển hội thoại sang “Cần người”.`}
            error={errors.handoffReminderMin}
          />
        )}
      </section>
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
  unit,
  hint,
  tip,
  error,
  min,
  max,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  unit: string;
  hint: ReactNode;
  tip?: string;
  error?: string;
  min: number;
  max: number;
  placeholder: string;
}) {
  return (
    <Field
      label={
        <>
          {label}
          {tip && <InfoTip label={`Giải thích: ${label}`}>{tip}</InfoTip>}
        </>
      }
      htmlFor={id}
      hint={hint}
      error={error}
      errorId={`${id}-err`}
    >
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-28 tabular-nums"
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-err` : undefined}
        />
        <span className="text-sm text-muted-foreground">{unit}</span>
      </div>
    </Field>
  );
}

function ResponseSpeedPicker({
  value,
  onChange,
  error,
}: {
  value: ResponseSpeed;
  onChange: (next: ResponseSpeed) => void;
  error?: string;
}) {
  const id = useId();
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 flex items-center gap-1.5 text-sm font-medium">
        <Gauge className="size-4 text-muted-foreground" aria-hidden />
        Tốc độ trả lời
        <InfoTip label="Giải thích: Tốc độ trả lời">
          Là mức “suy nghĩ” của AI trước khi trả lời. Suy nghĩ càng kỹ thì khách càng phải chờ lâu. Đa số câu
          hỏi (đếm ảnh, báo giá, hỏi theo kiến thức đã nhập) chỉ cần Nhanh nhất.
        </InfoTip>
      </legend>
      <p className="-mt-1 mb-1 text-xs text-muted-foreground">
        Thời gian dưới đây chỉ tính lúc AI soạn câu trả lời, chưa cộng “Độ trễ gom tin” ở dưới.
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        {RESPONSE_SPEEDS.map((speed) => {
          const checked = value === speed;
          return (
            <label
              key={speed}
              className={cn(
                'flex cursor-pointer items-start gap-2.5 rounded-lg border bg-background p-3 transition-colors focus-within:ring-[3px] focus-within:ring-ring/50 hover:border-brand/40',
                checked && 'border-brand bg-brand/5',
                error && 'border-destructive',
              )}
            >
              <input
                type="radio"
                name={`${id}-speed`}
                value={speed}
                checked={checked}
                onChange={() => onChange(speed)}
                className="mt-0.5 size-4 shrink-0 accent-[var(--brand)] outline-none"
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium">
                  {RESPONSE_SPEED_LABELS[speed]}
                  {speed === CHATBOT_DEFAULTS.responseSpeed && (
                    <span className="ml-1.5 text-xs font-normal text-muted-foreground">(mặc định)</span>
                  )}
                </span>
                <span className="text-xs leading-snug text-muted-foreground">
                  {RESPONSE_SPEED_HINTS[speed]}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      <FieldError message={error} />
    </fieldset>
  );
}

export function AdvancedTab({
  form,
  update,
  errors,
  models,
  defaultModel,
  modelsLoading,
}: TabProps & { models: string[]; defaultModel: string | null; modelsLoading: boolean }) {
  const id = useId();
  const modelOptions = form.model && !models.includes(form.model) ? [form.model, ...models] : models;
  const slowWarning = slowReplyWarning(form);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start gap-3 rounded-lg border bg-background p-3">
        <Power className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <label htmlFor={`${id}-active`} className="text-sm font-medium">
            Bật chatbot
          </label>
          <p className="text-xs text-muted-foreground">
            Tắt thì bot ngừng trả lời ở mọi hội thoại đang gắn nó và không hiện trong ô chọn bot của nhân
            viên.
          </p>
        </div>
        <Switch
          id={`${id}-active`}
          checked={form.isActive}
          onCheckedChange={(isActive) => update({ isActive })}
        />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Model AI"
          htmlFor={`${id}-model`}
          error={errors.model}
          hint="Mặc định hệ thống dùng model cấu hình trên máy chủ (thường là Gemini Flash: nhanh, rẻ)."
        >
          <NativeSelect
            id={`${id}-model`}
            value={form.model}
            onChange={(e) => update({ model: e.target.value })}
            className="w-full"
            disabled={modelsLoading && modelOptions.length === 0}
          >
            <option value="">
              {defaultModel ? `Mặc định hệ thống (${defaultModel})` : 'Mặc định hệ thống'}
            </option>
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </NativeSelect>
        </Field>

        <Field
          label="Nhiệt độ (độ sáng tạo)"
          htmlFor={`${id}-temp`}
          error={errors.temperature}
          aside={
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium tabular-nums">
              {form.temperature.toLocaleString('vi-VN', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
          }
        >
          <input
            id={`${id}-temp`}
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={form.temperature}
            onChange={(e) => update({ temperature: Number(e.target.value) })}
            className="h-9 w-full cursor-pointer accent-[var(--brand)]"
            aria-valuetext={temperatureHint(form.temperature)}
          />
          <div className="-mt-1 flex justify-between text-[11px] text-muted-foreground">
            <span>Ổn định</span>
            <span>Sáng tạo</span>
          </div>
          <p className="text-xs text-muted-foreground">
            {temperatureHint(form.temperature)}{' '}
            {form.temperature !== CHATBOT_DEFAULTS.temperature && (
              <button
                type="button"
                className="text-brand underline-offset-2 hover:underline"
                onClick={() => update({ temperature: CHATBOT_DEFAULTS.temperature })}
              >
                Về mặc định ({CHATBOT_DEFAULTS.temperature.toLocaleString('vi-VN')})
              </button>
            )}
          </p>
        </Field>
      </div>

      <ResponseSpeedPicker
        value={form.responseSpeed}
        onChange={(responseSpeed) => update({ responseSpeed })}
        error={errors.responseSpeed}
      />

      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">Nhịp trả lời</h3>
        <p className="text-xs text-muted-foreground">
          Khách thường nhắn nhiều tin liên tiếp. Bot chờ khách nhắn xong rồi trả lời một lượt cho tự nhiên.
        </p>
      </div>
      <div className="grid gap-5 sm:grid-cols-3">
        <NumberField
          id={`${id}-delay`}
          label="Độ trễ gom tin"
          value={form.replyDelaySec}
          onChange={(replyDelaySec) => update({ replyDelaySec })}
          unit="giây"
          min={0}
          max={120}
          placeholder={String(CHATBOT_DEFAULTS.replyDelaySec)}
          hint={
            <>
              0–120. Khách ngừng nhắn ngần này giây thì bot trả lời.
              <span
                className={cn(
                  'mt-1 flex items-start gap-1',
                  isFastReplySetup(form) ? 'text-emerald-700 dark:text-emerald-400' : 'text-brand',
                )}
              >
                <Zap className="mt-px size-3.5 shrink-0" aria-hidden />
                {FAST_REPLY_TIP}
              </span>
              {slowWarning ? (
                <span
                  role="status"
                  className="mt-1 flex items-start gap-1 text-amber-700 dark:text-amber-400"
                >
                  <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
                  {slowWarning}
                </span>
              ) : null}
            </>
          }
          tip="Mỗi tin mới của khách sẽ dời lịch trả lời thêm ngần này giây, để gom các tin liên tiếp thành một lượt."
          error={errors.replyDelaySec}
        />
        <NumberField
          id={`${id}-wait`}
          label="Chờ tối đa"
          value={form.maxWaitSec}
          onChange={(maxWaitSec) => update({ maxWaitSec })}
          unit="giây"
          min={5}
          max={300}
          placeholder={String(CHATBOT_DEFAULTS.maxWaitSec)}
          hint="5–300. Khách nhắn liên tục thì vẫn trả lời chậm nhất sau ngần này."
          tip="Tính từ tin đầu tiên chưa được trả lời. Phải lớn hơn hoặc bằng độ trễ gom tin."
          error={errors.maxWaitSec}
        />
        <NumberField
          id={`${id}-rate`}
          label="Giới hạn trả lời"
          value={form.maxRepliesPerHour}
          onChange={(maxRepliesPerHour) => update({ maxRepliesPerHour })}
          unit="lượt/giờ"
          min={1}
          max={200}
          placeholder={String(CHATBOT_DEFAULTS.maxRepliesPerHour)}
          hint="1–200, tính riêng mỗi hội thoại. Chống spam và vòng lặp."
          tip="Vượt giới hạn trong 1 giờ thì bot im lặng ở hội thoại đó cho tới giờ sau (nhân viên vẫn trả lời được)."
          error={errors.maxRepliesPerHour}
        />
      </div>
    </div>
  );
}
