// "Thu thập thông tin" (tab của bot): ghi SĐT / Nhu cầu / trường riêng AI khai thác được từ chat vào hồ sơ khách.
// Quy tắc: trường nhân viên đã tự sửa (source 'user') thì bot không ghi đè; SĐT có sẵn (phoneSource null) cũng vậy.
// Nhân viên XÓA trường cũng là "đã sửa": SĐT trống + phoneSource 'user', trường { value: '', source: 'user' } ⇒ bot
// không điền lại (không gắn lại nhãn).
// Hàm KHÔNG phát realtime: bên gọi (runtime AI) phát conversation.updated khi tagged / changedKeys khác rỗng.
import { auditLogs, contacts, type ContactProfileFieldValue } from '@dezon/db';
import { CAPTURE_LIMITS, type CaptureConfig } from '@dezon/shared';
import { eq } from 'drizzle-orm';
import { resolveCatalogTag } from '../contact-tags/service';
import type { DbLike } from '../inbox/read-model';
import { truncateCodePoints } from './profile-fields';

/** Ký tự phân cách được bỏ khi chuẩn hóa SĐT. */
const PHONE_SEPARATORS = /[\s.\-()]/g;
/** Di động VN: 03/05/07/08/09 + 8 số (10 số). */
const VN_MOBILE = /^0[35789]\d{8}$/;
/** Cố định VN: 02x, tổng 10–11 số. */
const VN_LANDLINE = /^02\d{8,9}$/;

/**
 * Chuẩn hóa SĐT Việt Nam về dạng 0xxxxxxxxx. Bỏ khoảng trắng / dấu chấm / gạch ngang / ngoặc; nhận +84… / 84… / 0….
 * Chỉ nhận di động (03/05/07/08/09, 10 số) và cố định 02x (10–11 số); còn lại ⇒ null.
 */
export function normalizeVnPhone(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.replace(PHONE_SEPARATORS, '');
  if (s === '' || s.length > CAPTURE_LIMITS.phoneMax) return null;
  if (s.startsWith('+84')) s = s.slice(3);
  else if (s.startsWith('84') && s.length >= 11) s = s.slice(2);
  else if (!s.startsWith('0')) return null;
  if (!/^\d+$/.test(s)) return null;
  if (!s.startsWith('0')) s = `0${s}`;
  return VN_MOBILE.test(s) || VN_LANDLINE.test(s) ? s : null;
}

/**
 * Ứng viên SĐT trong văn bản: +84 / 84 (liền số) / 0 rồi 9–10 chữ số, giữa các số có thể có tối đa 2 ký tự phân cách.
 * Không bắt đầu ngay sau chữ số / '+' hay sau "chữ số + . , -" (giữa một số dài hơn: "2.091.234.567.8", "84.500.000.000").
 */
const PHONE_CANDIDATE = /(?<![\d+])(?<!\d[.,-])(?:\+84|84(?=\d)|0)(?:[\s.\-()]{0,2}\d){9,10}(?!\d)/g;

/** Ngày dd.mm.yyyy / dd-mm-yyyy / dd mm yyyy ở đầu cụm số (vd. "08.12.2024 14h" ⇒ không phải SĐT). */
const DATE_PREFIX = /^(?:0?[1-9]|[12]\d|3[01])[\s.-](?:0?[1-9]|1[0-2])[\s.-](?:19|20)\d{2}(?!\d)/;

/**
 * Cụm số trông như SĐT: không bắt đầu bằng ngày tháng năm, và phần số chỉ dùng một kiểu phân cách (khoảng trắng /
 * '.' / '-') — "08-12-2024 15:30" trộn '-' với khoảng trắng ⇒ không nhận. Không tính phân cách sau "+84" và sau
 * ngoặc mã vùng ("+84 98.765.4321", "(+84) 912-345-678", "(028) 3823 4567" vẫn nhận).
 */
function phoneShaped(candidate: string): boolean {
  const body = candidate
    .replace(/^\+84[\s.\-()]*/, '')
    .replace(/\)\s*/g, '')
    .replace(/\(/g, '');
  if (DATE_PREFIX.test(body)) return false;
  const kinds = new Set(Array.from(body.matchAll(/[\s.-]/g), (m) => (/\s/.test(m[0]) ? ' ' : m[0])));
  return kinds.size <= 1;
}

