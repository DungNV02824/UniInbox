import {
  createContactTag,
  deleteContactTagWithEffects,
  listContactTags,
  reorderContactTags,
  updateContactTagWithEffects,
} from '@dezon/core';
import type { Db } from '@dezon/db';
import {
  type ContactTagDto,
  type CreateContactTagRequest,
  type DeleteContactTagResponse,
  REALTIME_EVENTS,
  ROOMS_ALL_STAFF,
  type UpdateContactTagRequest,
} from '@dezon/shared';
import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../../infra/db/db.constants';
import { ContactConversationsBroadcaster } from '../realtime/contact-conversations-broadcaster';
import { RealtimeService } from '../realtime/realtime.service';

/**
 * Danh sách nhãn khách hàng: gọi lõi @dezon/core, phát 'contact_tags.updated' tới mọi nhân viên sau mỗi lần ghi;
 * đổi tên/xóa nhãn còn phát conversation.updated cho hội thoại của khách bị đổi/gỡ nhãn.
 */
@Injectable()
export class ContactTagsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly realtime: RealtimeService,
    private readonly contactConversations: ContactConversationsBroadcaster,
  ) {}

  list(): Promise<ContactTagDto[]> {
    return listContactTags(this.db);
  }

  async create(actorUserId: string, input: CreateContactTagRequest): Promise<ContactTagDto> {
    return this.notify(await createContactTag(this.db, actorUserId, input));
  }

  async update(actorUserId: string, id: string, input: UpdateContactTagRequest): Promise<ContactTagDto> {
    const { tag, affectedContactIds } = await updateContactTagWithEffects(this.db, actorUserId, id, input);
    this.notify(tag);
    await this.contactConversations.emitForContacts(affectedContactIds);
    return tag;
  }

  async reorder(actorUserId: string, ids: string[]): Promise<ContactTagDto[]> {
    return this.notify(await reorderContactTags(this.db, actorUserId, ids));
  }

  async remove(actorUserId: string, id: string): Promise<DeleteContactTagResponse> {
    const { result, affectedContactIds } = await deleteContactTagWithEffects(this.db, actorUserId, id);
    this.notify(result);
    await this.contactConversations.emitForContacts(affectedContactIds);
    return result;
  }

  private notify<T>(result: T): T {
    this.realtime.emit([...ROOMS_ALL_STAFF], REALTIME_EVENTS.contactTagsUpdated, {});
    return result;
  }
}
