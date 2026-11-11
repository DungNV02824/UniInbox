// Logic thuần của bộ lọc danh sách hội thoại (menu kênh, tab nhanh, đếm bộ lọc trong popover).
import type { ChannelAccountDto, ChannelAccountStatus, ChannelType } from '@dezon/shared';
import type { ConversationFilters } from '@/lib/inbox-api';
import { PLATFORM_LABELS } from '@/lib/channel-groups';

const TYPE_ORDER: ChannelType[] = ['messenger', 'zalo_oa', 'zalo_personal'];

/** Hậu tố cho kênh không còn hoạt động (hiện mờ, xếp sau kênh đang kết nối). */
export const INACTIVE_CHANNEL_SUFFIX: Record<Exclude<ChannelAccountStatus, 'connected'>, string> = {
  disconnected: '(đã ngắt)',
  expired: '(hết hạn)',
  error: '(lỗi)',
};

export type ChannelFilterChannel = Pick<
  ChannelAccountDto,
  'id' | 'type' | 'displayName' | 'color' | 'status'
>;

export interface ChannelFilterGroup {
  type: ChannelType;
  /** "Facebook", "Zalo OA", "Zalo cá nhân". */
  label: string;
  /** Kênh đang kết nối trước (theo tên), kênh đã ngắt/lỗi sau. */
  channels: ChannelFilterChannel[];
}

export function isChannelActive(ch: Pick<ChannelAccountDto, 'status'>): boolean {
  return ch.status === 'connected';
}

/** Tên kênh trong menu, kèm hậu tố khi kênh không hoạt động. */
export function channelOptionLabel(ch: Pick<ChannelAccountDto, 'displayName' | 'status'>): string {
  return ch.status === 'connected'
    ? ch.displayName
    : `${ch.displayName} ${INACTIVE_CHANNEL_SUFFIX[ch.status]}`;
}

/** Nhóm kênh theo nền tảng cho menu "Tất cả kênh". */
export function groupChannelsForFilter(channels: readonly ChannelFilterChannel[]): ChannelFilterGroup[] {
  const byType = new Map<ChannelType, ChannelFilterChannel[]>();
  for (const ch of channels) {
    const list = byType.get(ch.type) ?? [];
    list.push(ch);
    byType.set(ch.type, list);
  }
  return [...byType.entries()]
    .sort(([a], [b]) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b))
    .map(([type, list]) => ({
      type,
      label: PLATFORM_LABELS[type],
      channels: [...list].sort((a, b) => {
        const active = Number(isChannelActive(b)) - Number(isChannelActive(a));
        return active || a.displayName.localeCompare(b.displayName, 'vi');
      }),
    }));
}

/** Một mục chọn được trong menu kênh (thứ tự = thứ tự điều hướng bằng phím). */
export type ChannelFilterOption =
  | { kind: 'all'; key: 'all' }
  | { kind: 'type'; key: string; type: ChannelType; label: string; count: number }
  | { kind: 'account'; key: string; channel: ChannelFilterChannel };

export function channelFilterOptions(groups: readonly ChannelFilterGroup[]): ChannelFilterOption[] {
  const out: ChannelFilterOption[] = [{ kind: 'all', key: 'all' }];
  for (const g of groups) {
    out.push({ kind: 'type', key: `type:${g.type}`, type: g.type, label: g.label, count: g.channels.length });
    for (const ch of g.channels) out.push({ kind: 'account', key: `acc:${ch.id}`, channel: ch });
  }
  return out;
}

/** Chỉ các Trang/tài khoản (không có "Tất cả kênh" / "Tất cả Facebook"): hộp thư luôn xem một kênh. */
export function channelAccountOptions(groups: readonly ChannelFilterGroup[]): ChannelFilterOption[] {
  return groups.flatMap((g) =>
    g.channels.map((channel) => ({ kind: 'account' as const, key: `acc:${channel.id}`, channel })),
  );
}

/** Khóa localStorage lưu kênh nhân viên đã chọn (vào lại vẫn giữ kênh đó). */
export const INBOX_CHANNEL_STORAGE_KEY = 'dezon.inbox.channelAccountId';

/**
 * Kênh mở mặc định: kênh đã lưu nếu vẫn còn trong danh sách, không thì kênh đầu tiên trong menu
 * (ưu tiên kênh đang kết nối). undefined = chưa có kênh nào.
 */
export function defaultChannelId(
  channels: readonly ChannelFilterChannel[],
  storedId: string | null | undefined,
): string | undefined {
  if (storedId && channels.some((c) => c.id === storedId)) return storedId;
  const flat = groupChannelsForFilter(channels).flatMap((g) => g.channels);
  return (flat.find(isChannelActive) ?? flat[0])?.id;
}

