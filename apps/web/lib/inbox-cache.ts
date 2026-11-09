// Hàm THUẦN cập nhật dữ liệu cache (TanStack Query) khi có sự kiện realtime hoặc gửi tin lạc quan.
// Không phụ thuộc React để test được độc lập.
import { replaceEqualDeep, type InfiniteData } from '@tanstack/react-query';
import type {
  ConversationDetail,
  ConversationSummary,
  MessageDto,
  MessageStatus,
  Page,
  SendMessageRequest,
  UserRole,
} from '@dezon/shared';
import type { ConversationFilters } from '@/lib/inbox-api';

/** Tin trong cache khung chat; `pending` chỉ có ở tin lạc quan (để gửi lại khi lỗi). */
export type ChatMessage = MessageDto & { pending?: SendMessageRequest };

export type MessagesData = InfiniteData<Page<ChatMessage>, unknown>;
export type ConversationsData = InfiniteData<Page<ConversationSummary>, unknown>;

export interface Viewer {
  id: string;
  role: UserRole;
}

export const TEMP_ID_PREFIX = 'tmp:';

export function isTempMessage(m: Pick<MessageDto, 'id'>): boolean {
  return m.id.startsWith(TEMP_ID_PREFIX);
}

/** Quyền xem (quyết định 1A): admin xem tất cả; agent xem hội thoại của mình hoặc chưa phân công. */
export function canView(conv: Pick<ConversationSummary, 'assignedUser'>, viewer: Viewer): boolean {
  if (viewer.role === 'admin') return true;
  return conv.assignedUser === null || conv.assignedUser.id === viewer.id;
}

export function matchesFilters(conv: ConversationSummary, f: ConversationFilters, viewer: Viewer): boolean {
  if (f.channelType && conv.channel.type !== f.channelType) return false;
  if (f.channelAccountId && conv.channel.id !== f.channelAccountId) return false;
  if (f.status && conv.status !== f.status) return false;
  if (f.assignee) {
    const want = f.assignee === 'me' ? viewer.id : f.assignee === 'none' ? null : f.assignee;
    if ((conv.assignedUser?.id ?? null) !== want) return false;
  }
  if (f.unread && conv.unreadCount <= 0) return false;
  return true;
}

// ---------- Tiện ích phân trang ----------

/**
 * Chia lại danh sách phẳng vào các trang, giữ số trang (để pageParams khớp) và kích thước cũ;
 * phần chênh lệch dồn vào trang `deltaIndex`.
 */
function redistribute<T>(items: T[], sizes: number[], deltaIndex: number): T[][] {
  const total = sizes.reduce((a, b) => a + b, 0);
  const adjusted = [...sizes];
  adjusted[deltaIndex] = Math.max(0, (adjusted[deltaIndex] ?? 0) + items.length - total);
  const out: T[][] = [];
  let pos = 0;
  adjusted.forEach((size, i) => {
    const take = i === adjusted.length - 1 ? items.length - pos : size;
    out.push(items.slice(pos, pos + take));
    pos += take;
  });
  return out;
}

// ---------- Tin nhắn (pages[0] = trang mới nhất; mỗi trang tăng dần theo thời gian) ----------

/** Danh sách tin theo thứ tự hiển thị (cũ → mới). */
export function flattenMessages(data: MessagesData | undefined): ChatMessage[] {
  if (!data) return [];
  return [...data.pages].reverse().flatMap((p) => p.items);
}

