'use client';

import Link from 'next/link';
import { ArrowLeft, CheckCircle2, Info, Loader2, RotateCcw } from 'lucide-react';
import type { ConversationDetail } from '@dezon/shared';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Feature } from '@/lib/config';
import { contactTagsOf } from '@/lib/contact-tags';
import { useUpdateConversation } from '@/lib/inbox-queries';
import { AssigneeSelect } from './assignee-select';
import { ChannelLabel } from './channel-label';
import { ChatbotSelect } from './chatbot-controls';
import { ContactTagChips } from './contact-tag-chips';
import { SendWindowClock } from './send-window-clock';

/** Đầu khung chat hiện tối đa ngần này nhãn trên một dòng; còn lại gộp "+N" (rê chuột xem đủ). */
const HEADER_TAGS_MAX = 4;

export function ChatHeader({
  conversation: c,
  onShowInfo,
}: {
  conversation: ConversationDetail;
  onShowInfo: () => void;
}) {
  const update = useUpdateConversation(c.id);
  const resolved = c.status === 'resolved';
  const { sendWindow } = c;

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b px-3 py-2 sm:px-4">
      <div className="flex min-w-0 items-center gap-2">
        <Button variant="ghost" size="icon" className="-ml-1 size-8 lg:hidden" asChild>
          <Link href="/inbox" aria-label="Quay lại danh sách hội thoại">
            <ArrowLeft aria-hidden />
          </Link>
        </Button>
        <Avatar src={c.contact.avatarUrl} name={c.contact.displayName} className="size-8 text-xs" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <h2 className="min-w-0 truncate text-sm font-semibold">{c.contact.displayName}</h2>
            <ContactTagChips
              tags={contactTagsOf(c.contact)}
              max={HEADER_TAGS_MAX}
              className="max-w-[65%] shrink-0 overflow-hidden"
              chipClassName="max-w-[8rem]"
            />
          </div>
          <ChannelLabel channel={c.channel} className="w-fit" />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant={resolved ? 'outline' : 'secondary'}
            size="sm"
            disabled={update.isPending}
            onClick={() => update.mutate({ status: resolved ? 'open' : 'resolved' })}
          >
            {update.isPending ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : resolved ? (
              <RotateCcw aria-hidden />
            ) : (
              <CheckCircle2 aria-hidden />
            )}
            <span className="hidden sm:inline">{resolved ? 'Mở lại' : 'Đánh dấu xong'}</span>
            <span className="sr-only sm:hidden">{resolved ? 'Mở lại' : 'Đánh dấu xong'}</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 lg:hidden"
            onClick={onShowInfo}
            aria-label="Thông tin khách"
          >
            <Info aria-hidden />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Feature flag="featureAiEnabled">
          <ChatbotSelect conversation={c} />
        </Feature>
        <SendWindowClock conversationId={c.id} info={sendWindow} />
        {sendWindow.tag === 'HUMAN_AGENT' && (
          <Badge
            variant="outline"
            className="border-sky-200 bg-sky-50 text-sky-700"
            title="Ngoài 24 giờ: tin của nhân viên được gắn tag HUMAN_AGENT (chỉ người thật, tối đa 7 ngày)"
          >
            HUMAN_AGENT
          </Badge>
        )}
        {sendWindow.costly && (
          <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">
            Tin có tính phí
          </Badge>
        )}
        {resolved && <Badge variant="secondary">Đã xong</Badge>}
        <div className="ml-auto">
          <AssigneeSelect conversation={c} />
        </div>
      </div>
      {sendWindow.allowed && sendWindow.reason && (
        <p className="text-xs text-muted-foreground">{sendWindow.reason}</p>
      )}
    </div>
  );
}
