'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, CopyPlus, Loader2, MessagesSquare, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { ChatbotSummary } from '@dezon/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { duplicateRequest, usageText } from '@/lib/chatbot-form';
import { formatCount } from '@/lib/channels-admin';
import { chatbotKeys, chatbotsApi } from '@/lib/chatbots-api';
import { channelsKey } from '@/lib/inbox-keys';
import { errorText } from '@/lib/inbox-queries';
import { cn } from '@/lib/utils';
import { ActionMenu } from '../action-menu';
import { Switch } from '../switch';

export function useChatbotList() {
  return useQuery({ queryKey: chatbotKeys.list(), queryFn: () => chatbotsApi.list() });
}

function sortBots(list: readonly ChatbotSummary[]): ChatbotSummary[] {
  return [...list].sort(
    (a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name, 'vi'),
  );
}

function BotCard({
  bot,
  onDuplicate,
  onDelete,
  duplicating,
}: {
  bot: ChatbotSummary;
  onDuplicate: () => void;
  onDelete: () => void;
  duplicating: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const toggle = useMutation({
    mutationFn: (isActive: boolean) => chatbotsApi.update(bot.id, { isActive }),
    onMutate: async (isActive) => {
      await qc.cancelQueries({ queryKey: chatbotKeys.list() });
      const prev = qc.getQueryData<ChatbotSummary[]>(chatbotKeys.list());
      qc.setQueryData<ChatbotSummary[]>(chatbotKeys.list(), (old) =>
        old?.map((b) => (b.id === bot.id ? { ...b, isActive } : b)),
      );
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(chatbotKeys.list(), ctx.prev);
      toast({ title: 'Không đổi được trạng thái bot', description: errorText(err), variant: 'destructive' });
    },
    onSuccess: (_d, isActive) =>
      toast({
        title: isActive ? `Đã bật "${bot.name}"` : `Đã tắt "${bot.name}"`,
        description: isActive ? undefined : 'Bot ngừng trả lời ở mọi hội thoại đang gắn nó.',
        variant: 'success',
      }),
    onSettled: () => void qc.invalidateQueries({ queryKey: chatbotKeys.all }),
  });

  const href = `/admin/chatbots/${bot.id}`;
  return (
    <li
      className={cn(
        'group relative flex min-w-0 flex-col rounded-xl border bg-card text-card-foreground shadow-xs transition-shadow hover:shadow-sm',
        !bot.isActive && 'bg-card/70',
      )}
    >
      <div className="flex items-start gap-3.5 p-4 pb-3">
        <span
          className={cn(
            'flex size-11 shrink-0 items-center justify-center rounded-full',
            bot.isActive
              ? 'bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300'
              : 'bg-muted text-muted-foreground',
          )}
          aria-hidden
        >
          <Bot className="size-5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-start gap-2">
            <h3 className="min-w-0 flex-1 leading-snug font-semibold break-words">
              <Link
                href={href}
                className="rounded-sm outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {bot.name}
              </Link>
            </h3>
            {/* z-10: nằm trên lớp link phủ cả thẻ. */}
            <div className="relative z-10 flex items-center gap-2">
              <span
                className={cn(
                  'text-xs',
                  bot.isActive ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground',
                )}
              >
                {bot.isActive ? 'Đang bật' : 'Đang tắt'}
              </span>
              <Switch
                size="sm"
                checked={bot.isActive}
                disabled={toggle.isPending}
                onCheckedChange={(v) => toggle.mutate(v)}
                aria-label={bot.isActive ? `Tắt chatbot ${bot.name}` : `Bật chatbot ${bot.name}`}
              />
            </div>
          </div>
          <p
            className={cn(
              'line-clamp-2 text-sm break-words',
              bot.description ? 'text-muted-foreground' : 'text-muted-foreground/60 italic',
            )}
          >
            {bot.description || 'Chưa có mô tả'}
          </p>
        </div>
      </div>
      <div className="mt-auto flex items-center gap-2 rounded-b-xl border-t bg-muted/30 px-3 py-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <MessagesSquare className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{usageText(bot.conversationCount)}</span>
        </span>
        <div className="relative z-10 ml-auto flex items-center gap-1">
          <Button variant="outline" size="sm" asChild>
            <Link href={href}>
              <Pencil aria-hidden />
              Sửa
            </Link>
          </Button>
          {duplicating ? (
            <span className="flex size-8 items-center justify-center" aria-label="Đang nhân bản">
              <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
            </span>
          ) : (
            <ActionMenu
              label={`Thao tác khác cho chatbot ${bot.name}`}
              items={[
                { label: 'Nhân bản', icon: CopyPlus, onSelect: onDuplicate },
                {
                  label: 'Xóa chatbot',
                  icon: Trash2,
                  onSelect: onDelete,
                  destructive: true,
                  separated: true,
                },
              ]}
            />
          )}
        </div>
      </div>
    </li>
  );
}

function DeleteBotDialog({ bot, onClose }: { bot: ChatbotSummary; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: () => chatbotsApi.remove(bot.id),
    onSuccess: () => {
      qc.setQueryData<ChatbotSummary[]>(chatbotKeys.list(), (old) => old?.filter((b) => b.id !== bot.id));
      void qc.invalidateQueries({ queryKey: chatbotKeys.all });
      // Kênh dùng bot làm mặc định và hội thoại đang gắn bot đều đổi.
      void qc.invalidateQueries({ queryKey: channelsKey });
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      toast({ title: `Đã xóa "${bot.name}"`, variant: 'success' });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !mutation.isPending && onClose()}
      title={`Xóa chatbot "${bot.name}"?`}
      description="Không thể hoàn tác. Kiến thức, hướng dẫn và câu trả lời mẫu của bot sẽ mất."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            Hủy
          </Button>
          <Button variant="destructive" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Trash2 aria-hidden />}
            Xóa chatbot
          </Button>
        </>
      }
    >
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
        <li>
          {bot.conversationCount > 0 ? (
            <>
              <strong>{formatCount(bot.conversationCount)} hội thoại</strong> đang dùng bot sẽ chuyển về{' '}
              <em>Chatbot: Tắt</em> — nhân viên trả lời thủ công.
            </>
          ) : (
            'Bot chưa gắn vào hội thoại nào.'
          )}
        </li>
        <li>Kênh đặt bot này làm “Chatbot mặc định” sẽ về “Không dùng”.</li>
      </ul>
      {mutation.isError && (
        <Alert variant="destructive">
          <AlertDescription>{errorText(mutation.error, 'Không xóa được chatbot.')}</AlertDescription>
        </Alert>
      )}
    </Dialog>
  );
}

