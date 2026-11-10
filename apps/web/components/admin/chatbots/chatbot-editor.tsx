'use client';

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowLeft,
  Bot,
  Loader2,
  MessageCircleQuestion,
  MessagesSquare,
  RefreshCw,
  Save,
} from 'lucide-react';
import { CHATBOT_LIMITS, type ChatbotDto } from '@dezon/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import {
  apiErrorToForm,
  chatbotToForm,
  EDITOR_TABS,
  emptyChatbotForm,
  isFormDirty,
  tabsWithErrors,
  usageText,
  validateChatbotForm,
  type ChatbotFormValues,
  type EditorTab,
  type FormErrors,
} from '@/lib/chatbot-form';
import { chatbotKeys, chatbotsApi } from '@/lib/chatbots-api';
import { errorText } from '@/lib/inbox-queries';
import { cn } from '@/lib/utils';
import { UNSAVED_MESSAGE, useUnsavedGuard } from '../use-unsaved-guard';
import { ChatTestPanel, DraftInvalidError, type RunTest } from './chat-test-panel';
import { CharCounter, Field } from './fields';
import { AdvancedTab, HandoffTab } from './tab-behavior';
import { ExamplesTab, InstructionsTab, KnowledgeTab } from './tab-content';

const TAB_LABELS: Record<EditorTab, string> = {
  instructions: 'Hướng dẫn',
  knowledge: 'Kiến thức',
  examples: 'Câu trả lời mẫu',
  handoff: 'Chuyển người thật',
  advanced: 'Nâng cao',
};