function compareMessages(a: ChatMessage, b: ChatMessage): number {
  // Tin lạc quan (chưa có giờ máy chủ) luôn nằm cuối.
  const ta = isTempMessage(a);
  const tb = isTempMessage(b);
  if (ta !== tb) return ta ? 1 : -1;
  const d = Date.parse(a.sentAt) - Date.parse(b.sentAt);
  if (d !== 0) return d;
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

/** Trạng thái tin chỉ tiến: queued → sent/failed → delivered → seen. */
const STATUS_RANK: Record<MessageStatus, number> = {
  received: 0,
  queued: 0,
  sent: 1,
  failed: 1,
  delivered: 2,
  seen: 3,
};

/**
 * Hai bản của cùng một tin từ hai nguồn (socket, phản hồi POST, lần tải lại) có thể tới lệch thứ tự:
 * lấy bản mới tới nhưng KHÔNG lùi trạng thái (giữ status/error của bản cũ nếu bản cũ đã tiến xa hơn).
 */
function mergeMessage(existing: ChatMessage, incoming: ChatMessage): ChatMessage {
  if (STATUS_RANK[existing.status] <= STATUS_RANK[incoming.status]) return incoming;
  return { ...incoming, status: existing.status, error: existing.error };
}

function rebuildMessages(data: MessagesData, flat: ChatMessage[]): MessagesData {
  // Thứ tự trang ngược với thứ tự hiển thị: đảo lại để chia rồi đảo về.
  const sizesDisplay = [...data.pages].reverse().map((p) => p.items.length);
  const chunks = redistribute(flat, sizesDisplay, sizesDisplay.length - 1).reverse();
  return {
    ...data,
    pages: data.pages.map((page, i) => ({ ...page, items: chunks[i] ?? [] })),
  };
}

/**
 * Chèn hoặc thay tin. Chống trùng theo `id`; tin lạc quan (id tạm) được thay bằng tin thật có cùng `clientId`.
 */
export function upsertMessage(data: MessagesData | undefined, msg: ChatMessage): MessagesData | undefined {
  if (!data) return data;
  const flat = flattenMessages(data);
  let replaced = false;
  const next: ChatMessage[] = [];
  for (const m of flat) {
    const sameId = m.id === msg.id;
    const sameClient =
      !!msg.clientId && !isTempMessage(msg) && isTempMessage(m) && m.clientId === msg.clientId;
    if (sameId || sameClient) {
      if (!replaced) {
        next.push(sameId ? mergeMessage(m, msg) : msg);
        replaced = true;
      }
      continue;
    }
    next.push(m);
  }
  if (!replaced) next.push(msg);
  next.sort(compareMessages);
  return rebuildMessages(data, next);
}

/** Cập nhật tin đã có (message.updated). Không có trong cache thì bỏ qua. */
export function updateExistingMessage(
  data: MessagesData | undefined,
  msg: MessageDto,
): MessagesData | undefined {
  if (!data) return data;
  const flat = flattenMessages(data);
  if (!flat.some((m) => m.id === msg.id)) return data;
  return upsertMessage(data, msg);
}

/**
 * Thay tin lạc quan bằng các tin thật trả về từ POST (có thể nhiều tin khi tách nội dung dài).
 * Bản POST luôn là `queued`; nếu socket đã đưa tin vào và worker đã cập nhật (sent/failed) trước khi
 * phản hồi POST tới thì giữ trạng thái mới đó.
 */
export function resolveOptimistic(
  data: MessagesData | undefined,
  clientId: string,
  messages: MessageDto[],
): MessagesData | undefined {
  if (!data) return data;
  const all = flattenMessages(data);
  const cached = new Map(all.filter((m) => !isTempMessage(m)).map((m) => [m.id, m]));
  const realIds = new Set(messages.map((m) => m.id));
  const rest = all.filter((m) => !(isTempMessage(m) && m.clientId === clientId) && !realIds.has(m.id));
  const resolved = messages.map((m) => {
    const existing = cached.get(m.id);
    return existing ? mergeMessage(existing, m) : m;
  });
  return rebuildMessages(data, [...rest, ...resolved].sort(compareMessages));
}

// ---------- Gộp kết quả tải lại với cache ----------

/** Các trang vừa tải từ máy chủ (để phân biệt kết quả fetch với cập nhật thủ công qua setQueryData). */
const fetchedPages = new WeakSet<object>();

/** Đánh dấu một trang tin vừa tải từ máy chủ (gọi trong queryFn). */
export function markFetchedPage<T extends object>(page: T): T {
  fetchedPages.add(page);
  return page;
}

/**
 * `structuralSharing` của query tin nhắn: khi một lần tải (lần đầu xong rồi tải lại, reconnect, làm mới
 * URL ký, tải trang cũ hơn) ghi đè cache, giữ lại những gì cache biết mà bản chụp của máy chủ chưa có:
 * - tin lạc quan (đang gửi / lỗi chờ "Gửi lại");
 * - tin tới qua socket TRONG LÚC đang tải (bản chụp đã chụp trước đó) — tin không bị xóa ở 1A nên tin
 *   có trong cache, nằm trong khoảng thời gian đã tải mà thiếu ở bản chụp chắc chắn là tin mới hơn;
 * - trạng thái đã tiến xa hơn (message.updated tới trong lúc tải).
 * Cập nhật thủ công (setQueryData) đi qua đây nguyên vẹn: chỉ gộp khi dữ liệu mới chứa trang vừa tải.
 */
export function mergeFetchedMessages(prev: unknown, next: unknown): unknown {
  const old = prev as MessagesData | undefined;
  const fresh = next as MessagesData | undefined;
  if (!old || !fresh || old === fresh || !fresh.pages.some((p) => fetchedPages.has(p))) return next;

  const fetched = flattenMessages(fresh);
  const fetchedIds = new Set(fetched.map((m) => m.id));
  const cached = new Map(flattenMessages(old).map((m) => [m.id, m]));
  const oldest = fetched.find((m) => !isTempMessage(m));
  const reachedStart = fresh.pages[fresh.pages.length - 1]?.nextCursor == null;

  const merged = fetched.map((m) => {
    const existing = cached.get(m.id);
    return existing ? mergeMessage(existing, m) : m;
  });
  for (const m of cached.values()) {
    if (fetchedIds.has(m.id)) continue;
    // Tin cũ hơn phần vừa tải (khi còn trang trước) thuộc trang chưa tải: bỏ, sẽ có khi tải trang đó.
    if (isTempMessage(m) || reachedStart || !oldest || compareMessages(m, oldest) >= 0) merged.push(m);
  }
  merged.sort(compareMessages);
  return replaceEqualDeep(old, rebuildMessages(fresh, merged));
}

/** Sửa tin lạc quan (đánh dấu lỗi, gửi lại...). */
export function patchTempMessage(
  data: MessagesData | undefined,
  clientId: string,
  patch: Partial<ChatMessage>,
): MessagesData | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((m) => (isTempMessage(m) && m.clientId === clientId ? { ...m, ...patch } : m)),
    })),
  };
}

