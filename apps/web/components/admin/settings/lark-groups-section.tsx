'use client';

import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Undo2,
  Users,
  XCircle,
} from 'lucide-react';
import {
  LARK_GROUP_LIMITS,
  type ChatbotSummary,
  type CreateLarkGroupRequest,
  type LarkGroupDto,
  type UpdateLarkGroupRequest,
} from '@dezon/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { chatbotKeys, chatbotsApi } from '@/lib/chatbots-api';
import { errorText } from '@/lib/inbox-queries';
import {
  alsoInGroupsLabel,
  isLarkGroupDirty,
  larkGroupFormFrom,
  otherGroupsByChatbot,
  pruneUnknownChatbotIds,
  resolveGroupChatbots,
  shortenWebhook,
  sortChatbotsForPicker,
  validateCreateLarkGroup,
  validateUpdateLarkGroup,
  type LarkGroupFormErrors,
  type LarkGroupFormValues,
} from '@/lib/lark-groups';
import { settingsApi, settingsKeys } from '@/lib/settings-api';
import { cn } from '@/lib/utils';
import { Field, FieldError } from '../chatbots/fields';

const WEBHOOK_HINT = 'Trong nhóm Lark: Cài đặt → Bot → Thêm bot → Custom Bot, chép Webhook URL dán vào đây.';

function useLarkGroups() {
  return useQuery({ queryKey: settingsKeys.larkGroups, queryFn: () => settingsApi.listLarkGroups() });
}

/** Cùng khóa cache với trang Chatbot AI (admin thấy cả bot đang tắt). `fresh` ⇒ luôn tải lại khi mở. */
function useChatbots(fresh = false) {
  return useQuery({
    queryKey: chatbotKeys.list(),
    queryFn: () => chatbotsApi.list(),
    ...(fresh ? { refetchOnMount: 'always' as const } : {}),
  });
}

const noop = () => {};

function TestResult({ mutation }: { mutation: { isSuccess: boolean; isError: boolean; error: unknown } }) {
  if (mutation.isSuccess) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
        Đã gửi thẻ thử. Kiểm tra nhóm Lark — thẻ có nút “Mở hội thoại”.
      </div>
    );
  }
  if (mutation.isError) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          <span className="font-medium">Gửi thử thất bại:</span>{' '}
          {errorText(mutation.error, 'Lark không nhận thẻ.')}
        </span>
      </div>
    );
  }
  return null;
}

function BotChip({ name, isActive }: { name: string; isActive: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-0.5 text-xs',
        isActive ? 'bg-background' : 'bg-muted/50 text-muted-foreground',
      )}
    >
      <Bot className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{name}</span>
      {!isActive && <span className="shrink-0">(đang tắt)</span>}
    </span>
  );
}

function GroupRow({
  group,
  bots,
  botsLoading,
  onEdit,
  onDelete,
}: {
  group: LarkGroupDto;
  bots: readonly ChatbotSummary[];
  botsLoading: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const test = useMutation({ mutationFn: () => settingsApi.testLarkGroup(group.id) });
  const assigned = resolveGroupChatbots(group.chatbotIds, bots);

  return (
    <li className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate font-medium">{group.name}</span>
            {group.hasSecret && (
              <Badge variant="secondary">
                <KeyRound aria-hidden />
                Có secret
              </Badge>
            )}
          </div>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {shortenWebhook(group.webhookUrl)}
          </span>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => test.mutate()}
            disabled={test.isPending}
            title="Gửi một thẻ thử vào nhóm Lark này"
          >
            {test.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
            Gửi thử
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onEdit}>
            <Pencil aria-hidden />
            Sửa
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onDelete}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 aria-hidden />
            Xóa
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {botsLoading ? (
          <Skeleton className="h-5 w-32" />
        ) : assigned.length > 0 ? (
          assigned.map((b) => <BotChip key={b.id} name={b.name} isActive={b.isActive} />)
        ) : group.chatbotIds.length > 0 ? (
          <span className="text-xs text-muted-foreground">{group.chatbotIds.length} chatbot</span>
        ) : (
          <span className="text-xs text-amber-700 dark:text-amber-400">
            Chưa gắn chatbot nào — nhóm này chưa nhận thông báo.
          </span>
        )}
      </div>

      <TestResult mutation={test} />
    </li>
  );
}

