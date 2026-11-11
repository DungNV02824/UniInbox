'use client';

import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bot,
  CircleSlash,
  EyeOff,
  ImagePlus,
  Loader2,
  MessageCircleQuestion,
  RotateCcw,
  SendHorizontal,
  UserRound,
  X,
  XCircle,
} from 'lucide-react';
import { CHATBOT_LIMITS, type ChatbotTestRequest, type ChatbotTestResult } from '@dezon/shared';
import { Button } from '@/components/ui/button';
import {
  addPendingImages,
  appendResult,
  botContinuesNote,
  buildTestMessages,
  describeOutcome,
  imageSrc,
  lastTurnImageStats,
  newEntryId,
  notifiedKeywordNote,
  outcomeMeta,
  tooManyImagesMessage,
  transcriptIsLong,
  type TestEntry,
  type TestImage,
} from '@/lib/chatbot-test';
import { prepareTestImages } from '@/lib/image-downscale';
import type { FormErrors } from '@/lib/chatbot-form';
import { errorText } from '@/lib/inbox-queries';
import { cn } from '@/lib/utils';
import { SAMPLE_CUSTOMER_MESSAGES } from './templates';

export type RunTest = (messages: ChatbotTestRequest['messages']) => Promise<ChatbotTestResult>;

/** Biểu mẫu chưa hợp lệ (lỗi theo ô đã hiện bên trái). */
export class DraftInvalidError extends Error {
  constructor(readonly errors: FormErrors) {
    super('Một số ô chưa hợp lệ — sửa các ô được đánh dấu đỏ rồi thử lại.');
    this.name = 'DraftInvalidError';
  }
}

const OUTCOME_STYLE = {
  // Ghi chú nội bộ: khách không thấy (viền nét đứt).
  handoff: {
    icon: AlertTriangle,
    className:
      'border-dashed border-amber-400 bg-amber-50/70 text-amber-950 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100',
  },
  silent: {
    icon: CircleSlash,
    className:
      'border-slate-200 bg-slate-50 text-slate-800 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-200',
  },
  error: {
    icon: XCircle,
    className:
      'border-red-200 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100',
  },
} as const;

/** "🔔 Chạy thật sẽ báo nhân viên (từ khóa "…") — bot vẫn trả lời" (chỉ nhân viên thấy). */
function NotifiedNote({ result, className }: { result: ChatbotTestResult; className?: string }) {
  const note = notifiedKeywordNote(result);
  if (!note) return null;
  return (
    <p
      className={cn(
        'w-fit max-w-[95%] rounded-md border border-dashed border-amber-300 bg-amber-50/70 px-2 py-1 text-[11px] text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100',
        className,
      )}
    >
      {note}
    </p>
  );
}

/** "Chạy thật: chuyển nhân viên nhưng bot vẫn tiếp tục trả lời" (bot đặt aiHandoffMode 'continue'). */
function BotContinuesNote({ result }: { result: ChatbotTestResult }) {
  const note = botContinuesNote(result);
  if (!note) return null;
  return (
    <p className="w-fit max-w-[95%] rounded-md border border-dashed border-violet-300 bg-violet-50/70 px-2 py-1 text-center text-[11px] text-violet-900 dark:border-violet-800 dark:bg-violet-950/30 dark:text-violet-100">
      🤖 {note}
    </p>
  );
}

