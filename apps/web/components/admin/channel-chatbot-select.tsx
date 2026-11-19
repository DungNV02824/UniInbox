'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Loader2 } from 'lucide-react';
import type { ApplyDefaultChatbotPreview, ChannelAccountDto, ChatbotSummary } from '@dezon/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { NativeSelect } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import {
  APPLY_SAFETY_NOTE,
  applyButtonLabel,
  applyPromptText,
  applyResultToast,
  applySkippedText,
  defaultBotChangedToast,
  shouldOfferApply,
} from '@/lib/channel-default-bot';
import { chatbotKeys, chatbotsApi } from '@/lib/chatbots-api';
import { channelsApi } from '@/lib/inbox-api';
import { channelsKey, inboxKeys } from '@/lib/inbox-keys';
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
  const botName = (botId: string | null) => (botId ? list.find((b) => b.id === botId)?.name : undefined);
  /** Hộp thoại "Áp dụng cho hội thoại đang có?" — mở sau khi đổi sang một bot mà còn hội thoại dùng bot khác. */
  const [offer, setOffer] = useState<{ preview: ApplyDefaultChatbotPreview; botName?: string } | null>(null);

  const mutation = useMutation({
    // Đổi xong mới xem trước số hội thoại cũ (lỗi xem trước => bỏ qua, chỉ báo như cũ).
    mutationFn: async (defaultChatbotId: string | null) => {
      await channelsApi.update(channel.id, { defaultChatbotId });
      if (!defaultChatbotId) return null;
      return channelsApi.applyDefaultChatbotPreview(channel.id).catch(() => null);
    },
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
    onSuccess: (preview, botId) => {
      const name = botName(botId);
      const willOffer = shouldOfferApply(preview);
      toast({ ...defaultBotChangedToast(channel.displayName, name, botId, willOffer), variant: 'success' });
      if (willOffer && preview) setOffer({ preview, botName: name });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: channelsKey }),
  });

  const apply = useMutation({
    mutationFn: () => channelsApi.applyDefaultChatbot(channel.id),
    onSuccess: (result) => {
      // Máy chủ dùng bot mặc định HIỆN TẠI của kênh — lấy tên theo kết quả trả về.
      toast({ ...applyResultToast(result, botName(result.chatbotId) ?? offer?.botName), variant: 'success' });
      setOffer(null);
      void qc.invalidateQueries({ queryKey: inboxKeys.lists() });
      void qc.invalidateQueries({ queryKey: inboxKeys.details() });
    },
    onError: (err) =>
      toast({
        title: 'Không áp dụng được cho hội thoại đang có',
        description: errorText(err),
        variant: 'destructive',
      }),
  });

  function closeOffer(next: boolean) {
    if (next || apply.isPending) return;
    setOffer(null);
    apply.reset();
  }

  const skipped = offer ? applySkippedText(offer.preview) : null;
  const offerDialog = (
    <Dialog
      open={offer !== null}
      onOpenChange={closeOffer}
      title="Áp dụng cho hội thoại đang có?"
      description={
        offer ? applyPromptText(channel.displayName, offer.botName, offer.preview.eligible) : undefined
      }
      footer={
        <>
          <Button variant="outline" onClick={() => closeOffer(false)} disabled={apply.isPending}>
            Chỉ hội thoại mới
          </Button>
          <Button onClick={() => apply.mutate()} disabled={apply.isPending}>
            {apply.isPending && <Loader2 className="animate-spin" aria-hidden />}
            {applyButtonLabel(offer?.preview.eligible ?? 0)}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        {skipped && <p>{skipped}</p>}
        <p>{APPLY_SAFETY_NOTE}</p>
      </div>
    </Dialog>
  );

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
        Hội thoại mới của Trang này sẽ tự bật bot đã chọn. Hội thoại đang có chỉ đổi bot khi bạn đồng ý ở hộp
        thoại hỏi sau khi chọn; nhân viên vẫn bật/tắt bot từng hội thoại trong hộp thư.
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
      {offerDialog}
    </div>
  );
}