/** Khóa của mục đang chọn ứng với bộ lọc hiện tại. */
export function selectedChannelKey(filters: Pick<ConversationFilters, 'channelType' | 'channelAccountId'>) {
  if (filters.channelAccountId) return `acc:${filters.channelAccountId}`;
  if (filters.channelType) return `type:${filters.channelType}`;
  return 'all';
}

/** Bộ lọc kênh khi chọn một mục (luôn đặt cả hai khóa để mục cũ bị xóa). */
export function channelFilterFor(
  option: ChannelFilterOption,
): Pick<ConversationFilters, 'channelType' | 'channelAccountId'> {
  if (option.kind === 'type') return { channelType: option.type, channelAccountId: undefined };
  if (option.kind === 'account') return { channelType: undefined, channelAccountId: option.channel.id };
  return { channelType: undefined, channelAccountId: undefined };
}

// ---------- Tab nhanh + popover "Bộ lọc" ----------

export type QuickTab = 'all' | 'unread' | 'mine';

export const QUICK_TABS: { value: QuickTab; label: string }[] = [
  { value: 'all', label: 'Tất cả' },
  { value: 'unread', label: 'Chưa đọc' },
  { value: 'mine', label: 'Của tôi' },
];

/**
 * Tab đang sáng: "Chưa đọc" ưu tiên, rồi "Của tôi" (= người phụ trách là tôi).
 * "Tất cả" chỉ sáng khi không lọc người phụ trách; đang lọc "Chưa phân công"/một nhân viên
 * (trong popover) thì không tab nào sáng, để "Tất cả" không nói sai.
 */
export function activeQuickTab(filters: Pick<ConversationFilters, 'unread' | 'assignee'>): QuickTab | null {
  if (filters.unread) return 'unread';
  if (filters.assignee === 'me') return 'mine';
  if (!filters.assignee) return 'all';
  return null;
}

/**
 * Chọn tab: các tab loại trừ nhau nên bỏ "của tôi" khi sang tab khác.
 * "Tất cả" bỏ luôn lọc người phụ trách để đúng nghĩa tất cả (trạng thái + kênh giữ nguyên).
 */
export function applyQuickTab(filters: ConversationFilters, tab: QuickTab): ConversationFilters {
  const assignee = filters.assignee === 'me' ? undefined : filters.assignee;
  if (tab === 'mine') return { ...filters, unread: undefined, assignee: 'me' };
  if (tab === 'unread') return { ...filters, unread: true, assignee };
  return { ...filters, unread: undefined, assignee: undefined };
}

/** Số bộ lọc đang bật trong popover (không tính phần tab "Của tôi" đã hiển thị). */
export function countPopoverFilters(
  filters: Pick<ConversationFilters, 'status' | 'assignee' | 'unread' | 'aiState' | 'tag'>,
) {
  let n = 0;
  if (filters.tag) n += 1;
  if (filters.status) n += 1;
  if (filters.assignee && activeQuickTab(filters) !== 'mine') n += 1;
  if (filters.aiState) n += 1;
  return n;
}

/** "Xóa bộ lọc" trong popover: bỏ trạng thái + người phụ trách + lọc AI + nhãn, giữ kênh và "Chưa đọc". */
export function clearPopoverFilters(filters: ConversationFilters): ConversationFilters {
  return { ...filters, status: undefined, assignee: undefined, aiState: undefined, tag: undefined };
}

/** Bấm một nhãn trong bộ lọc: chọn nhãn đó; bấm lại nhãn đang chọn thì bỏ lọc nhãn. */
export function toggleTagFilter(filters: ConversationFilters, tag: string | undefined): ConversationFilters {
  if (!tag) return { ...filters, tag: undefined };
  const same = filters.tag?.toLowerCase() === tag.toLowerCase();
  return { ...filters, tag: same ? undefined : tag };
}

// ---------- Lọc "Cần người" / "AI đang lo" ----------

export type AiQuickFilter = 'all' | 'needs_human' | 'ai_handled';

/** Mục đang chọn trong nhóm "Chatbot AI" của popover. */
export function activeAiFilter(filters: Pick<ConversationFilters, 'status' | 'aiState'>): AiQuickFilter {
  if (filters.status === 'pending_human') return 'needs_human';
  if (filters.aiState === 'handled') return 'ai_handled';
  return 'all';
}

/**
 * Chọn "Cần người" (= trạng thái pending_human) hoặc "AI đang lo" (= có bot, ai_mode auto). Hai lựa chọn
 * loại trừ nhau (hội thoại chờ người đã tắt AI); bỏ chọn thì chỉ gỡ phần do nhóm này đặt.
 */
export function applyAiFilter(filters: ConversationFilters, choice: AiQuickFilter): ConversationFilters {
  const status = filters.status === 'pending_human' ? undefined : filters.status;
  if (choice === 'needs_human') return { ...filters, status: 'pending_human', aiState: undefined };
  if (choice === 'ai_handled') return { ...filters, status, aiState: 'handled' };
  return { ...filters, status, aiState: undefined };
}
