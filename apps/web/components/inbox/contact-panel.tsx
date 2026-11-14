'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, Mail, Phone, UserRound } from 'lucide-react';
import type { ConversationDetail } from '@dezon/shared';
import { EmptyState } from '@/components/empty-state';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useFeature } from '@/lib/config';
import { useConversation } from '@/lib/inbox-queries';
import { ChannelLabel } from './channel-label';
import { ContactNameEditor, ContactNotesFields, ContactTagsEditor } from './contact-editors';
import { Panel } from './panel';
import { ProjectLogSection } from './project-log-section';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-b p-4 last:border-b-0">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

function ContactProfile({
  conversation: c,
  onJumpToChat,
}: {
  conversation: ConversationDetail;
  /** Bấm một dòng Nhật ký công trình: đưa khung chat ra (điện thoại) trước khi cuộn tới tin. */
  onJumpToChat: () => void;
}) {
  const contact = c.contactDetail;
  const aiEnabled = useFeature('featureAiEnabled');
  // Máy chủ cũ chưa gửi projectLogs ⇒ coi như chưa có.
  const projectLogs = c.projectLogs ?? [];
  return (
    <>
      <div className="flex flex-col items-center gap-2 border-b p-4 text-center">
        <Avatar src={contact.avatarUrl} name={contact.displayName} className="size-16 text-lg" />
        <ContactNameEditor conversationId={c.id} contactId={contact.id} name={contact.displayName} />
        {(contact.phone || contact.email) && (
          <div className="flex flex-col gap-1 text-sm text-muted-foreground">
            {contact.phone && (
              <span className="inline-flex items-center gap-1.5">
                <Phone className="size-3.5" aria-hidden />
                {contact.phone}
              </span>
            )}
            {contact.email && (
              <span className="inline-flex items-center gap-1.5">
                <Mail className="size-3.5" aria-hidden />
                {contact.email}
              </span>
            )}
          </div>
        )}
      </div>

      <Section title="Kênh liên hệ">
        <ul className="flex flex-col gap-2">
          {contact.identities.map((idn) => (
            <li key={idn.id} className="flex min-w-0 items-center gap-2 text-sm">
              <ChannelLabel channel={idn.channel} className="max-w-[60%] shrink-0" />
              <span className="min-w-0 truncate text-xs text-muted-foreground" title={idn.externalUserId}>
                {idn.externalUserId}
              </span>
              {idn.conversationId && idn.conversationId !== c.id && (
                <Link
                  href={`/inbox/${idn.conversationId}`}
                  className="ml-auto shrink-0 text-xs text-brand hover:underline"
                >
                  Mở
                </Link>
              )}
            </li>
          ))}
          {contact.identities.length === 0 && <li className="text-sm text-muted-foreground">Chưa có</li>}
        </ul>
      </Section>

      <Section title="Ghi chú">
        <ContactNotesFields
          conversationId={c.id}
          contactId={contact.id}
          contact={contact}
          captureFields={c.chatbot?.captureFields}
        />
      </Section>

      <Section title="Nhãn">
        <ContactTagsEditor
          conversationId={c.id}
          contactId={contact.id}
          tags={contact.tags}
          assignedUserId={c.assignedUser?.id ?? null}
        />
      </Section>

      {(aiEnabled || projectLogs.length > 0) && (
        <ProjectLogSection key={c.id} conversationId={c.id} logs={projectLogs} onJump={onJumpToChat} />
      )}
    </>
  );
}

export function ContactPanel({
  conversationId,
  onBack,
  className,
}: {
  conversationId?: string;
  onBack: () => void;
  className?: string;
}) {
  const detail = useConversation(conversationId);
  const back = (
    <Button variant="ghost" size="sm" className="lg:hidden" onClick={onBack}>
      <ArrowLeft aria-hidden />
      Quay lại chat
    </Button>
  );

  return (
    <Panel title="Thông tin khách" className={className} actions={conversationId ? back : undefined}>
      {!conversationId ? (
        <EmptyState
          icon={UserRound}
          title="Chưa chọn khách hàng"
          description="Hồ sơ và các kênh liên hệ của khách sẽ hiện ở đây."
        />
      ) : detail.isPending ? (
        <div className="flex flex-col items-center gap-3 p-4" aria-hidden>
          <Skeleton className="size-16 rounded-full" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : detail.data ? (
        <ContactProfile key={detail.data.contactDetail.id} conversation={detail.data} onJumpToChat={onBack} />
      ) : (
        <EmptyState icon={UserRound} title="Không tải được thông tin khách" />
      )}
    </Panel>
  );
}