function LoadingGrid() {
  return (
    <ul className="grid gap-4 lg:grid-cols-2" aria-hidden>
      {[0, 1].map((i) => (
        <li key={i} className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs">
          <div className="flex items-center gap-3">
            <Skeleton className="size-11 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
          <Skeleton className="h-8 w-40" />
        </li>
      ))}
    </ul>
  );
}

export function ChatbotsAdmin() {
  const bots = useChatbotList();
  const qc = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const [deleting, setDeleting] = useState<ChatbotSummary | null>(null);
  const list = sortBots(bots.data ?? []);
  const activeCount = list.filter((b) => b.isActive).length;

  const duplicate = useMutation({
    mutationFn: async (bot: ChatbotSummary) => {
      const full = await chatbotsApi.get(bot.id);
      return chatbotsApi.create(
        duplicateRequest(
          full,
          list.map((b) => b.name),
        ),
      );
    },
    onSuccess: (copy) => {
      void qc.invalidateQueries({ queryKey: chatbotKeys.all });
      qc.setQueryData(chatbotKeys.detail(copy.id), copy);
      toast({
        title: `Đã tạo "${copy.name}"`,
        description: 'Bản sao đang tắt — kiểm tra lại rồi bật khi sẵn sàng.',
        variant: 'success',
      });
      router.push(`/admin/chatbots/${copy.id}`);
    },
    onError: (err) =>
      toast({ title: 'Không nhân bản được chatbot', description: errorText(err), variant: 'destructive' }),
  });

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6 lg:py-8">
      <header className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">Chatbot AI</h1>
          <p className="text-sm text-muted-foreground">
            Viết hướng dẫn và kiến thức cho từng bot, chat thử, rồi bật bot trong khung chat của hội thoại
            (hoặc đặt làm mặc định cho một Trang ở mục Kênh).
          </p>
          {bots.isSuccess && list.length > 0 && (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-emerald-500" aria-hidden />
                {activeCount} đang bật
              </span>
              {list.length - activeCount > 0 && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-slate-400" aria-hidden />
                  {list.length - activeCount} đang tắt
                </span>
              )}
            </p>
          )}
        </div>
        <Button variant="brand" asChild>
          <Link href="/admin/chatbots/new">
            <Plus aria-hidden />
            Tạo chatbot
          </Link>
        </Button>
      </header>

      {bots.isPending ? (
        <LoadingGrid />
      ) : bots.isError ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col gap-2">
            {errorText(bots.error, 'Không tải được danh sách chatbot.')}
            <Button variant="outline" size="sm" className="w-fit" onClick={() => void bots.refetch()}>
              <RefreshCw aria-hidden />
              Thử lại
            </Button>
          </AlertDescription>
        </Alert>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card p-10 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300">
            <Bot className="size-6" aria-hidden />
          </span>
          <p className="font-medium">Chưa có chatbot nào</p>
          <p className="max-w-md text-sm text-muted-foreground">
            Tạo một bot, tự viết bot là ai và trả lời thế nào trong phần Hướng dẫn, thêm thông tin vào phần
            Kiến thức rồi chat thử ngay bên cạnh. Bot chỉ trả lời ở hội thoại bạn bật cho nó.
          </p>
          <Button variant="brand" asChild>
            <Link href="/admin/chatbots/new">
              <Plus aria-hidden />
              Tạo chatbot đầu tiên
            </Link>
          </Button>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {list.map((bot) => (
            <BotCard
              key={bot.id}
              bot={bot}
              duplicating={duplicate.isPending && duplicate.variables?.id === bot.id}
              onDuplicate={() => duplicate.mutate(bot)}
              onDelete={() => setDeleting(bot)}
            />
          ))}
        </ul>
      )}

      {deleting && <DeleteBotDialog key={deleting.id} bot={deleting} onClose={() => setDeleting(null)} />}
    </main>
  );
}