/**
 * Tìm SĐT Việt Nam trong văn bản (dự phòng khi AI không trả trường phone): đã chuẩn hóa (normalizeVnPhone), bỏ trùng,
 * theo thứ tự xuất hiện. Cụm số dính số khác phía sau (vd. "0912 345 678 5") ⇒ thử bỏ dần nhóm số cuối.
 */
export function extractVnPhones(text: string): string[] {
  if (typeof text !== 'string' || text === '') return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(PHONE_CANDIDATE)) {
    const candidate = match[0];
    // Vị trí kết thúc của từng nhóm số (dài nhất trước).
    const ends: number[] = [];
    for (let i = 0; i < candidate.length; i++) {
      if (/\d/.test(candidate[i]!) && !/\d/.test(candidate[i + 1] ?? '')) ends.push(i + 1);
    }
    for (const end of ends.reverse()) {
      const slice = candidate.slice(0, end);
      if (!phoneShaped(slice)) continue;
      const phone = normalizeVnPhone(slice);
      if (phone) {
        if (!seen.has(phone)) {
          seen.add(phone);
          out.push(phone);
        }
        break;
      }
    }
  }
  return out;
}

/** Từ (chữ thường) được phép đứng quanh số trong tin "chỉ để cho SĐT" (dự phòng regex, xem fallbackPhoneFromTexts). */
const SELF_PHONE_WORDS = new Set([
  'số',
  'sđt',
  'sdt',
  'đt',
  'dt',
  'điện',
  'thoại',
  'zalo',
  'của',
  'em',
  'mình',
  'tôi',
  'tớ',
  'tui',
  'anh',
  'chị',
  'cháu',
  'con',
  'là',
  'đây',
  'nè',
  'nhé',
  'nha',
  'nhá',
  'nhe',
  'ạ',
  'à',
  'a',
  'dạ',
  'vâng',
  'ok',
  'oke',
  'liên',
  'hệ',
  'qua',
  'với',
]);

/**
 * SĐT dự phòng (khi model không điền `captured`): tin khách CUỐI CÙNG có đúng MỘT SĐT và ngoài số gần như chỉ có các
 * từ tự giới thiệu (SELF_PHONE_WORDS, cho phép thêm tối đa 1 từ khác: "Số em là 0912 345 678 ạ", "À nhầm, số em là
 * 0912…", "0912345678"). Tin kể chuyện quanh số ("shipper gọi em số … mà em không nghe được", "anh liên hệ chị Lan
 * 0912… giúp em") ⇒ không lấy. Không có ⇒ null.
 */
export function fallbackPhoneFromTexts(texts: readonly (string | null | undefined)[]): string | null {
  for (let i = texts.length - 1; i >= 0; i--) {
    const text = texts[i];
    if (typeof text !== 'string' || text === '') continue;
    const phones = extractVnPhones(text);
    if (phones.length !== 1) continue;
    const words =
      text
        .replace(PHONE_CANDIDATE, ' ')
        .toLocaleLowerCase('vi')
        .match(/[\p{L}\p{N}]+/gu) ?? [];
    if (words.filter((w) => !SELF_PHONE_WORDS.has(w)).length <= 1) return phones[0]!;
  }
  return null;
}

export interface ApplyCapturedFieldsInput {
  contactId: string;
  /** Cấu hình "Thu thập thông tin" của bot (đã parse; tắt ⇒ không ghi gì). */
  config: CaptureConfig;
  /**
   * phone: chuỗi thô (được chuẩn hóa ở đây; không hợp lệ ⇒ bỏ qua). phoneGuessed: SĐT do dự phòng regex đoán (model
   * không điền) ⇒ chỉ điền khi khách CHƯA có SĐT, không gắn nhãn. fields: khóa ⇒ giá trị AI điền (không gồm phone).
   */
  captured: { phone?: string | null; phoneGuessed?: boolean; fields: Record<string, string> };
  now: Date;
}

export interface ApplyCapturedFieldsResult {
  /** Khóa đã ghi ('phone' và/hoặc khóa trường). */
  changedKeys: string[];
  /** SĐT từ trống ⇒ có trong lần này. */
  phoneCaptured: boolean;
  /** Nhãn vừa gắn (cách viết của danh sách nhãn); null = không gắn mới. */
  tagged: string | null;
}

