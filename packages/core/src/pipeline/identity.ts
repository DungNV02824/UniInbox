// Bước (3) của 6.1: upsert contact_identity / contact (race-safe) và lấy tên, avatar khách.
import { contactIdentities, contacts, conversations, type ContactIdentity, type Db } from '@dezon/db';
import type { NormalizedInboundMessage } from '@dezon/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { loadResolvedAccount } from '../channels/service';
import { downloadToBuffer, storeMedia } from '../media/storage';
import { errorMessage, fallbackContactName } from './helpers';
import type { PipelineDeps } from './types';

/** Ảnh đại diện tối đa 5 MB. */
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
/**
 * Khoảng tối thiểu giữa hai lần gọi lại fetchProfile cho identity chưa có tên. Ngắn vì khách từ quảng cáo
 * chỉ đọc được profile sau khi họ trả lời (docs/research/messenger-platform.md) — thử lại ở tin sau.
 */
const PROFILE_RETRY_MS = 60 * 1000;

/** Dữ liệu lưu ở contact_identities.profile. */
interface IdentityProfile {
  name?: string;
  profileFetchedAt?: string;
}

interface ProfileResult {
  name?: string;
  avatarUrl?: string;
  fetched: boolean;
}

async function findIdentity(db: Db, channelAccountId: string, externalUserId: string) {
  const [row] = await db
    .select()
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.channelAccountId, channelAccountId),
        eq(contactIdentities.externalUserId, externalUserId),
      ),
    )
    .limit(1);
  return row;
}

/** Tin đọc qua đồng bộ (Conversations API), không phải webhook. */
function isSyncMessage(msg: NormalizedInboundMessage): boolean {
  const raw = msg.raw;
  return typeof raw === 'object' && raw !== null && (raw as { source?: unknown }).source === 'sync';
}

/** Lấy tên/avatar: ưu tiên profileHint, thiếu thì gọi connector.fetchProfile (lỗi không chặn luồng). */
async function resolveProfile(
  db: Db,
  deps: PipelineDeps,
  msg: NormalizedInboundMessage,
  wantFetch: boolean,
): Promise<ProfileResult> {
  const result: ProfileResult = {
    name: msg.profileHint?.name?.trim() || undefined,
    avatarUrl: msg.profileHint?.avatarUrl || undefined,
    fetched: false,
  };
  const connector = deps.connectors[msg.channelType];
  if (!wantFetch || !connector?.fetchProfile || (result.name && result.avatarUrl)) return result;
  // Đồng bộ đã có tên thật từ participants: không gọi thêm GET /{psid} cho mỗi khách (backfill hàng trăm
  // khách = hàng trăm lượt gọi, ở chế độ Phát triển luôn lỗi). Avatar của các khách này: nợ kỹ thuật.
  if (result.name && isSyncMessage(msg)) return result;
  try {
    const account = await loadResolvedAccount(db, deps.cipher, msg.channelAccountId);
    if (!account) return result;
    const profile = await connector.fetchProfile(account, msg.externalUserId);
    result.fetched = true;
    result.name ??= profile.name?.trim() || undefined;
    result.avatarUrl ??= profile.avatarUrl || undefined;
  } catch (error) {
    result.fetched = true;
    deps.logger.warn(
      { channelAccountId: msg.channelAccountId, err: errorMessage(error) },
      'Không lấy được hồ sơ khách',
    );
  }
  return result;
}

