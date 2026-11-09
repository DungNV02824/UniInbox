// Quản lý channel_accounts (trang admin Kênh).
import { auditLogs, channelAccounts, conversations, messages, type ChannelAccount, type Db } from '@dezon/db';
import type {
  ChannelAccountDto,
  ChannelConnectedBy,
  ChannelStats,
  ConnectMessengerPageRequest,
  UpdateChannelRequest,
} from '@dezon/shared';
import { and, asc, count, eq } from 'drizzle-orm';
import type { ResolvedChannelAccount } from '../connectors/types';
import type { MessengerCredentials, MessengerGraphApi } from '../connectors/messenger';
import { InboxNotFoundError, InboxValidationError } from '../inbox/errors';
import { readSyncState } from '../sync/state';

export interface CredentialsCipher {
  encryptJson(value: unknown): string;
  decryptJson<T>(payload: string): T;
}

/** Bảng màu nhãn kênh; kênh mới lấy màu theo số kênh hiện có. */
export const CHANNEL_COLOR_PALETTE = [
  '#2563eb',
  '#16a34a',
  '#db2777',
  '#ea580c',
  '#7c3aed',
  '#0891b2',
  '#ca8a04',
  '#dc2626',
] as const;

const CHANNEL_NOT_FOUND = 'Không tìm thấy kênh';

/** Phần channel_accounts.settings do trang Kênh quản lý. */
export interface ChannelConnectionSettings {
  connectedBy: ChannelConnectedBy | null;
  pictureUrl: string | null;
}

const shortStr = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined;

/** Đọc an toàn settings (jsonb tự do) => connectedBy/pictureUrl. */
export function readConnectionSettings(
  settings: Record<string, unknown> | null | undefined,
): ChannelConnectionSettings {
  const raw = settings?.connectedBy;
  let connectedBy: ChannelConnectedBy | null = null;
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (r.provider === 'facebook_login' || r.provider === 'token') {
      const fbUserId = shortStr(r.fbUserId, 64);
      const fbUserName = shortStr(r.fbUserName, 200);
      connectedBy = {
        provider: r.provider,
        ...(fbUserId && { fbUserId }),
        ...(fbUserName && { fbUserName }),
      };
    }
  }
  const pic = settings?.pictureUrl;
  const pictureUrl = typeof pic === 'string' && /^https:\/\//.test(pic) ? pic : null;
  return { connectedBy, pictureUrl };
}

/** Không bao giờ đưa credentials ra DTO. */
function toDto(row: ChannelAccount): ChannelAccountDto {
  const { connectedBy, pictureUrl } = readConnectionSettings(row.settings);
  return {
    id: row.id,
    type: row.type,
    displayName: row.displayName,
    externalId: row.externalId,
    status: row.status,
    lastError: row.lastError,
    color: row.color,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    connectedBy,
    pictureUrl,
    sync: readSyncState(row.settings),
  };
}

const errorMessage = (err: unknown) => (err instanceof Error && err.message ? err.message : String(err));

/** Danh sách kênh kèm số hội thoại / tin nhắn mỗi kênh (một truy vấn, đếm theo nhóm — không N+1). */
export async function listChannels(db: Db): Promise<ChannelAccountDto[]> {
  const convCounts = db
    .select({ channelAccountId: conversations.channelAccountId, n: count().as('conv_n') })
    .from(conversations)
    .groupBy(conversations.channelAccountId)
    .as('conv_counts');
  const msgCounts = db
    .select({ channelAccountId: messages.channelAccountId, n: count().as('msg_n') })
    .from(messages)
    .groupBy(messages.channelAccountId)
    .as('msg_counts');
  const rows = await db
    .select({ channel: channelAccounts, conversations: convCounts.n, messages: msgCounts.n })
    .from(channelAccounts)
    .leftJoin(convCounts, eq(convCounts.channelAccountId, channelAccounts.id))
    .leftJoin(msgCounts, eq(msgCounts.channelAccountId, channelAccounts.id))
    .orderBy(asc(channelAccounts.createdAt), asc(channelAccounts.id));
  return rows.map((r) => {
    const stats: ChannelStats = {
      conversations: Number(r.conversations ?? 0),
      messages: Number(r.messages ?? 0),
    };
    return { ...toDto(r.channel), stats };
  });
}

