import { getConversationSummary, type InboxContext, recentConversationIdsOfContacts } from '@dezon/core';
import type { Db } from '@dezon/db';
import { REALTIME_EVENTS } from '@dezon/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DB } from '../../infra/db/db.constants';
import { INBOX_CONTEXT } from '../../infra/inbox/inbox.constants';
import { RealtimeService } from './realtime.service';
import { roomsOfSummary } from './rooms';

/** Số hội thoại tối đa được phát conversation.updated mỗi lần tag khách đổi. */
export const CONTACT_EMIT_LIMIT = 200;
/** Số truy vấn summary chạy song song khi phát. */
export const CONTACT_EMIT_CONCURRENCY = 10;

/**
 * Phát conversation.updated (summary mới, có contact.tags) cho hội thoại của các khách vừa đổi tag — để danh
 * sách hộp thư đang mở cập nhật ngay. Chỉ phát cho tối đa CONTACT_EMIT_LIMIT hội thoại mới nhất, song song tối
 * đa CONTACT_EMIT_CONCURRENCY; phần còn lại client thấy khi tải lại. Lỗi không làm hỏng request.
 */
@Injectable()
export class ContactConversationsBroadcaster {
  private readonly logger = new Logger(ContactConversationsBroadcaster.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(INBOX_CONTEXT) private readonly ctx: InboxContext,
    private readonly realtime: RealtimeService,
  ) {}

  async emitForContacts(contactIds: readonly string[]): Promise<void> {
    if (contactIds.length === 0) return;
    let ids: string[];
    try {
      ids = await recentConversationIdsOfContacts(this.db, contactIds, CONTACT_EMIT_LIMIT);
    } catch (error) {
      this.logger.warn({ err: error }, 'Không đọc được hội thoại của khách để phát realtime');
      return;
    }
    let failed = 0;
    let next = 0;
    const workers = Array.from({ length: Math.min(CONTACT_EMIT_CONCURRENCY, ids.length) }, async () => {
      while (next < ids.length) {
        const conversationId = ids[next++]!;
        try {
          const conversation = await getConversationSummary(this.db, conversationId, this.ctx);
          this.realtime.emit(roomsOfSummary(conversation), REALTIME_EVENTS.conversationUpdated, {
            conversation,
          });
        } catch {
          failed++;
        }
      }
    });
    await Promise.all(workers);
    if (failed > 0)
      this.logger.warn({ failed }, 'Không phát được conversation.updated sau khi đổi tag khách');
  }
}