function SecretField({
  id,
  form,
  setForm,
  saved,
  error,
}: {
  id: string;
  form: LarkGroupFormValues;
  setForm: (fn: (f: LarkGroupFormValues) => LarkGroupFormValues) => void;
  saved: LarkGroupDto | null;
  error?: string;
}) {
  const hasSaved = !!saved?.hasSecret;
  const value = form.secret.mode === 'set' ? form.secret.value : '';
  return (
    <Field
      label="Secret ký tin (tùy chọn)"
      htmlFor={`${id}-secret`}
      error={error}
      errorId={`${id}-secret-err`}
      hint={
        form.secret.mode === 'clear'
          ? 'Secret sẽ bị xóa khi bấm Lưu.'
          : 'Nếu bot Lark bật “Signature verification”, dán secret vào đây. Secret được mã hóa và không bao giờ hiển thị lại.'
      }
      aside={
        hasSaved && form.secret.mode === 'keep' ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="size-3.5" aria-hidden />
            Đã lưu
          </span>
        ) : undefined
      }
    >
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <KeyRound
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            id={`${id}-secret`}
            type="password"
            value={value}
            onChange={(e) => setForm((f) => ({ ...f, secret: { mode: 'set', value: e.target.value } }))}
            placeholder={
              form.secret.mode === 'clear'
                ? 'Sẽ xóa secret'
                : hasSaved
                  ? 'Đã có secret — để trống để giữ nguyên'
                  : 'Chưa có secret'
            }
            className="pl-8"
            autoComplete="new-password"
            disabled={form.secret.mode === 'clear'}
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-secret-err` : undefined}
          />
        </div>
        {hasSaved && form.secret.mode !== 'clear' && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setForm((f) => ({ ...f, secret: { mode: 'clear' } }))}
          >
            <Trash2 aria-hidden />
            Xóa secret
          </Button>
        )}
        {form.secret.mode === 'clear' && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setForm((f) => ({ ...f, secret: { mode: 'keep' } }))}
          >
            <Undo2 aria-hidden />
            Giữ lại
          </Button>
        )}
      </div>
    </Field>
  );
}

function ChatbotPicker({
  id,
  selected,
  onToggle,
  bots,
  botsQuery,
  others,
  error,
}: {
  id: string;
  selected: readonly string[];
  onToggle: (botId: string) => void;
  bots: readonly ChatbotSummary[];
  botsQuery: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  others: Map<string, string[]>;
  error?: string;
}) {
  const sorted = useMemo(() => sortChatbotsForPicker(bots), [bots]);
  const selectedSet = new Set(selected);
  const errorId = `${id}-bots-err`;
  const hintId = `${id}-bots-hint`;
  return (
    // fieldset/legend: mỗi ô chọn được đọc kèm tên nhóm; gợi ý/lỗi gắn vào cả nhóm.
    <fieldset className="flex min-w-0 flex-col gap-1.5" aria-describedby={error ? errorId : hintId}>
      <legend className="mb-1.5 flex min-h-5 w-full items-center gap-2 text-sm leading-none font-medium">
        Chatbot gửi vào nhóm này
        {bots.length > 0 && (
          <span className="ml-auto text-xs font-normal text-muted-foreground tabular-nums" aria-hidden>
            Đã chọn {selectedSet.size}
          </span>
        )}
      </legend>
      {botsQuery.isPending ? (
        <div className="flex flex-col gap-2" aria-hidden>
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : botsQuery.isError ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col gap-2">
            {errorText(botsQuery.error, 'Không tải được danh sách chatbot.')}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => void botsQuery.refetch()}
            >
              <RefreshCw aria-hidden />
              Thử lại
            </Button>
          </AlertDescription>
        </Alert>
      ) : sorted.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
          Chưa có chatbot nào.
        </p>
      ) : (
        <ul className="flex max-h-64 flex-col divide-y overflow-y-auto rounded-lg border">
          {sorted.map((bot) => {
            const also = alsoInGroupsLabel(others.get(bot.id));
            const inputId = `${id}-bot-${bot.id}`;
            return (
              <li key={bot.id}>
                <label
                  htmlFor={inputId}
                  className="flex cursor-pointer items-start gap-2.5 px-3 py-2 hover:bg-accent/50"
                >
                  <input
                    id={inputId}
                    type="checkbox"
                    className="mt-0.5 size-4 shrink-0 accent-brand"
                    checked={selectedSet.has(bot.id)}
                    onChange={() => onToggle(bot.id)}
                    aria-describedby={error ? errorId : undefined}
                  />
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={cn('truncate text-sm', !bot.isActive && 'text-muted-foreground')}>
                      {bot.name}
                      {!bot.isActive && <span className="ml-1 text-xs">(đang tắt)</span>}
                    </span>
                    {also && (
                      <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                        <AlertTriangle className="size-3 shrink-0" aria-hidden />
                        {also}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {!error && (
        <p id={hintId} className="text-xs text-muted-foreground">
          Bot có thể ở nhiều nhóm — thông báo của bot gửi vào tất cả các nhóm đó.
        </p>
      )}
      <FieldError id={errorId} message={error} />
    </fieldset>
  );
}

function LarkGroupDialog({
  group: savedGroup,
  groups,
  onClose,
  onDirtyChange,
}: {
  /** null = thêm nhóm mới. */
  group: LarkGroupDto | null;
  groups: readonly LarkGroupDto[];
  onClose: () => void;
  /** Báo trang (cảnh báo rời trang / tải lại) khi dialog có thay đổi chưa lưu. */
  onDirtyChange: (dirty: boolean) => void;
}) {
  const id = useId();
  const qc = useQueryClient();
  const toast = useToast();
  const botsQuery = useChatbots(true);
  const bots = botsQuery.data ?? [];
  const [rawForm, setFormState] = useState<LarkGroupFormValues>(() => larkGroupFormFrom(savedGroup));
  const [errors, setErrors] = useState<LarkGroupFormErrors>({});
  const others = useMemo(() => otherGroupsByChatbot(groups, savedGroup?.id ?? null), [groups, savedGroup]);
  // Cache nhóm có thể còn id bot đã bị xóa (ẩn khỏi danh sách, không bỏ chọn được ⇒ server 400): bỏ id đó khỏi cả
  // form lẫn nhóm đã lưu. Chỉ khi danh sách bot vừa tải xong — không cắt nhầm bot mới tạo khi cache bot còn cũ.
  const canPrune = botsQuery.isSuccess && !botsQuery.isFetching;
  const group =
    savedGroup && canPrune
      ? { ...savedGroup, chatbotIds: pruneUnknownChatbotIds(savedGroup.chatbotIds, bots) }
      : savedGroup;
  const form = canPrune
    ? { ...rawForm, chatbotIds: pruneUnknownChatbotIds(rawForm.chatbotIds, bots) }
    : rawForm;
  const dirty = isLarkGroupDirty(form, group);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const setForm = (fn: (f: LarkGroupFormValues) => LarkGroupFormValues) => setFormState(fn);

  const save = useMutation({
    mutationFn: (req: SaveRequest) =>
      req.kind === 'create'
        ? settingsApi.createLarkGroup(req.body)
        : settingsApi.updateLarkGroup(req.id, req.body),
    onSuccess: (saved) => {
      qc.setQueryData<LarkGroupDto[]>(settingsKeys.larkGroups, (old) =>
        old ? (group ? old.map((g) => (g.id === saved.id ? saved : g)) : [...old, saved]) : old,
      );
      void qc.invalidateQueries({ queryKey: settingsKeys.larkGroups });
      toast({
        title: group ? `Đã lưu nhóm "${saved.name}"` : `Đã thêm nhóm "${saved.name}"`,
        variant: 'success',
      });
      onClose();
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (save.isPending) return;
    if (!group) {
      const v = validateCreateLarkGroup(form);
      setErrors(v.ok ? {} : v.errors);
      if (v.ok) save.mutate({ kind: 'create', body: v.body });
      return;
    }
    const v = validateUpdateLarkGroup(form, group);
    setErrors(v.ok ? {} : v.errors);
    if (!v.ok) return;
    if (Object.keys(v.body).length === 0) return onClose(); // không đổi gì
    save.mutate({ kind: 'update', id: group.id, body: v.body });
  }

  function requestClose() {
    if (save.isPending) return;
    if (dirty && !window.confirm('Bỏ các thay đổi chưa lưu?')) return;
    onClose();
  }

  function toggleBot(botId: string) {
    setForm((f) => ({
      ...f,
      chatbotIds: f.chatbotIds.includes(botId)
        ? f.chatbotIds.filter((x) => x !== botId)
        : [...f.chatbotIds, botId],
    }));
    setErrors((e) => ({ ...e, chatbotIds: undefined }));
  }

  const formId = `${id}-form`;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && requestClose()}
      title={group ? `Sửa nhóm Lark "${group.name}"` : 'Thêm nhóm Lark'}
      description="Thông báo của các chatbot được chọn chỉ gửi vào nhóm này thay cho nhóm chung."
      className="sm:max-w-xl"
      footer={
        <>
          <Button type="button" variant="outline" onClick={requestClose} disabled={save.isPending}>
            Hủy
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="brand"
            disabled={save.isPending || (!!group && !dirty)}
          >
            {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {group ? 'Lưu' : 'Thêm nhóm'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Field label="Tên nhóm" htmlFor={`${id}-name`} error={errors.name} errorId={`${id}-name-err`}>
          <Input
            id={`${id}-name`}
            data-autofocus
            value={form.name}
            maxLength={LARK_GROUP_LIMITS.nameMax + 20}
            onChange={(e) => {
              setForm((f) => ({ ...f, name: e.target.value }));
              setErrors((er) => ({ ...er, name: undefined }));
            }}
            placeholder="VD: Nhóm Sale Hà Nội"
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? `${id}-name-err` : undefined}
            autoComplete="off"
          />
        </Field>

        <Field
          label="Webhook URL"
          htmlFor={`${id}-url`}
          error={errors.webhookUrl}
          errorId={`${id}-url-err`}
          hint={WEBHOOK_HINT}
        >
          <Input
            id={`${id}-url`}
            type="url"
            inputMode="url"
            value={form.webhookUrl}
            onChange={(e) => {
              setForm((f) => ({ ...f, webhookUrl: e.target.value }));
              setErrors((er) => ({ ...er, webhookUrl: undefined }));
            }}
            placeholder="https://open.larksuite.com/open-apis/bot/v2/hook/…"
            aria-invalid={!!errors.webhookUrl}
            aria-describedby={errors.webhookUrl ? `${id}-url-err` : undefined}
            className="font-mono text-xs md:text-xs"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <SecretField
          id={id}
          form={form}
          setForm={(fn) => {
            setForm(fn);
            setErrors((er) => ({ ...er, secret: undefined }));
          }}
          saved={group}
          error={errors.secret}
        />

        <ChatbotPicker
          id={id}
          selected={form.chatbotIds}
          onToggle={toggleBot}
          bots={bots}
          botsQuery={botsQuery}
          others={others}
          error={errors.chatbotIds}
        />

        {errors.form && (
          <Alert variant="destructive">
            <AlertDescription>{errors.form}</AlertDescription>
          </Alert>
        )}
        {save.isError && (
          <Alert variant="destructive">
            <AlertDescription>{errorText(save.error, 'Không lưu được nhóm Lark.')}</AlertDescription>
          </Alert>
        )}
      </form>
    </Dialog>
  );
}

type SaveRequest =
  | { kind: 'create'; body: CreateLarkGroupRequest }
  | { kind: 'update'; id: string; body: UpdateLarkGroupRequest };

function DeleteLarkGroupDialog({ group, onClose }: { group: LarkGroupDto; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: () => settingsApi.removeLarkGroup(group.id),
    onSuccess: () => {
      qc.setQueryData<LarkGroupDto[]>(settingsKeys.larkGroups, (old) =>
        old?.filter((g) => g.id !== group.id),
      );
      void qc.invalidateQueries({ queryKey: settingsKeys.larkGroups });
      toast({ title: `Đã xóa nhóm "${group.name}"`, variant: 'success' });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !mutation.isPending && onClose()}
      title={`Xóa nhóm Lark "${group.name}"?`}
      description="Chatbot của nhóm này sẽ gửi thông báo về nhóm chung (nếu không thuộc nhóm riêng nào khác)."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            Hủy
          </Button>
          <Button variant="destructive" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Trash2 aria-hidden />}
            Xóa nhóm
          </Button>
        </>
      }
    >
      {mutation.isError && (
        <Alert variant="destructive">
          <AlertDescription>{errorText(mutation.error, 'Không xóa được nhóm Lark.')}</AlertDescription>
        </Alert>
      )}
    </Dialog>
  );
}

/** Khối "Nhóm Lark theo chatbot" nằm dưới cấu hình nhóm chung trong thẻ "Thông báo Lark". */
export function LarkGroupsSection({
  onDirtyChange = noop,
}: {
  /** Dialog thêm/sửa nhóm có thay đổi chưa lưu (gộp vào cảnh báo rời trang của Cài đặt). */
  onDirtyChange?: (dirty: boolean) => void;
} = {}) {
  const query = useLarkGroups();
  const botsQuery = useChatbots();
  const [editing, setEditing] = useState<LarkGroupDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<LarkGroupDto | null>(null);
  const groups = query.data ?? [];
  const atLimit = groups.length >= LARK_GROUP_LIMITS.maxGroups;

  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <Users className="size-4 text-muted-foreground" aria-hidden />
            Nhóm Lark theo chatbot
          </h3>
          <p className="text-sm text-muted-foreground">
            Gắn chatbot vào nhóm Lark riêng: thông báo của chatbot đó (chuyển người, nhắc lại, bấm nút, báo
            nhân viên) chỉ gửi vào nhóm này. Chatbot không thuộc nhóm nào vẫn gửi vào nhóm chung ở trên.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit shrink-0"
          onClick={() => setEditing('new')}
          disabled={!query.isSuccess || atLimit}
          title={atLimit ? `Tối đa ${LARK_GROUP_LIMITS.maxGroups} nhóm` : undefined}
        >
          <Plus aria-hidden />
          Thêm nhóm Lark
        </Button>
      </div>

      {query.isPending ? (
        <div className="flex flex-col gap-2" aria-hidden>
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : query.isError ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col gap-2">
            {errorText(query.error, 'Không tải được danh sách nhóm Lark.')}
            <Button variant="outline" size="sm" className="w-fit" onClick={() => void query.refetch()}>
              <RefreshCw aria-hidden />
              Thử lại
            </Button>
          </AlertDescription>
        </Alert>
      ) : groups.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          Chưa có nhóm riêng — mọi chatbot đang gửi thông báo vào nhóm chung ở trên.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {groups.map((g) => (
            <GroupRow
              key={`${g.id}:${g.updatedAt}`}
              group={g}
              bots={botsQuery.data ?? []}
              botsLoading={botsQuery.isPending}
              onEdit={() => setEditing(g)}
              onDelete={() => setDeleting(g)}
            />
          ))}
        </ul>
      )}

      {editing && (
        <LarkGroupDialog
          key={editing === 'new' ? 'new' : editing.id}
          group={editing === 'new' ? null : editing}
          groups={groups}
          onClose={() => setEditing(null)}
          onDirtyChange={onDirtyChange}
        />
      )}
      {deleting && (
        <DeleteLarkGroupDialog key={deleting.id} group={deleting} onClose={() => setDeleting(null)} />
      )}
    </div>
  );
}
