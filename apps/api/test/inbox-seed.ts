// Dữ liệu hộp thư mẫu cho test e2e: 1 Fanpage, 3 hội thoại (của admin, của agent, chưa phân công).
import {
  channelAccounts,
  contactIdentities,
  contacts,
  conversations,
  createDb,
  messages,
  users,
} from '@dezon/db';
import { eq } from 'drizzle-orm';
import { ADMIN, AGENT } from './test-env';

export const PAGE_ID = '111222333444555';

export interface InboxSeed {
  adminId: string;
  agentId: string;
  channelId: string;
  /** Phân công cho admin — agent không được xem. */
  adminConversationId: string;
  /** Phân công cho agent. */
  agentConversationId: string;
  /** Chưa phân công — ai cũng xem được. */
  unassignedConversationId: string;
}

export async function seedInbox(databaseUrl: string): Promise<InboxSeed> {
  const { db, close } = createDb(databaseUrl, { max: 1 });
  try {
    const userId = async (email: string) => {
      const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
      if (!row) throw new Error(`Thiếu user ${email}`);
      return row.id;
    };
    const adminId = await userId(ADMIN.email);
    const agentId = await userId(AGENT.email);
    const [channel] = await db
      .insert(channelAccounts)
      .values({
        type: 'messenger',
        displayName: 'Dezon Sofa',
        externalId: PAGE_ID,
        status: 'connected',
        color: '#e11d48',
      })
      .returning({ id: channelAccounts.id });

    const now = Date.now();
    const createConversation = async (
      name: string,
      psid: string,
      assignedUserId: string | null,
      ageMin: number,
    ) => {
      const at = new Date(now - ageMin * 60_000);
      const [contact] = await db
        .insert(contacts)
        .values({ displayName: name })
        .returning({ id: contacts.id });
      const [identity] = await db
        .insert(contactIdentities)
        .values({ contactId: contact!.id, channelAccountId: channel!.id, externalUserId: psid })
        .returning({ id: contactIdentities.id });
      const [conversation] = await db
        .insert(conversations)
        .values({
          contactId: contact!.id,
          channelAccountId: channel!.id,
          contactIdentityId: identity!.id,
          assignedUserId,
          lastCustomerMessageAt: at,
          lastMessageAt: at,
          unreadCount: 1,
        })
        .returning({ id: conversations.id });
      await db.insert(messages).values({
        conversationId: conversation!.id,
        channelAccountId: channel!.id,
        senderType: 'customer',
        externalMessageId: `m_seed_${psid}`,
        text: `Xin chào, tôi là ${name}`,
        status: 'received',
        sentAt: at,
      });
      return conversation!.id;
    };

    return {
      adminId,
      agentId,
      channelId: channel!.id,
      adminConversationId: await createConversation('Chị Lan', '24000000000000011', adminId, 30),
      agentConversationId: await createConversation('Anh Minh', '24000000000000012', agentId, 20),
      unassignedConversationId: await createConversation('Chị Hoa', '24000000000000013', null, 10),
    };
  } finally {
    await close();
  }
}