function OutcomeRow({ result }: { result: ChatbotTestResult }) {
  const view = describeOutcome(result);
  const meta = outcomeMeta(result);
  if (view.tone === 'reply' && !view.title) {
    return (
      <div className="-mt-1 flex flex-col items-end gap-1 pr-1">
        <NotifiedNote result={result} />
        <p className="text-right text-[11px] text-muted-foreground">{meta}</p>
      </div>
    );
  }
  const style = view.tone === 'reply' ? OUTCOME_STYLE.silent : OUTCOME_STYLE[view.tone];
  const Icon = style.icon;
  return (
    <div className="flex flex-col items-center gap-1 py-1">
      <div
        className={cn(
          'flex max-w-[95%] items-start gap-2 rounded-lg border px-3 py-2 text-xs',
          style.className,
        )}
      >
        <Icon className="mt-px size-3.5 shrink-0" aria-hidden />
        <div className="flex min-w-0 flex-col gap-0.5">
          {view.tone === 'handoff' && (
            <span className="flex items-center gap-1 text-[10px] font-semibold tracking-wide uppercase opacity-75">
              <EyeOff className="size-3" aria-hidden />
              Chỉ nhân viên thấy
            </span>
          )}
          <p className="break-words">
            <span className="font-medium">{view.title}</span>
            {view.detail && <span className="opacity-90"> — {view.detail}</span>}
          </p>
        </div>
      </div>
      {view.note && <p className="max-w-[95%] text-center text-[11px] text-muted-foreground">{view.note}</p>}
      <BotContinuesNote result={result} />
      <NotifiedNote result={result} />
      {meta && <p className="text-[11px] text-muted-foreground">{meta}</p>}
    </div>
  );
}