/**
 * Ghi thông tin bot thu thập vào hồ sơ khách, trong transaction `tx` của bên gọi (khóa dòng contacts FOR UPDATE).
 * - SĐT: chỉ khi trường phone bật, giá trị hợp lệ (normalizeVnPhone), phoneSource khác 'user' (kể cả SĐT trống —
 *   nhân viên đã xóa), khách chưa có SĐT hoặc SĐT do bot điền (phoneSource 'ai'; SĐT đoán ⇒ chỉ khi chưa có), và khác
 *   giá trị đang lưu ⇒ phone + phoneSource 'ai'.
 * - Trường khác: chỉ khóa của trường đang bật trong config (trừ phone); giá trị trim, cắt CAPTURE_LIMITS.valueMax ký
 *   tự, bỏ rỗng; ghi khi chưa có hoặc đang là của bot (source 'ai') và khác giá trị cũ (mục source 'user' — kể cả
 *   value rỗng do nhân viên xóa — không ghi). Nhãn = nhãn trong config.
 * - SĐT vừa có (trống ⇒ có, không phải SĐT đoán) và config.phoneTag là nhãn trong danh sách nhãn ⇒ gắn nhãn (nếu
 *   khách chưa có).
 * Có thay đổi ⇒ cập nhật contacts.updated_at và audit 'contact.capture' { keys, tagged } (KHÔNG ghi giá trị).
 */
export async function applyCapturedFields(
  tx: DbLike,
  { contactId, config, captured, now }: ApplyCapturedFieldsInput,
): Promise<ApplyCapturedFieldsResult> {
  const none: ApplyCapturedFieldsResult = { changedKeys: [], phoneCaptured: false, tagged: null };
  if (!config.enabled) return none;
  const [contact] = await tx
    .select({
      phone: contacts.phone,
      phoneSource: contacts.phoneSource,
      profileFields: contacts.profileFields,
      tags: contacts.tags,
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .for('update');
  if (!contact) return none;

  const enabled = new Map(config.fields.filter((f) => f.enabled).map((f) => [f.key, f]));
  const set: Partial<typeof contacts.$inferInsert> = {};
  const changedKeys: string[] = [];

  // SĐT
  let phoneCaptured = false;
  const phone = enabled.has('phone') ? normalizeVnPhone(captured.phone) : null;
  const hadPhone = (contact.phone ?? '').trim() !== '';
  const guessed = captured.phoneGuessed === true;
  const writable =
    contact.phoneSource !== 'user' && (!hadPhone || (contact.phoneSource === 'ai' && !guessed));
  if (phone && writable && phone !== contact.phone) {
    set.phone = phone;
    set.phoneSource = 'ai';
    changedKeys.push('phone');
    phoneCaptured = !hadPhone;
  }

  // Trường khác
  const current: Record<string, ContactProfileFieldValue> =
    contact.profileFields && typeof contact.profileFields === 'object' ? contact.profileFields : {};
  const nextFields: Record<string, ContactProfileFieldValue> = { ...current };
  for (const [key, raw] of Object.entries(captured.fields ?? {})) {
    const field = enabled.get(key);
    if (!field || key === 'phone' || typeof raw !== 'string') continue;
    const value = truncateCodePoints(raw.trim(), CAPTURE_LIMITS.valueMax).trim();
    if (value === '') continue;
    // Object.hasOwn: khóa trùng thuộc tính kế thừa của Object ('constructor') không bị coi là đã có.
    const existing = Object.hasOwn(current, key) ? current[key] : undefined;
    if (existing && (existing.source !== 'ai' || existing.value === value)) continue;
    nextFields[key] = { label: field.label, value, source: 'ai', updatedAt: now.toISOString() };
    changedKeys.push(key);
  }
  if (changedKeys.some((k) => k !== 'phone')) set.profileFields = nextFields;

  // Nhãn khi vừa có SĐT
  let tagged: string | null = null;
  if (phoneCaptured && !guessed && config.phoneTag) {
    const name = await resolveCatalogTag(tx, config.phoneTag);
    const has =
      name !== null && contact.tags.some((t) => t.trim().toLowerCase() === name.trim().toLowerCase());
    if (name !== null && !has) {
      set.tags = [...contact.tags, name];
      tagged = name;
    }
  }

  if (changedKeys.length === 0 && tagged === null) return none;
  await tx
    .update(contacts)
    .set({ ...set, updatedAt: now })
    .where(eq(contacts.id, contactId));
  await tx.insert(auditLogs).values({
    userId: null,
    action: 'contact.capture',
    entity: 'contact',
    entityId: contactId,
    data: { keys: changedKeys, tagged: tagged !== null },
  });
  return { changedKeys, phoneCaptured, tagged };
}
