'use client';

import type { ConversationSummary } from '@dezon/shared';
import { NativeSelect } from '@/components/ui/select';
import { useAuth } from '@/lib/auth';
import { useDirectory, useUpdateConversation } from '@/lib/inbox-queries';
import { assigneeOptions } from './assignee-options';

/** Chọn người phụ trách hội thoại (agent chỉ thấy các lựa chọn mình được phép). */
export function AssigneeSelect({ conversation }: { conversation: ConversationSummary }) {
  const { user } = useAuth();
  const directory = useDirectory();
  const update = useUpdateConversation(conversation.id);
  const options = assigneeOptions({
    viewer: user,
    assigned: conversation.assignedUser,
    directory: directory.data ?? [],
  });

  return (
    <NativeSelect
      aria-label="Người phụ trách"
      title="Người phụ trách"
      className="w-44 max-w-full"
      value={conversation.assignedUser?.id ?? ''}
      disabled={update.isPending}
      onChange={(e) => update.mutate({ assignedUserId: e.target.value || null })}
    >
      {options.map((o) => (
        <option key={o.value || 'none'} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </NativeSelect>
  );
}