function Bubble({
  entry,
  botName,
}: {
  entry: Extract<TestEntry, { kind: 'customer' | 'bot' }>;
  botName: string;
}) {
  const isBot = entry.kind === 'bot';
  return (
    <div className={cn('flex items-end gap-2', isBot ? 'flex-row-reverse' : 'flex-row')}>
      <span
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-full',
          isBot
            ? 'bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300'
            : 'bg-muted text-muted-foreground',
        )}
        aria-hidden
      >
        {isBot ? <Bot className="size-3.5" /> : <UserRound className="size-3.5" />}
      </span>
      <div className={cn('flex max-w-[80%] flex-col gap-0.5', isBot ? 'items-end' : 'items-start')}>
        <span className="sr-only">{isBot ? `AI · ${botName}:` : 'Khách:'}</span>
        <div
          className={cn(
            'rounded-2xl px-3 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap',
            isBot
              ? 'rounded-br-md bg-violet-100 text-violet-950 dark:bg-violet-900/50 dark:text-violet-50'
              : 'rounded-bl-md bg-muted text-foreground',
          )}
        >
          {entry.kind === 'customer' && entry.images && entry.images.length > 0 && (
            <div className={cn('grid gap-1', entry.images.length === 1 ? 'grid-cols-1' : 'grid-cols-3')}>
              {entry.images.map((img, i, all) => (
                // eslint-disable-next-line @next/next/no-img-element -- ảnh data: cục bộ, không qua next/image
                <img
                  key={img.id}
                  src={imageSrc(img)}
                  alt={`Ảnh ${i + 1}${img.name ? `: ${img.name}` : ''}`}
                  title={img.name}
                  className={cn(
                    'rounded-lg bg-background object-cover',
                    all.length === 1 ? 'max-h-48 w-auto max-w-full' : 'aspect-square size-20',
                  )}
                />
              ))}
            </div>
          )}
          {entry.text && (
            <p className={cn(entry.kind === 'customer' && entry.images?.length && 'mt-1.5')}>{entry.text}</p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Khung "Chat thử": gõ như khách, gửi cả hội thoại lên API, hiện bong bóng bot + quyết định.
 * `run` do trình soạn cung cấp (bot đã lưu: /chatbots/:id/test kèm bản nháp; bot mới: /chatbots/test-draft).
 */
export function ChatTestPanel({
  id,
  run,
  botName,
  usingDraft,
  className,
}: {
  run: RunTest;
  botName: string;
  /** Đang thử nội dung chưa lưu. */
  usingDraft: boolean;
  className?: string;
  id?: string;
}) {
  const [entries, setEntries] = useState<TestEntry[]>([]);
  const [text, setText] = useState('');
  /** Ảnh chờ gửi kèm tin khách tiếp theo. */
  const [pendingImages, setPendingImages] = useState<TestImage[]>([]);
  /** Số ảnh đang thu nhỏ/nén. */
  const [preparing, setPreparing] = useState(0);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Bản đồng bộ của pendingImages cho các lượt thêm ảnh bất đồng bộ chồng nhau.
  const pendingImagesRef = useRef<TestImage[]>([]);
  const preparingRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Lượt đang chạy bị bỏ khi bấm "Làm mới".
  const generation = useRef(0);

  const mutation = useMutation({
    mutationFn: async ({ messages }: { messages: ChatbotTestRequest['messages']; gen: number }) =>
      run(messages),
    onSuccess: (result, { gen }) => {
      if (gen !== generation.current) return;
      setEntries((prev) => appendResult(prev, result));
    },
    onError: (err, { gen }) => {
      if (gen !== generation.current) return;
      setEntries((prev) => [
        ...prev,
        {
          id: newEntryId(),
          kind: 'failure',
          message:
            err instanceof DraftInvalidError
              ? err.message
              : errorText(err, 'Không chạy thử được. Vui lòng thử lại.'),
        },
      ]);
    },
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [entries, mutation.isPending]);

  /** Chọn / dán / kéo thả ảnh: kiểm tra, thu nhỏ, đưa vào hàng chờ (tối đa 10 ảnh mỗi tin). */
  async function addFiles(files: readonly File[]) {
    if (files.length === 0) return;
    const room = CHATBOT_LIMITS.testImagesMax - pendingImagesRef.current.length - preparingRef.current;
    const take = files.slice(0, Math.max(0, room));
    const errors: string[] = [];
    let dropped = files.length - take.length;
    const gen = generation.current;
    if (take.length > 0) {
      preparingRef.current += take.length;
      setPreparing(preparingRef.current);
      try {
        const res = await prepareTestImages(take);
        errors.push(...res.errors);
        if (gen === generation.current) {
          const out = addPendingImages(pendingImagesRef.current, res.images);
          dropped += out.dropped;
          pendingImagesRef.current = out.images;
          setPendingImages(out.images);
        }
      } finally {
        if (gen === generation.current) {
          preparingRef.current = Math.max(0, preparingRef.current - take.length);
          setPreparing(preparingRef.current);
        }
      }
    }
    if (gen !== generation.current) return;
    if (dropped > 0) errors.push(tooManyImagesMessage(dropped));
    setAttachError(errors.length ? errors.join(' ') : null);
  }

  function removePending(imageId: string) {
    const next = pendingImagesRef.current.filter((img) => img.id !== imageId);
    pendingImagesRef.current = next;
    setPendingImages(next);
    setAttachError(null);
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    // Chỉ chặn dán khi có ảnh (dán chữ vẫn bình thường).
    const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;
    e.preventDefault();
    void addFiles(files);
  }

  function hasFiles(e: DragEvent) {
    return Array.from(e.dataTransfer.types).includes('Files');
  }

  function onDragOver(e: DragEvent<HTMLElement>) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragOver) setDragOver(true);
  }

  function onDragLeave(e: DragEvent<HTMLElement>) {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragOver(false);
  }

  function onDrop(e: DragEvent<HTMLElement>) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragOver(false);
    void addFiles(Array.from(e.dataTransfer.files));
  }

  function send(raw: string) {
    const value = raw.trim();
    const images = pendingImagesRef.current;
    if ((!value && images.length === 0) || preparing > 0 || mutation.isPending) return;
    const next: TestEntry[] = [
      ...entries,
      {
        id: newEntryId(),
        kind: 'customer',
        text: value.slice(0, CHATBOT_LIMITS.testTextMax),
        ...(images.length ? { images } : {}),
      },
    ];
    setEntries(next);
    setText('');
    pendingImagesRef.current = [];
    setPendingImages([]);
    setAttachError(null);
    mutation.mutate({ messages: buildTestMessages(next), gen: generation.current });
    inputRef.current?.focus();
  }

  /** Chạy lại lượt vừa lỗi (bỏ dòng lỗi cuối, không thêm tin khách mới). */
  function retry() {
    if (mutation.isPending) return;
    const next = entries.at(-1)?.kind === 'failure' ? entries.slice(0, -1) : entries;
    const messages = buildTestMessages(next);
    if (messages.length === 0) return;
    setEntries(next);
    mutation.mutate({ messages, gen: generation.current });
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    send(text);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(text);
    }
  }

  function reset() {
    generation.current += 1;
    mutation.reset();
    setEntries([]);
    setText('');
    pendingImagesRef.current = [];
    setPendingImages([]);
    preparingRef.current = 0;
    setPreparing(0);
    setAttachError(null);
    inputRef.current?.focus();
  }

  const long = transcriptIsLong(entries);
  const { total: totalImages, sent: sentImages } = lastTurnImageStats(entries);
  const canSend = (!!text.trim() || pendingImages.length > 0) && preparing === 0 && !mutation.isPending;
  const canAttach = pendingImages.length + preparing < CHATBOT_LIMITS.testImagesMax;

  return (
    <section
      id={id}
      aria-label="Chat thử"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        'relative flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card shadow-xs',
        dragOver && 'ring-2 ring-brand/60',
        className,
      )}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-brand/5 backdrop-blur-[1px]">
          <p className="flex items-center gap-2 rounded-lg border border-brand/40 bg-background px-4 py-2 text-sm font-medium text-brand shadow-sm">
            <ImagePlus className="size-4" aria-hidden />
            Thả ảnh vào đây để gửi kèm tin khách
          </p>
        </div>
      )}
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <MessageCircleQuestion className="size-4 text-brand" aria-hidden />
            Chat thử
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {usingDraft ? 'Đang thử nội dung chưa lưu' : 'Gõ như khách để xem bot trả lời'} · không gửi tin
            thật
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={reset}
          disabled={entries.length === 0 && !mutation.isPending}
        >
          <RotateCcw aria-hidden />
          Làm mới
        </Button>
      </header>

      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto bg-muted/20 px-3 py-4"
        aria-live="polite"
      >
        {entries.length === 0 && !mutation.isPending ? (
          <div className="m-auto flex max-w-xs flex-col items-center gap-3 py-6 text-center">
            <span className="flex size-10 items-center justify-center rounded-full bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300">
              <Bot className="size-5" aria-hidden />
            </span>
            <p className="text-sm text-muted-foreground">
              Thử vài câu khách hay hỏi. Bot dùng đúng hướng dẫn, kiến thức và từ khóa đang soạn bên trái. Có
              thể gửi kèm tối đa {CHATBOT_LIMITS.testImagesMax} ảnh (bấm nút ảnh, dán hoặc kéo thả).
            </p>
            <div className="flex flex-col items-stretch gap-1.5">
              {SAMPLE_CUSTOMER_MESSAGES.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => send(m)}
                  className="rounded-full border bg-background px-3 py-1.5 text-xs transition-colors outline-none hover:border-brand/40 hover:bg-brand/5 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        ) : (
          entries.map((e, i) => {
            if (e.kind === 'outcome') return <OutcomeRow key={e.id} result={e.result} />;
            if (e.kind === 'failure')
              return (
                <div key={e.id} className="flex flex-col items-center gap-1 py-1">
                  <p className="flex max-w-[95%] items-start gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                    <XCircle className="mt-px size-3.5 shrink-0" aria-hidden />
                    {e.message}
                  </p>
                  {i === entries.length - 1 && !mutation.isPending && (
                    <button
                      type="button"
                      onClick={retry}
                      className="text-xs font-medium text-brand underline-offset-2 hover:underline"
                    >
                      Thử lại
                    </button>
                  )}
                </div>
              );
            return <Bubble key={e.id} entry={e} botName={botName} />;
          })
        )}
        {mutation.isPending && (
          <div className="flex flex-row-reverse items-end gap-2">
            <span
              className="flex size-6 items-center justify-center rounded-full bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300"
              aria-hidden
            >
              <Bot className="size-3.5" />
            </span>
            <div className="flex items-center gap-1.5 rounded-2xl rounded-br-md bg-violet-50 px-3 py-2 text-xs text-violet-800 dark:bg-violet-950/40 dark:text-violet-200">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              Bot đang soạn…
            </div>
          </div>
        )}
      </div>

      {totalImages > sentImages && (
        <p className="border-t bg-amber-50 px-4 py-1.5 text-[11px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          Lượt này có {totalImages} ảnh, bot chỉ xem {sentImages} ảnh gần nhất (tối đa{' '}
          {CHATBOT_LIMITS.testImagesMax} ảnh mỗi lượt).
        </p>
      )}

      {long && (
        <p className="border-t bg-amber-50 px-4 py-1.5 text-[11px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          Chỉ {CHATBOT_LIMITS.testMessagesMax} tin gần nhất được gửi cho bot. Bấm “Làm mới” để thử từ đầu.
        </p>
      )}

      {(pendingImages.length > 0 || preparing > 0 || attachError) && (
        <div className="flex flex-col gap-2 border-t px-3 pt-3">
          {(pendingImages.length > 0 || preparing > 0) && (
            <ul className="flex flex-wrap gap-2" aria-label="Ảnh sẽ gửi kèm">
              {pendingImages.map((img, i) => (
                <li key={img.id} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element -- ảnh data: cục bộ */}
                  <img
                    src={imageSrc(img)}
                    alt={`Ảnh ${i + 1}${img.name ? `: ${img.name}` : ''}`}
                    title={img.name}
                    className="size-14 rounded-md border object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removePending(img.id)}
                    aria-label={`Bỏ ảnh ${i + 1}`}
                    className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </li>
              ))}
              {Array.from({ length: preparing }, (_, i) => (
                <li
                  key={`prep-${i}`}
                  className="flex size-14 items-center justify-center rounded-md border border-dashed text-muted-foreground"
                >
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  <span className="sr-only">Đang xử lý ảnh</span>
                </li>
              ))}
            </ul>
          )}
          {pendingImages.length > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {pendingImages.length}/{CHATBOT_LIMITS.testImagesMax} ảnh sẽ gửi kèm tin tiếp theo
            </p>
          )}
          {attachError && (
            <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
              <XCircle className="mt-px size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 break-words">{attachError}</span>
            </p>
          )}
        </div>
      )}

      <form onSubmit={onSubmit} className="flex items-end gap-2 border-t p-3">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            void addFiles(files);
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => fileInputRef.current?.click()}
          disabled={!canAttach}
          aria-label="Đính kèm ảnh"
          title={
            canAttach
              ? `Đính kèm ảnh (tối đa ${CHATBOT_LIMITS.testImagesMax} ảnh mỗi tin)`
              : `Đã đủ ${CHATBOT_LIMITS.testImagesMax} ảnh`
          }
        >
          <ImagePlus aria-hidden />
        </Button>
        <label htmlFor="chat-test-input" className="sr-only">
          Tin nhắn của khách
        </label>
        <textarea
          id="chat-test-input"
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={1}
          maxLength={CHATBOT_LIMITS.testTextMax}
          placeholder="Nhập tin nhắn như khách… (Enter để gửi)"
          className="field-sizing-content max-h-32 min-h-9 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-base shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm"
        />
        <Button type="submit" variant="brand" size="icon" disabled={!canSend} aria-label="Gửi tin thử">
          {mutation.isPending ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <SendHorizontal aria-hidden />
          )}
        </Button>
      </form>
    </section>
  );
}
