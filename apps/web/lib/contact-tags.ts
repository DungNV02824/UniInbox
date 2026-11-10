// Hàm thuần cho danh sách nhãn khách: tra cứu, tìm kiếm, sắp xếp, kiểm tra tên.
import { CONTACT_TAG_NAME_MAX, type ContactTagDto } from '@dezon/shared';

export const TAG_NAME_MAX = CONTACT_TAG_NAME_MAX;

/** Khóa so trùng: NFC, gộp khoảng trắng, không phân biệt hoa thường (giống cách server chuẩn hóa). */
export function tagKey(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('vi');
}

/** Khóa tìm kiếm: như tagKey nhưng bỏ dấu tiếng Việt (gõ "khach vip" vẫn ra "Khách VIP"). */
export function foldTag(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Thứ tự hiển thị: sortOrder rồi tên. */
export function sortTags(list: readonly ContactTagDto[]): ContactTagDto[] {
  return [...list].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'vi'));
}

export type TagIndex = ReadonlyMap<string, ContactTagDto>;

export function buildTagIndex(catalog: readonly ContactTagDto[]): TagIndex {
  const map = new Map<string, ContactTagDto>();
  for (const tag of catalog) if (!map.has(tagKey(tag.name))) map.set(tagKey(tag.name), tag);
  return map;
}

/** Tìm nhãn trong danh sách theo tên (không phân biệt hoa thường); undefined = nhãn cũ/ngoài danh sách. */
export function findCatalogTag(index: TagIndex, name: string): ContactTagDto | undefined {
  return index.get(tagKey(name));
}

/**
 * Lọc nhãn cho ô chọn: bỏ dấu khi so, loại nhãn khách đã có; nhãn bắt đầu bằng chuỗi gõ lên trước,
 * còn lại giữ thứ tự danh sách.
 */
export function searchCatalog(
  catalog: readonly ContactTagDto[],
  query: string,
  assigned: readonly string[],
): ContactTagDto[] {
  const taken = new Set(assigned.map(tagKey));
  const q = foldTag(query);
  const available = sortTags(catalog).filter((t) => !taken.has(tagKey(t.name)));
  if (!q) return available;
  const prefix: ContactTagDto[] = [];
  const contains: ContactTagDto[] = [];
  for (const tag of available) {
    const f = foldTag(tag.name);
    if (f.startsWith(q)) prefix.push(tag);
    else if (f.includes(q)) contains.push(tag);
  }
  return [...prefix, ...contains];
}

export type TagOption =
  { kind: 'tag'; tag: ContactTagDto } | { kind: 'create'; name: string } | { kind: 'hint'; text: string };

export const NOT_IN_CATALOG_HINT = 'Chưa có nhãn này — nhờ quản trị viên tạo';

/**
 * Các mục của ô chọn nhãn. Gõ một tên chưa có trong danh sách (so đúng chữ, không phân biệt hoa thường):
 * admin thấy "+ Tạo nhãn", nhân viên thấy lời nhắc (không chọn được).
 */
export function buildTagOptions(
  catalog: readonly ContactTagDto[],
  query: string,
  assigned: readonly string[],
  isAdmin: boolean,
): TagOption[] {
  const options: TagOption[] = searchCatalog(catalog, query, assigned).map((tag) => ({ kind: 'tag', tag }));
  const name = query.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!name || name.length > TAG_NAME_MAX) return options;
  const key = tagKey(name);
  if (catalog.some((t) => tagKey(t.name) === key) || assigned.some((t) => tagKey(t) === key)) return options;
  options.push(isAdmin ? { kind: 'create', name } : { kind: 'hint', text: NOT_IN_CATALOG_HINT });
  return options;
}

/** Mục chọn được (bỏ lời nhắc). */
export function isSelectableOption(option: TagOption | undefined): boolean {
  return !!option && option.kind !== 'hint';
}

/** ↑/↓ trong ô chọn: bỏ qua mục không chọn được, quay vòng; -1 khi không có mục nào chọn được. */
export function moveActiveIndex(options: readonly TagOption[], current: number, delta: 1 | -1): number {
  const n = options.length;
  if (n === 0) return -1;
  for (let step = 1; step <= n; step++) {
    const i = ((((current < 0 && delta < 0 ? 0 : current) + delta * step) % n) + n) % n;
    if (isSelectableOption(options[i])) return i;
  }
  return -1;
}

export function firstSelectableIndex(options: readonly TagOption[]): number {
  return options.findIndex(isSelectableOption);
}

/** Đổi chỗ phần tử `index` lên (-1) / xuống (+1); ngoài biên thì trả bản sao không đổi. */
export function moveItem<T>(list: readonly T[], index: number, delta: number): T[] {
  const next = [...list];
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return next;
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** Áp thứ tự id mới lên danh sách (sortOrder = vị trí); id lạ bị bỏ, nhãn thiếu trong `ids` xếp cuối. */
export function applyTagOrder(list: readonly ContactTagDto[], ids: readonly string[]): ContactTagDto[] {
  const byId = new Map(list.map((t) => [t.id, t]));
  const ordered = ids.map((id) => byId.get(id)).filter((t): t is ContactTagDto => !!t);
  const seen = new Set(ordered.map((t) => t.id));
  const rest = sortTags(list.filter((t) => !seen.has(t.id)));
  return [...ordered, ...rest].map((t, i) => ({ ...t, sortOrder: i }));
}

/** Kiểm tra tên nhãn trước khi gửi; null = hợp lệ. `exceptId` = nhãn đang đổi tên. */
export function validateTagName(
  name: string,
  catalog: readonly ContactTagDto[],
  exceptId?: string,
): string | null {
  const clean = name.trim();
  if (!clean) return 'Nhập tên nhãn.';
  if (clean.length > TAG_NAME_MAX) return `Tên nhãn tối đa ${TAG_NAME_MAX} ký tự.`;
  const key = tagKey(clean);
  if (catalog.some((t) => t.id !== exceptId && tagKey(t.name) === key)) return 'Đã có nhãn này';
  return null;
}

/** "12 khách" / "Chưa gắn cho khách nào". */
export function tagUsageText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return 'Chưa gắn cho khách nào';
  return `${new Intl.NumberFormat('vi-VN').format(Math.floor(count))} khách`;
}

/** Nhãn của khách trên bản tóm tắt (an toàn khi máy chủ cũ chưa gửi `tags`): bỏ trùng, bỏ rỗng, giữ thứ tự. */
export function contactTagsOf(contact: { tags?: readonly string[] | null } | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of contact?.tags ?? []) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    const key = tagKey(name);
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** Chia nhãn để hiển thị gọn: `max` nhãn đầu + số còn lại ("+N"). */
export function splitVisibleTags(
  tags: readonly string[],
  max: number,
): { visible: string[]; hidden: string[]; overflow: number } {
  const n = Math.max(0, Math.floor(max));
  const visible = tags.slice(0, n);
  const hidden = tags.slice(n);
  return { visible, hidden, overflow: hidden.length };
}