export function removeTempMessage(
  data: MessagesData | undefined,
  clientId: string,
): MessagesData | undefined {
  if (!data) return data;
  return rebuildMessages(
    data,
    flattenMessages(data).filter((m) => !(isTempMessage(m) && m.clientId === clientId)),
  );
}

// ---------- Danh sách hội thoại (mới nhất trước) ----------

function lastActivity(c: ConversationSummary): number {
  return c.lastMessageAt ? Date.parse(c.lastMessageAt) : Number.NEGATIVE_INFINITY;
}

function compareConversations(a: ConversationSummary, b: ConversationSummary): number {
  const d = lastActivity(b) - lastActivity(a);
  if (d !== 0) return d;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Áp một hội thoại vừa thay đổi vào một danh sách đã tải:
 * - không còn quyền xem hoặc không còn khớp bộ lọc → xóa (riêng bộ lọc "Chưa đọc": giữ lại tin vừa đọc
 *   tới lần tải lại để dòng không biến mất ngay khi đang xem);
 * - đã có → cập nhật và sắp lại theo tin cuối;
 * - chưa có và khớp → chèn đúng vị trí (bỏ qua nếu nằm sau phần đã tải và còn trang sau).
 */
export function applyConversationToList(
  data: ConversationsData | undefined,
  conv: ConversationSummary,
  filters: ConversationFilters,
  viewer: Viewer,
): ConversationsData | undefined {
  if (!data) return data;
  const flat = data.pages.flatMap((p) => p.items);
  const existing = flat.some((c) => c.id === conv.id);
  const rest = flat.filter((c) => c.id !== conv.id);

  const visible = canView(conv, viewer);
  const matches = matchesFilters(conv, filters, viewer);
  const stickyUnread =
    existing && filters.unread && matchesFilters(conv, { ...filters, unread: false }, viewer);
  const keep = visible && (matches || stickyUnread);

  if (!keep) {
    if (!existing) return data;
    return rebuildConversations(data, rest);
  }

  if (!existing) {
    const last = rest[rest.length - 1];
    const hasMore = data.pages[data.pages.length - 1]?.nextCursor != null;
    if (hasMore && last && compareConversations(conv, last) > 0) return data;
  }
  const next = [...rest, conv].sort(compareConversations);
  return rebuildConversations(data, next);
}

/**
 * Áp nhiều hội thoại một lần (vd. đồng bộ lịch sử phát hàng trăm `conversation.updated` liên tiếp):
 * cùng quy tắc với `applyConversationToList` nhưng chỉ tạo một bản dữ liệu mới → một lần render.
 */
export function applyConversationsToList(
  data: ConversationsData | undefined,
  convs: readonly ConversationSummary[],
  filters: ConversationFilters,
  viewer: Viewer,
): ConversationsData | undefined {
  return convs.reduce((acc, conv) => applyConversationToList(acc, conv, filters, viewer), data);
}

function rebuildConversations(data: ConversationsData, flat: ConversationSummary[]): ConversationsData {
  const chunks = redistribute(
    flat,
    data.pages.map((p) => p.items.length),
    0,
  );
  return { ...data, pages: data.pages.map((page, i) => ({ ...page, items: chunks[i] ?? [] })) };
}

/** Sửa tại chỗ các hội thoại thỏa điều kiện (vd. đổi tên khách, đánh dấu đã đọc). */
export function patchConversationsInList(
  data: ConversationsData | undefined,
  predicate: (c: ConversationSummary) => boolean,
  patch: (c: ConversationSummary) => ConversationSummary,
): ConversationsData | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((c) => (predicate(c) ? patch(c) : c)),
    })),
  };
}

/** Gộp bản tóm tắt mới vào chi tiết hội thoại đã tải (giữ contactDetail). */
export function mergeSummaryIntoDetail(
  detail: ConversationDetail | undefined,
  conv: ConversationSummary,
): ConversationDetail | undefined {
  if (!detail || detail.id !== conv.id) return detail;
  return {
    ...detail,
    ...conv,
    contactDetail: {
      ...detail.contactDetail,
      displayName: conv.contact.displayName,
      avatarUrl: conv.contact.avatarUrl,
    },
  };
}
