'use client';

import { useId } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Loader2 } from 'lucide-react';
import type { ChannelAccountDto, ChatbotSummary } from '@dezon/shared';
import { NativeSelect } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { chatbotKeys, chatbotsApi } from '@/lib/chatbots-api';
import { channelsApi } from '@/lib/inbox-api';
import { channelsKey } from '@/lib/inbox-keys';
import { errorText } from '@/lib/inbox-queries';
import { InfoTip } from './info-tip';

/** Danh sách bot cho ô chọn ở trang Kênh (dùng chung cache với trang Chatbot AI). */
function useBotOptions() {
  return useQuery({ queryKey: chatbotKeys.list(), queryFn: () => chatbotsApi.list(), staleTime: 60_000 });
}

/** Ô "Chatbot mặc định" trên thẻ kênh: PATCH /channels/:id {defaultChatbotId}. */
export function ChannelChatbotSelect({ channel }: { channel: ChannelAccountDto }) {
  const id = useId();
  const qc = useQueryClient();
  const toast = useToast();
  const bots = useBotOptions();
  const current = channel.defaultChatbotId ?? null;
  const list: ChatbotSummary[] = bots.data ?? [];
  const known = current === null || list.some((b) => b.id === current);

  const mutation = useMutation({
    mutationFn: (defaultChatbotId: string | null) => channelsApi.update(channel.id, { defaultChatbotId }),
    onMutate: async (defaultChatbotId) => {
      await qc.cancelQueries({ queryKey: channelsKey });
      const prev = qc.getQueryData<ChannelAccountDto[]>(channelsKey);
      qc.setQueryData<ChannelAccountDto[]>(channelsKey, (old) =>
        old?.map((c) => (c.id === channel.id ? { ...c, defaultChatbotId } : c)),
      );
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(channelsKey, ctx.prev);
      toast({
        title: 'Không đổi được chatbot mặc định',
        description: errorText(err),
        variant: 'destructive',
      });
    },
    onSuccess: (_d, botId) => {
      const name = list.find((b) => b.id === botId)?.name;
      toast({
        title: botId
          ? `Hội thoại mới của "${channel.displayName}" sẽ dùng "${name ?? 'bot'}"`
          : 'Đã bỏ chatbot mặc định',
        description: 'Hội thoại cũ không đổi — bật/tắt bot từng hội thoại trong hộp thư.',
        variant: 'success',
      });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: channelsKey }),
  });

  if (bots.isSuccess && list.length === 0 && current === null) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <Bot className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
        <span>
          Chatbot mặc định: chưa có bot —{' '}
          <Link
            href="/admin/chatbots/new"
            className="font-medium text-brand underline-offset-2 hover:underline"
          >
            tạo chatbot
          </Link>
        </span>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <Bot className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
      <label htmlFor={id} className="shrink-0">
        Chatbot mặc định
      </label>
      <InfoTip label="Chatbot mặc định là gì?">
        Hội thoại mới của Trang này sẽ tự bật bot đã chọn. Hội thoại đang có không bị ảnh hưởng; nhân viên vẫn
        bật/tắt bot từng hội thoại trong hộp thư.
      </InfoTip>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <NativeSelect
          id={id}
          value={current ?? ''}
          onChange={(e) => mutation.mutate(e.target.value || null)}
          disabled={mutation.isPending || bots.isPending}
          className="min-w-0 flex-1 [&_select]:h-8 [&_select]:text-xs sm:max-w-64"
        >
          <option value="">Không dùng</option>
          {!known && <option value={current!}>(Bot không còn tồn tại)</option>}
          {list.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
              {b.isActive ? '' : ' (đang tắt)'}
            </option>
          ))}
        </NativeSelect>
        {(mutation.isPending || bots.isPending) && (
          <Loader2 className="size-3.5 shrink-0 animate-spin" aria-label="Đang tải" />
        )}
      </div>
    </div>
  );
}