/** Tải avatar về S3 (prefix avatars) và lưu STORAGE KEY vào contacts.avatar_url nếu chưa có. */
async function saveAvatar(db: Db, deps: PipelineDeps, contactId: string, avatarUrl: string): Promise<void> {
  try {
    const file = await downloadToBuffer(avatarUrl, {
      maxBytes: AVATAR_MAX_BYTES,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    const stored = await storeMedia(deps.storage, {
      data: file.data,
      ...(file.mime ? { mime: file.mime } : {}),
      type: 'image',
      prefix: 'avatars',
    });
    const updated = await db
      .update(contacts)
      .set({ avatarUrl: stored.storage_key })
      .where(and(eq(contacts.id, contactId), isNull(contacts.avatarUrl)))
      .returning({ id: contacts.id });
    // Tiến trình khác đã đặt avatar trước: bỏ tệp vừa lưu.
    if (updated.length === 0) await deps.storage.delete(stored.storage_key).catch(() => undefined);
  } catch (error) {
    deps.logger.warn({ contactId, err: errorMessage(error) }, 'Không lưu được avatar khách');
  }
}

function profileJson(profile: ProfileResult, previous: IdentityProfile = {}, now: Date): IdentityProfile {
  return {
    ...previous,
    ...(profile.name ? { name: profile.name } : {}),
    ...(profile.fetched ? { profileFetchedAt: now.toISOString() } : {}),
  };
}

/**
 * Việc chậm, không cần trước khi lưu tin (tải avatar về S3): caller truyền mảng này thì việc được XẾP vào đây
 * thay vì chờ ngay — luồng tin đến chạy sau khi đã lên lịch chatbot (bớt độ trễ trả lời). Mỗi việc tự bắt lỗi.
 */
export type DeferredTasks = (() => Promise<void>)[];

function saveAvatarLater(
  db: Db,
  deps: PipelineDeps,
  contactId: string,
  avatarUrl: string,
  deferred: DeferredTasks | undefined,
): Promise<void> {
  if (!deferred) return saveAvatar(db, deps, contactId, avatarUrl);
  deferred.push(() => saveAvatar(db, deps, contactId, avatarUrl));
  return Promise.resolve();
}

/** Identity đã có nhưng chưa có tên: thử lấy lại (tối đa 1 lần/24h), cập nhật tên tạm và avatar. */
async function refreshProfile(
  db: Db,
  deps: PipelineDeps,
  msg: NormalizedInboundMessage,
  identity: ContactIdentity,
  deferred: DeferredTasks | undefined,
): Promise<void> {
  const previous = identity.profile as IdentityProfile;
  if (previous.name) return;
  const now = deps.ctx.now();
  const last = previous.profileFetchedAt ? Date.parse(previous.profileFetchedAt) : 0;
  const hasHint = Boolean(msg.profileHint?.name);
  if (!hasHint && now.getTime() - last < PROFILE_RETRY_MS) return;

  const profile = await resolveProfile(db, deps, msg, true);
  await db
    .update(contactIdentities)
    .set({ profile: profileJson(profile, previous, now) as Record<string, unknown> })
    .where(eq(contactIdentities.id, identity.id));
  if (profile.name) {
    // Chỉ thay tên tạm do hệ thống đặt, không ghi đè tên nhân viên đã sửa.
    await db
      .update(contacts)
      .set({ displayName: profile.name })
      .where(
        and(
          eq(contacts.id, identity.contactId),
          eq(contacts.displayName, fallbackContactName(msg.channelType, msg.externalUserId)),
        ),
      );
  }
  if (profile.avatarUrl) await saveAvatarLater(db, deps, identity.contactId, profile.avatarUrl, deferred);
}

/**
 * Đặt tên thật cho khách đã có (lấy từ participants của Conversations API) khi identity chưa có tên.
 * Cần vì tin đến qua webhook trước thì lúc đồng bộ mọi tin đều trùng, bước upsert identity không chạy lại.
 * Chỉ thay tên tạm do hệ thống đặt, không ghi đè tên nhân viên đã sửa. Trả conversation cần phát lại, hoặc null.
 */
export async function applyParticipantName(
  db: Db,
  deps: PipelineDeps,
  input: {
    channelAccountId: string;
    channelType: NormalizedInboundMessage['channelType'];
    externalUserId: string;
    name: string | undefined;
  },
): Promise<{ id: string; assignedUserId: string | null } | null> {
  const name = input.name?.trim();
  if (!name) return null;
  const identity = await findIdentity(db, input.channelAccountId, input.externalUserId);
  if (!identity) return null;
  const previous = identity.profile as IdentityProfile;
  if (previous.name) return null;

  await db
    .update(contactIdentities)
    .set({ profile: { ...previous, name } as Record<string, unknown> })
    .where(eq(contactIdentities.id, identity.id));
  const renamed = await db
    .update(contacts)
    .set({ displayName: name })
    .where(
      and(
        eq(contacts.id, identity.contactId),
        eq(contacts.displayName, fallbackContactName(input.channelType, input.externalUserId)),
      ),
    )
    .returning({ id: contacts.id });
  if (renamed.length === 0) return null;

  const [conversation] = await db
    .select({ id: conversations.id, assignedUserId: conversations.assignedUserId })
    .from(conversations)
    .where(eq(conversations.contactIdentityId, identity.id))
    .limit(1);
  deps.logger.info({ channelAccountId: input.channelAccountId }, 'Đã cập nhật tên khách từ đồng bộ');
  return conversation ?? null;
}

/**
 * Trả identity của khách (tạo contact + identity nếu mới). An toàn khi nhiều job chạy song song:
 * insert identity ON CONFLICT DO NOTHING, thua thì xóa contact vừa tạo và đọc lại bản đã có.
 * `deferred`: có ⇒ việc tải avatar được xếp vào đó (caller tự chạy sau), không chờ ở đây.
 */
export async function ensureContactIdentity(
  db: Db,
  deps: PipelineDeps,
  msg: NormalizedInboundMessage,
  deferred?: DeferredTasks,
): Promise<ContactIdentity> {
  const existing = await findIdentity(db, msg.channelAccountId, msg.externalUserId);
  if (existing) {
    await refreshProfile(db, deps, msg, existing, deferred);
    return existing;
  }

  const profile = await resolveProfile(db, deps, msg, true);
  const now = deps.ctx.now();
  const displayName = profile.name ?? fallbackContactName(msg.channelType, msg.externalUserId);

  const created = await db.transaction(async (tx) => {
    const [contact] = await tx.insert(contacts).values({ displayName }).returning({ id: contacts.id });
    if (!contact) throw new Error('Không tạo được contact');
    const [identity] = await tx
      .insert(contactIdentities)
      .values({
        contactId: contact.id,
        channelAccountId: msg.channelAccountId,
        externalUserId: msg.externalUserId,
        profile: profileJson(profile, {}, now) as Record<string, unknown>,
      })
      .onConflictDoNothing({ target: [contactIdentities.channelAccountId, contactIdentities.externalUserId] })
      .returning();
    if (!identity) await tx.delete(contacts).where(eq(contacts.id, contact.id));
    return identity;
  });

  if (!created) {
    const winner = await findIdentity(db, msg.channelAccountId, msg.externalUserId);
    if (!winner) throw new Error('Không tìm thấy contact_identity sau khi upsert');
    return winner;
  }
  if (profile.avatarUrl) await saveAvatarLater(db, deps, created.contactId, profile.avatarUrl, deferred);
  return created;
}
