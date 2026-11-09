'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { cn } from '@/lib/utils';
import { ChatPanel } from './chat-panel';
import { ContactPanel } from './contact-panel';
import { ConversationListPanel } from './conversation-list-panel';

/**
 * Bố cục 3 cột (mục 8 đặc tả). Màn hình lớn: 320px / co giãn / 320px.
 * Điện thoại/máy tính bảng: mỗi lần một cột — danh sách (/inbox), khung chat (/inbox/<id>),
 * thông tin khách (bấm nút trong header chat); có nút quay lại.
 * Nằm trong layout của /inbox nên danh sách + bộ lọc giữ nguyên khi chuyển hội thoại.
 */
export function InboxLayout() {
  const params = useParams<{ conversationId?: string }>();
  const conversationId = typeof params.conversationId === 'string' ? params.conversationId : undefined;
  // Cột thông tin trên điện thoại: chỉ mở cho đúng hội thoại đã bấm (đổi hội thoại thì về khung chat).
  const [infoFor, setInfoFor] = useState<string | null>(null);
  const showInfo = !!conversationId && infoFor === conversationId;

  return (
    <div className="flex h-full min-h-0 bg-background">
      <ConversationListPanel
        selectedId={conversationId}
        className={cn(conversationId ? 'hidden' : 'flex', 'w-full lg:flex lg:w-80 lg:shrink-0 lg:border-r')}
      />
      <ChatPanel
        conversationId={conversationId}
        onShowInfo={() => setInfoFor(conversationId ?? null)}
        className={cn(conversationId && !showInfo ? 'flex' : 'hidden', 'w-full min-w-0 lg:flex lg:flex-1')}
      />
      <ContactPanel
        conversationId={conversationId}
        onBack={() => setInfoFor(null)}
        className={cn(showInfo ? 'flex' : 'hidden', 'w-full lg:flex lg:w-80 lg:shrink-0 lg:border-l')}
      />
    </div>
  );
}