async function pickDefaultColor(db: Db): Promise<string> {
  const [row] = await db.select({ n: count() }).from(channelAccounts);
  const n = row?.n ?? 0;
  return CHANNEL_COLOR_PALETTE[n % CHANNEL_COLOR_PALETTE.length] ?? CHANNEL_COLOR_PALETTE[0];
}

/** Thông tin thêm khi kết nối (Facebook Login). */
export interface ConnectMessengerPageOptions {
  /** Mặc định { provider: 'token' }. */
  connectedBy?: ChannelConnectedBy;
  /** undefined = giữ ảnh cũ. */
  pictureUrl?: string | null;
  /** Token phải thuộc đúng Page này (chống lẫn token giữa các Page). */
  expectedPageId?: string;
}

/**
 * Kết nối (hoặc kết nối lại) một Fanpage: xác minh token qua graph.getPage, subscribeApp,
 * upsert channel_accounts (type messenger, external_id = page id, credentials mã hóa,
 * status connected, last_error null, settings.connectedBy/pictureUrl). Ghi audit_logs.
 * Ném InboxValidationError nếu token sai.
 */
export async function connectMessengerPage(
  db: Db,
  deps: { graph: MessengerGraphApi; cipher: CredentialsCipher; actorUserId: string },
  input: ConnectMessengerPageRequest,
  options: ConnectMessengerPageOptions = {},
): Promise<ChannelAccountDto> {
  const token = input.pageAccessToken.trim();
  let page: { id: string; name: string };
  try {
    page = await deps.graph.getPage(token);
  } catch (err) {
    throw new InboxValidationError(`Không xác minh được Page Access Token: ${errorMessage(err)}`);
  }
  if (options.expectedPageId !== undefined && page.id !== options.expectedPageId) {
    throw new InboxValidationError('Token không thuộc Trang đã chọn');
  }
  try {
    await deps.graph.subscribeApp(page.id, token);
  } catch (err) {
    throw new InboxValidationError(
      `Không đăng ký được webhook cho Fanpage "${page.name}": ${errorMessage(err)}`,
    );
  }

  const [existing] = await db
    .select()
    .from(channelAccounts)
    .where(and(eq(channelAccounts.type, 'messenger'), eq(channelAccounts.externalId, page.id)));
  // Kết nối lại: giữ tên/màu admin đã đặt trừ khi truyền mới.
  const displayName = input.displayName ?? existing?.displayName ?? page.name;
  const color = input.color ?? existing?.color ?? (await pickDefaultColor(db));
  const credentials = {
    enc: deps.cipher.encryptJson({ pageAccessToken: token } satisfies MessengerCredentials),
  };
  const previous = readConnectionSettings(existing?.settings);
  const connectedBy: ChannelConnectedBy = options.connectedBy ?? { provider: 'token' };
  const settings: Record<string, unknown> = {
    ...(existing?.settings ?? {}),
    connectedBy,
    pictureUrl: options.pictureUrl === undefined ? previous.pictureUrl : options.pictureUrl,
  };
  const now = new Date();

  const row = await db.transaction(async (tx) => {
    const [saved] = await tx
      .insert(channelAccounts)
      .values({
        type: 'messenger',
        externalId: page.id,
        displayName,
        color,
        credentials,
        settings,
        status: 'connected',
        lastError: null,
      })
      .onConflictDoUpdate({
        target: [channelAccounts.type, channelAccounts.externalId],
        set: {
          displayName,
          color,
          credentials,
          settings,
          status: 'connected',
          lastError: null,
          updatedAt: now,
        },
      })
      .returning();
    if (!saved) throw new Error('Không lưu được kênh');
    await tx.insert(auditLogs).values({
      userId: deps.actorUserId,
      action: 'channel.connect',
      entity: 'channel_account',
      entityId: saved.id,
      data: {
        type: 'messenger',
        externalId: page.id,
        reconnect: Boolean(existing),
        provider: connectedBy.provider,
      },
    });
    return saved;
  });
  return toDto(row);
}