function EditorTabs({
  value,
  onChange,
  errorTabs,
  counts,
  idPrefix,
}: {
  value: EditorTab;
  onChange: (tab: EditorTab) => void;
  errorTabs: Set<EditorTab>;
  counts: Partial<Record<EditorTab, number>>;
  idPrefix: string;
}) {
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const i = EDITOR_TABS.indexOf(value);
    let next: EditorTab | undefined;
    if (e.key === 'ArrowRight') next = EDITOR_TABS[(i + 1) % EDITOR_TABS.length];
    else if (e.key === 'ArrowLeft') next = EDITOR_TABS[(i - 1 + EDITOR_TABS.length) % EDITOR_TABS.length];
    else if (e.key === 'Home') next = EDITOR_TABS[0];
    else if (e.key === 'End') next = EDITOR_TABS[EDITOR_TABS.length - 1];
    if (!next) return;
    e.preventDefault();
    onChange(next);
    document.getElementById(`${idPrefix}-tab-${next}`)?.focus();
  }
  return (
    <div
      role="tablist"
      aria-label="Phần cấu hình chatbot"
      onKeyDown={onKeyDown}
      className="-mb-px flex gap-1 overflow-x-auto px-3 [scrollbar-width:none] sm:px-4"
    >
      {EDITOR_TABS.map((tab) => {
        const selected = tab === value;
        const count = counts[tab];
        return (
          <button
            key={tab}
            id={`${idPrefix}-tab-${tab}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab)}
            className={cn(
              'relative flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-3 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
              selected
                ? 'border-brand font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {TAB_LABELS[tab]}
            {count !== undefined && count > 0 && (
              <span className="rounded-full bg-muted px-1.5 text-[11px] font-medium text-muted-foreground tabular-nums">
                {count}
              </span>
            )}
            {errorTabs.has(tab) && (
              <span className="size-1.5 rounded-full bg-destructive" aria-label="(có lỗi)" />
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Bỏ lỗi của các ô vừa sửa. */
function clearErrorsFor(errors: FormErrors, keys: string[]): FormErrors {
  if (keys.length === 0) return errors;
  const next: FormErrors = {};
  let changed = false;
  for (const [path, msg] of Object.entries(errors)) {
    if (keys.includes(path.split('.')[0]!)) changed = true;
    else next[path] = msg;
  }
  return changed ? next : errors;
}

function ChatbotEditor({
  initial,
  models,
  defaultModel,
  modelsLoading,
}: {
  initial: ChatbotDto | null;
  models: string[];
  defaultModel: string | null;
  modelsLoading: boolean;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const idPrefix = useId();
  const [savedId, setSavedId] = useState<string | null>(initial?.id ?? null);
  const [conversationCount, setConversationCount] = useState(initial?.conversationCount ?? 0);
  const [form, setForm] = useState<ChatbotFormValues>(() =>
    initial ? chatbotToForm(initial) : emptyChatbotForm(),
  );
  // Bot mới: mốc so sánh là form rỗng mặc định => chưa gõ gì thì không cảnh báo khi rời trang.
  const [baseline, setBaseline] = useState<ChatbotFormValues>(form);
  const [errors, setErrors] = useState<FormErrors>({});
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [tab, setTab] = useState<EditorTab>('instructions');
  const submitted = useRef<ChatbotFormValues | null>(null);

  const dirty = isFormDirty(form, baseline);
  useUnsavedGuard(dirty);
  const errorTabs = tabsWithErrors(errors);

  const update = useCallback((patch: Partial<ChatbotFormValues>) => {
    setForm((f) => ({ ...f, ...patch }));
    setErrors((e) => clearErrorsFor(e, Object.keys(patch)));
    setFormMessage(null);
  }, []);

  function showErrors(next: FormErrors, message: string | null) {
    setErrors(next);
    setFormMessage(message);
    const tabs = tabsWithErrors(next);
    if (!next.name && !next.description && tabs.size > 0 && !tabs.has(tab)) {
      setTab(EDITOR_TABS.find((t) => tabs.has(t))!);
    }
  }

  const save = useMutation({
    mutationFn: async (snapshot: ChatbotFormValues) => {
      const result = validateChatbotForm(snapshot);
      if (!result.ok) throw new DraftInvalidError(result.errors);
      return savedId ? chatbotsApi.update(savedId, result.data) : chatbotsApi.create(result.data);
    },
    onMutate: (snapshot) => {
      submitted.current = snapshot;
      setFormMessage(null);
    },
    onSuccess: (dto) => {
      const fresh = chatbotToForm(dto);
      // Người dùng không gõ thêm trong lúc lưu => lấy bản chuẩn hóa từ server.
      if (submitted.current && !isFormDirty(form, submitted.current)) setForm(fresh);
      setBaseline(fresh);
      setErrors({});
      setConversationCount(dto.conversationCount);
      qc.setQueryData(chatbotKeys.detail(dto.id), dto);
      void qc.invalidateQueries({ queryKey: chatbotKeys.list() });
      const created = !savedId;
      setSavedId(dto.id);
      toast({ title: created ? `Đã tạo chatbot "${dto.name}"` : 'Đã lưu thay đổi', variant: 'success' });
      if (created) router.replace(`/admin/chatbots/${dto.id}`);
    },
    onError: (err) => {
      if (err instanceof DraftInvalidError) {
        showErrors(err.errors, 'Một số ô chưa hợp lệ — xem các ô được đánh dấu đỏ.');
        return;
      }
      const mapped = apiErrorToForm(err, submitted.current ?? undefined);
      showErrors(
        mapped.errors,
        mapped.message ?? (Object.keys(mapped.errors).length ? null : 'Không lưu được chatbot.'),
      );
    },
  });

  // Ctrl/Cmd + S để lưu.
  const saveRef = useRef(() => {});
  saveRef.current = () => {
    if (!save.isPending) save.mutate(form);
  };
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveRef.current();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function cancel() {
    if (dirty && !window.confirm(UNSAVED_MESSAGE)) return;
    setForm(baseline);
    setErrors({});
    setFormMessage(null);
    router.push('/admin/chatbots');
  }

  const run: RunTest = async (messages) => {
    // Bản nháp: tên trống vẫn cho thử (API test-draft cần tên).
    const result = validateChatbotForm({ ...form, name: form.name.trim() || 'Bản nháp' });
    if (!result.ok) {
      showErrors(result.errors, null);
      throw new DraftInvalidError(result.errors);
    }
    if (savedId) return chatbotsApi.test(savedId, { messages, draft: dirty ? result.data : undefined });
    return chatbotsApi.testDraft({ draft: result.data, messages });
  };

  const nameId = `${idPrefix}-name`;
  const descId = `${idPrefix}-desc`;
  const title = form.name.trim() || (savedId ? 'Chatbot' : 'Chatbot mới');

  return (
    <>
      <div className="sticky top-11 z-10 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
        <div className="mx-auto flex w-full max-w-7xl items-center gap-3 px-4 py-2.5 sm:px-6">
          <Button variant="ghost" size="icon" className="size-8 shrink-0" asChild>
            <Link href="/admin/chatbots" aria-label="Về danh sách chatbot">
              <ArrowLeft aria-hidden />
            </Link>
          </Button>
          <div className="flex min-w-0 flex-1 flex-col">
            <h1 className="flex min-w-0 items-center gap-2 text-base font-semibold sm:text-lg">
              <span className="truncate">{title}</span>
              {!form.isActive && (
                <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  Đang tắt
                </span>
              )}
            </h1>
            <p className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              {dirty ? (
                <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                  <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />
                  Có thay đổi chưa lưu
                </span>
              ) : savedId ? (
                <span>Đã lưu</span>
              ) : (
                <span>Chưa lưu</span>
              )}
              {savedId && (
                <span className="hidden items-center gap-1 sm:inline-flex">
                  · <MessagesSquare className="size-3" aria-hidden /> {usageText(conversationCount)}
                </span>
              )}
            </p>
          </div>
          {/* Màn hẹp: khung Chat thử nằm dưới form — nút nhảy nhanh tới đó. */}
          <Button
            variant="ghost"
            size="icon"
            className="size-8 lg:hidden"
            onClick={() =>
              document
                .getElementById(`${idPrefix}-chat`)
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
            aria-label="Tới khung Chat thử"
          >
            <MessageCircleQuestion aria-hidden />
          </Button>
          <Button variant="outline" size="sm" onClick={cancel} disabled={save.isPending}>
            Hủy
          </Button>
          <Button
            variant="brand"
            size="sm"
            onClick={() => save.mutate(form)}
            disabled={save.isPending || (!dirty && !!savedId)}
            title="Lưu (Ctrl + S)"
          >
            {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
            {savedId ? 'Lưu' : 'Tạo chatbot'}
          </Button>
        </div>
      </div>

      <main className="mx-auto grid w-full max-w-7xl items-start gap-5 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(340px,420px)]">
        <div className="flex min-w-0 flex-col gap-4">
          {formMessage && (
            <Alert variant="destructive">
              <AlertCircle aria-hidden />
              <AlertDescription>{formMessage}</AlertDescription>
            </Alert>
          )}

          <section className="grid gap-4 rounded-xl border bg-card p-4 shadow-xs sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:p-5">
            <Field
              label="Tên chatbot"
              htmlFor={nameId}
              error={errors.name}
              errorId={`${nameId}-err`}
              hint="Nhân viên thấy tên này khi chọn bot trong khung chat."
            >
              <Input
                id={nameId}
                value={form.name}
                onChange={(e) => update({ name: e.target.value })}
                maxLength={CHATBOT_LIMITS.nameMax}
                placeholder="VD: Trợ lý Fanpage chính"
                aria-invalid={!!errors.name}
                aria-describedby={errors.name ? `${nameId}-err` : undefined}
                autoFocus={!savedId}
              />
            </Field>
            <Field
              label="Mô tả (tùy chọn)"
              htmlFor={descId}
              error={errors.description}
              errorId={`${descId}-err`}
              aside={
                form.description.length > CHATBOT_LIMITS.descriptionMax * 0.8 ? (
                  <CharCounter value={form.description} max={CHATBOT_LIMITS.descriptionMax} />
                ) : undefined
              }
              hint="Ghi chú ngắn: bot dùng cho Trang nào, mục đích gì."
            >
              <Input
                id={descId}
                value={form.description}
                onChange={(e) => update({ description: e.target.value })}
                placeholder="VD: Trả lời tin nhắn trên các Trang của công ty"
                aria-invalid={!!errors.description}
                aria-describedby={errors.description ? `${descId}-err` : undefined}
              />
            </Field>
          </section>

          <section className="flex min-w-0 flex-col rounded-xl border bg-card shadow-xs">
            <div className="border-b">
              <EditorTabs
                value={tab}
                onChange={setTab}
                errorTabs={errorTabs}
                idPrefix={idPrefix}
                counts={{ examples: form.examples.length, handoff: form.handoffKeywords.length }}
              />
            </div>
            <div
              id={`${idPrefix}-panel`}
              role="tabpanel"
              aria-labelledby={`${idPrefix}-tab-${tab}`}
              className="p-4 sm:p-5"
            >
              {tab === 'instructions' && <InstructionsTab form={form} update={update} errors={errors} />}
              {tab === 'knowledge' && <KnowledgeTab form={form} update={update} errors={errors} />}
              {tab === 'examples' && <ExamplesTab form={form} update={update} errors={errors} />}
              {tab === 'handoff' && <HandoffTab form={form} update={update} errors={errors} />}
              {tab === 'advanced' && (
                <AdvancedTab
                  form={form}
                  update={update}
                  errors={errors}
                  models={models}
                  defaultModel={defaultModel}
                  modelsLoading={modelsLoading}
                />
              )}
            </div>
          </section>
        </div>

        <ChatTestPanel
          id={`${idPrefix}-chat`}
          run={run}
          botName={form.name.trim() || 'Bản nháp'}
          usingDraft={dirty || !savedId}
          className="h-[min(600px,80dvh)] scroll-mt-32 lg:sticky lg:top-[7.5rem] lg:h-[calc(100dvh-12rem)]"
        />
      </main>
    </>
  );
}

function EditorSkeleton() {
  return (
    <main
      className="mx-auto grid w-full max-w-7xl gap-5 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_400px]"
      aria-hidden
    >
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
      <Skeleton className="hidden h-[560px] rounded-xl lg:block" />
    </main>
  );
}

/** Trang soạn chatbot: `id = null` là tạo mới. */
export function ChatbotEditorPage({ id }: { id: string | null }) {
  const detail = useQuery({
    queryKey: chatbotKeys.detail(id ?? ''),
    queryFn: () => chatbotsApi.get(id!),
    enabled: !!id,
    staleTime: Infinity,
  });
  const models = useQuery({
    queryKey: chatbotKeys.models(),
    queryFn: () => chatbotsApi.models(),
    staleTime: 10 * 60_000,
    retry: false,
  });

  if (id && detail.isPending) return <EditorSkeleton />;
  if (id && detail.isError) {
    const notFound = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <main className="mx-auto flex w-full max-w-lg flex-col items-center gap-3 p-10 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Bot className="size-6" aria-hidden />
        </span>
        <p className="font-medium">{notFound ? 'Không tìm thấy chatbot' : 'Không tải được chatbot'}</p>
        <p className="text-sm text-muted-foreground">
          {notFound ? 'Chatbot có thể đã bị xóa.' : errorText(detail.error)}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link href="/admin/chatbots">
              <ArrowLeft aria-hidden />
              Về danh sách
            </Link>
          </Button>
          {!notFound && (
            <Button variant="outline" onClick={() => void detail.refetch()}>
              <RefreshCw aria-hidden />
              Thử lại
            </Button>
          )}
        </div>
      </main>
    );
  }
  return (
    <ChatbotEditor
      key={id ?? 'new'}
      initial={id ? (detail.data ?? null) : null}
      models={models.data?.models ?? []}
      defaultModel={models.data?.defaultModel ?? null}
      modelsLoading={models.isPending}
    />
  );
}