export async function updateChannel(
  db: Db,
  deps: { actorUserId: string },
  id: string,
  input: UpdateChannelRequest,
): Promise<ChannelAccountDto> {
  const set: { displayName?: string; color?: string } = {};
  if (input.displayName !== undefined) set.displayName = input.displayName;
  if (input.color !== undefined) set.color = input.color;

  const row = await db.transaction(async (tx) => {
    const [saved] = await tx
      .update(channelAccounts)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(channelAccounts.id, id))
      .returning();
    if (!saved) throw new InboxNotFoundError(CHANNEL_NOT_FOUND);
    await tx.insert(auditLogs).values({
      userId: deps.actorUserId,
      action: 'channel.update',
      entity: 'channel_account',
      entityId: id,
      data: { ...set },
    });
    return saved;
  });
  return toDto(row);
}

/** Ngắt kết nối: thử unsubscribeApp (bỏ qua lỗi), xóa credentials, status disconnected. Giữ dữ liệu hội thoại. */
export async function disconnectChannel(
  db: Db,
  deps: { graph: MessengerGraphApi; cipher: CredentialsCipher; actorUserId: string },
  id: string,
): Promise<ChannelAccountDto> {
  const [current] = await db.select().from(channelAccounts).where(eq(channelAccounts.id, id));
  if (!current) throw new InboxNotFoundError(CHANNEL_NOT_FOUND);

  let unsubscribed = false;
  if (current.type === 'messenger' && current.credentials?.enc) {
    try {
      const creds = deps.cipher.decryptJson<Partial<MessengerCredentials>>(current.credentials.enc);
      if (creds.pageAccessToken) {
        await deps.graph.unsubscribeApp(current.externalId, creds.pageAccessToken);
        unsubscribed = true;
      }
    } catch {
      // Token có thể đã hết hạn/bị thu hồi: vẫn ngắt kết nối phía hệ thống.
    }
  }

  const row = await db.transaction(async (tx) => {
    const [saved] = await tx
      .update(channelAccounts)
      .set({ credentials: null, status: 'disconnected', lastError: null, updatedAt: new Date() })
      .where(eq(channelAccounts.id, id))
      .returning();
    if (!saved) throw new InboxNotFoundError(CHANNEL_NOT_FOUND);
    await tx.insert(auditLogs).values({
      userId: deps.actorUserId,
      action: 'channel.disconnect',
      entity: 'channel_account',
      entityId: id,
      data: { type: saved.type, externalId: saved.externalId, unsubscribed },
    });
    return saved;
  });
  return toDto(row);
}

/** Đọc channel_account + giải mã credentials (cho worker gửi tin / lấy profile). */
export async function loadResolvedAccount(
  db: Db,
  cipher: CredentialsCipher,
  id: string,
): Promise<ResolvedChannelAccount | null> {
  const [row] = await db
    .select({
      id: channelAccounts.id,
      type: channelAccounts.type,
      externalId: channelAccounts.externalId,
      credentials: channelAccounts.credentials,
    })
    .from(channelAccounts)
    .where(eq(channelAccounts.id, id));
  if (!row?.credentials?.enc) return null;
  return {
    id: row.id,
    type: row.type,
    externalId: row.externalId,
    credentials: cipher.decryptJson<Record<string, unknown>>(row.credentials.enc),
  };
}
