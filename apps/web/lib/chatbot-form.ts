// Trình soạn chatbot: chuyển đổi form ↔ DTO, kiểm tra hợp lệ, lỗi API → lỗi từng ô. Hàm thuần để test.
import {
  AGENT_REPLY_MODES,
  CHATBOT_DEFAULTS,
  CHATBOT_LIMITS,
  createChatbotSchema,
  RESPONSE_SPEEDS,
  type AgentReplyMode,
  type ChatbotDto,
  type CreateChatbotRequest,
  type ResponseSpeed,
} from '@dezon/shared';
import { ApiError } from '@/lib/api';

export interface ExampleRow {
  /** Khóa ổn định cho React (không gửi lên API). */
  key: string;
  customer: string;
  reply: string;
}

/** Giá trị form. Ô số giữ dạng chuỗi để người dùng xóa/gõ lại thoải mái. */
export interface ChatbotFormValues {
  name: string;
  description: string;
  isActive: boolean;
  instructions: string;
  knowledge: string;
  examples: ExampleRow[];
  /** "Báo nhân viên + DỪNG bot": khớp ⇒ chuyển sang Cần người, bot ngừng trả lời. */
  handoffKeywords: string[];
  /** "Báo nhân viên, bot VẪN trả lời": khớp ⇒ báo nhân viên (trong app + Lark), bot vẫn nhắn với khách. */
  notifyKeywords: string[];
  handoffMessage: string;
  /** Bot không chắc câu trả lời: true = chuyển người thật, false = vẫn trả lời. */
  escalateWhenUnsure: boolean;
  /** Tên nút "nhận" trên banner Cần người; '' = mặc định (DEFAULT_HANDOFF_ACK_LABEL). */
  handoffAckLabel: string;
  /** Tên nút "xong" (trả lại cho AI); '' = mặc định (DEFAULT_HANDOFF_RESOLVE_LABEL). */
  handoffResolveLabel: string;
  /** Bấm hai nút trên thì gửi thông báo Lark. */
  handoffActionLark: boolean;
  /** Tin bot gửi khách khi bấm nút "nhận"; '' = không gửi. `{ten_khach}` ⇒ tên khách. */
  handoffAckMessage: string;
  /** Tin bot gửi khách khi bấm nút "xong"; '' = không gửi. */
  handoffResolveMessage: string;
  /** "Tốc độ trả lời" = mức suy nghĩ của AI (Nhanh nhất / Cân bằng / Suy nghĩ kỹ). */
  responseSpeed: ResponseSpeed;
  /** "Khi nhân viên vào nhắn tin với khách": bot vẫn trả lời / tạm nghỉ / dừng hẳn. */
  agentReplyMode: AgentReplyMode;
  /** Số phút tạm nghỉ (mode 'pause'); '' = mặc định hệ thống (30 phút). */
  agentPauseMinutes: string;
  /** Bật "Nhắc lại khi chưa ai nhận hội thoại" (tắt ⇒ handoffReminderMin = 0). */
  handoffReminderEnabled: boolean;
  /** Số phút nhắc lại khi bật (giữ chuỗi để gõ thoải mái). */
  handoffReminderMin: string;
  /** '' = mặc định hệ thống. */
  model: string;
  temperature: number;
  replyDelaySec: string;
  maxWaitSec: string;
  maxRepliesPerHour: string;
}

/** Lỗi theo đường dẫn ô: 'name', 'examples.0.reply', 'maxWaitSec'... */
export type FormErrors = Record<string, string>;

/** Số phút nhắc lại điền sẵn khi bật "Nhắc lại khi chưa ai nhận hội thoại". */
export const DEFAULT_HANDOFF_REMINDER_MIN = 15;
/** AI_PAUSE_AFTER_AGENT_MIN mặc định của server (ô "tạm nghỉ" để trống). */
export const DEFAULT_AGENT_PAUSE_MIN = 30;

let rowSeq = 0;
export function newRowKey(): string {
  rowSeq += 1;
  return `row-${rowSeq}`;
}

/** Từ khóa chuyển người chỉ hiện dạng gợi ý để bấm thêm — bot mới KHÔNG có sẵn từ khóa nào. */
export const SUGGESTED_HANDOFF_KEYWORDS = [
  'giảm giá',
  'bớt',
  'chiết khấu',
  'khiếu nại',
  'gặp nhân viên',
  'hoàn tiền',
] as const;

/** Gợi ý cho danh sách "Báo nhân viên, bot VẪN trả lời". */
export const SUGGESTED_NOTIFY_KEYWORDS = ['gửi công trình', 'nghiệm thu', 'đã chuyển khoản'] as const;

export function emptyChatbotForm(): ChatbotFormValues {
  return {
    name: '',
    description: '',
    isActive: true,
    instructions: '',
    knowledge: '',
    examples: [],
    handoffKeywords: [],
    notifyKeywords: [],
    handoffMessage: '',
    escalateWhenUnsure: CHATBOT_DEFAULTS.escalateWhenUnsure,
    handoffAckLabel: '',
    handoffResolveLabel: '',
    handoffActionLark: CHATBOT_DEFAULTS.handoffActionLark,
    handoffAckMessage: '',
    handoffResolveMessage: '',
    responseSpeed: CHATBOT_DEFAULTS.responseSpeed,
    agentReplyMode: CHATBOT_DEFAULTS.agentReplyMode,
    agentPauseMinutes: '',
    handoffReminderEnabled: false,
    handoffReminderMin: String(DEFAULT_HANDOFF_REMINDER_MIN),
    model: '',
    temperature: CHATBOT_DEFAULTS.temperature,
    replyDelaySec: String(CHATBOT_DEFAULTS.replyDelaySec),
    maxWaitSec: String(CHATBOT_DEFAULTS.maxWaitSec),
    maxRepliesPerHour: String(CHATBOT_DEFAULTS.maxRepliesPerHour),
  };
}

export function chatbotToForm(dto: ChatbotDto): ChatbotFormValues {
  const reminder = normalizeReminderMin(dto.handoffReminderMin);
  return {
    name: dto.name,
    description: dto.description ?? '',
    isActive: dto.isActive,
    instructions: dto.instructions,
    knowledge: dto.knowledge,
    examples: dto.examples.map((e) => ({ key: newRowKey(), customer: e.customer, reply: e.reply })),
    handoffKeywords: [...dto.handoffKeywords],
    notifyKeywords: [...(dto.notifyKeywords ?? [])],
    handoffMessage: dto.handoffMessage ?? '',
    escalateWhenUnsure: dto.escalateWhenUnsure,
    handoffAckLabel: dto.handoffAckLabel ?? '',
    handoffResolveLabel: dto.handoffResolveLabel ?? '',
    handoffActionLark: dto.handoffActionLark ?? CHATBOT_DEFAULTS.handoffActionLark,
    handoffAckMessage: dto.handoffAckMessage ?? '',
    handoffResolveMessage: dto.handoffResolveMessage ?? '',
    responseSpeed: normalizeResponseSpeed(dto.responseSpeed),
    agentReplyMode: normalizeAgentReplyMode(dto.agentReplyMode),
    agentPauseMinutes: dto.agentPauseMinutes == null ? '' : String(dto.agentPauseMinutes),
    handoffReminderEnabled: reminder > 0,
    handoffReminderMin: String(reminder > 0 ? reminder : DEFAULT_HANDOFF_REMINDER_MIN),
    model: dto.model ?? '',
    temperature: dto.temperature,
    replyDelaySec: String(dto.replyDelaySec),
    maxWaitSec: String(dto.maxWaitSec),
    maxRepliesPerHour: String(dto.maxRepliesPerHour),
  };
}

/** Giá trị lạ/thiếu (API cũ chưa có trường) => mặc định 'fast'. */
export function normalizeResponseSpeed(value: unknown): ResponseSpeed {
  return (RESPONSE_SPEEDS as readonly unknown[]).includes(value)
    ? (value as ResponseSpeed)
    : CHATBOT_DEFAULTS.responseSpeed;
}

/** Giá trị lạ/thiếu (API cũ chưa có trường) => mặc định 'pause'. */
export function normalizeAgentReplyMode(value: unknown): AgentReplyMode {
  return (AGENT_REPLY_MODES as readonly unknown[]).includes(value)
    ? (value as AgentReplyMode)
    : CHATBOT_DEFAULTS.agentReplyMode;
}

/** handoffReminderMin lạ/thiếu => 0 (tắt). */
function normalizeReminderMin(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

/** Số nguyên trong [min, max]. */
function isIntInRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** '' hoặc không phải số => NaN (để Zod báo lỗi thay vì lặng lẽ thành 0). */
function parseNumberField(value: string): number {
  const trimmed = value.trim().replace(',', '.');
  return trimmed === '' ? Number.NaN : Number(trimmed);
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Form → body POST/PATCH (đầy đủ trường). Cặp mẫu trống cả hai ô bị bỏ qua. */
export function formToRequest(form: ChatbotFormValues): CreateChatbotRequest {
  return {
    name: form.name.trim(),
    description: blankToNull(form.description),
    isActive: form.isActive,
    instructions: form.instructions,
    knowledge: form.knowledge,
    examples: form.examples
      .map((e) => ({ customer: e.customer.trim(), reply: e.reply.trim() }))
      .filter((e) => e.customer || e.reply),
    handoffKeywords: form.handoffKeywords,
    notifyKeywords: form.notifyKeywords,
    handoffMessage: blankToNull(form.handoffMessage),
    escalateWhenUnsure: form.escalateWhenUnsure,
    handoffAckLabel: blankToNull(form.handoffAckLabel),
    handoffResolveLabel: blankToNull(form.handoffResolveLabel),
    handoffActionLark: form.handoffActionLark,
    handoffAckMessage: blankToNull(form.handoffAckMessage),
    handoffResolveMessage: blankToNull(form.handoffResolveMessage),
    responseSpeed: form.responseSpeed,
    agentReplyMode: form.agentReplyMode,
    agentPauseMinutes: agentPauseMinutesToRequest(form),
    handoffReminderMin: form.handoffReminderEnabled ? parseNumberField(form.handoffReminderMin) : 0,
    model: blankToNull(form.model),
    temperature: form.temperature,
    replyDelaySec: parseNumberField(form.replyDelaySec),
    maxWaitSec: parseNumberField(form.maxWaitSec),
    maxRepliesPerHour: parseNumberField(form.maxRepliesPerHour),
  };
}

/**
 * Ô "tạm nghỉ" rỗng => null (mặc định hệ thống). Ô chỉ hiện khi chọn 'pause': chế độ khác mà ô đang giữ
 * giá trị không hợp lệ (ô bị ẩn, không sửa được) thì gửi null thay vì báo lỗi ở ô ẩn.
 */
function agentPauseMinutesToRequest(form: ChatbotFormValues): number | null {
  if (!form.agentPauseMinutes.trim()) return null;
  const value = parseNumberField(form.agentPauseMinutes);
  if (form.agentReplyMode === 'pause') return value;
  return isIntInRange(value, CHATBOT_LIMITS.agentPauseMinutesMin, CHATBOT_LIMITS.agentPauseMinutesMax)
    ? value
    : null;
}

const n = (v: number) => v.toLocaleString('vi-VN');

/** Thông báo tiếng Việt theo trường (Zod/API trả câu tiếng Anh mặc định). */
function fieldMessage(path: string, code?: string): string {
  const [field, index, sub] = path.split('.');
  switch (field) {
    case 'name':
      return code === 'too_big'
        ? `Tên tối đa ${CHATBOT_LIMITS.nameMax} ký tự`
        : 'Tên chatbot không được để trống';
    case 'description':
      return `Mô tả tối đa ${CHATBOT_LIMITS.descriptionMax} ký tự`;
    case 'instructions':
      return `Hướng dẫn tối đa ${n(CHATBOT_LIMITS.instructionsMax)} ký tự`;
    case 'knowledge':
      return `Kiến thức tối đa ${n(CHATBOT_LIMITS.knowledgeMax)} ký tự`;
    case 'examples':
      if (index === undefined) return `Tối đa ${CHATBOT_LIMITS.examplesMax} câu trả lời mẫu`;
      if (code === 'too_big') return `Tối đa ${n(CHATBOT_LIMITS.exampleTextMax)} ký tự`;
      return sub === 'reply' ? 'Nhập câu bot trả lời' : 'Nhập câu khách hỏi';
    case 'handoffKeywords':
    case 'notifyKeywords':
      return index === undefined
        ? `Tối đa ${CHATBOT_LIMITS.keywordsMax} từ khóa`
        : `Mỗi từ khóa tối đa ${CHATBOT_LIMITS.keywordMax} ký tự`;
    case 'handoffMessage':
      return `Tin giữ chỗ tối đa ${n(CHATBOT_LIMITS.handoffMessageMax)} ký tự`;
    case 'handoffAckLabel':
    case 'handoffResolveLabel':
      return `Tên nút tối đa ${CHATBOT_LIMITS.handoffButtonLabelMax} ký tự`;
    case 'handoffAckMessage':
    case 'handoffResolveMessage':
      return `Tin gửi khách tối đa ${n(CHATBOT_LIMITS.handoffMessageMax)} ký tự`;
    case 'model':
      return 'Model không hợp lệ';
    case 'temperature':
      return 'Nhiệt độ phải từ 0 đến 1';
    case 'responseSpeed':
      return 'Chọn một tốc độ trả lời';
    case 'agentReplyMode':
      return 'Chọn cách bot xử lý khi nhân viên nhắn tin';
    case 'agentPauseMinutes':
      return `Nhập số nguyên từ ${CHATBOT_LIMITS.agentPauseMinutesMin} đến ${n(CHATBOT_LIMITS.agentPauseMinutesMax)} phút (để trống = mặc định ${DEFAULT_AGENT_PAUSE_MIN} phút)`;
    case 'handoffReminderMin':
      return `Nhập số nguyên từ 1 đến ${n(CHATBOT_LIMITS.handoffReminderMinMax)} phút`;
    case 'replyDelaySec':
      return 'Nhập số nguyên từ 0 đến 120 giây';
    case 'maxWaitSec':
      return 'Nhập số nguyên từ 5 đến 300 giây';
    case 'maxRepliesPerHour':
      return 'Nhập số nguyên từ 1 đến 200';
    default:
      return 'Giá trị không hợp lệ';
  }
}

/**
 * Đường dẫn lỗi của examples tính trên danh sách ĐÃ LỌC (bỏ cặp trống); đổi về chỉ số dòng trong form
 * để hiện lỗi đúng ô.
 */
function remapExamplePath(path: string, form: ChatbotFormValues): string {
  const parts = path.split('.');
  if (parts[0] !== 'examples' || parts[1] === undefined) return path;
  const kept = form.examples
    .map((e, i) => ({ i, keep: !!(e.customer.trim() || e.reply.trim()) }))
    .filter((x) => x.keep);
  const original = kept[Number(parts[1])]?.i;
  return original === undefined ? path : ['examples', String(original), ...parts.slice(2)].join('.');
}

export type ValidationResult = { ok: true; data: CreateChatbotRequest } | { ok: false; errors: FormErrors };

/** Kiểm tra bằng schema chung + ràng buộc phía form (chờ tối đa ≥ độ trễ gom tin). */
export function validateChatbotForm(form: ChatbotFormValues): ValidationResult {
  const body = formToRequest(form);
  const errors: FormErrors = {};
  const parsed = createChatbotSchema.safeParse(body);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = remapExamplePath(issue.path.map(String).join('.'), form);
      errors[path] ??= fieldMessage(path, issue.code);
    }
  }
  if (
    !errors.replyDelaySec &&
    !errors.maxWaitSec &&
    Number.isFinite(body.maxWaitSec) &&
    Number.isFinite(body.replyDelaySec) &&
    body.maxWaitSec! < body.replyDelaySec!
  ) {
    errors.maxWaitSec = 'Chờ tối đa phải lớn hơn hoặc bằng độ trễ gom tin';
  }
  // Bật nhắc lại thì phải ≥ 1 phút (schema chung cho phép 0 = tắt).
  if (form.handoffReminderEnabled && !errors.handoffReminderMin) {
    const v = body.handoffReminderMin ?? Number.NaN;
    if (!isIntInRange(v, 1, CHATBOT_LIMITS.handoffReminderMinMax)) {
      errors.handoffReminderMin = fieldMessage('handoffReminderMin');
    }
  }
  // Một từ khóa không được nằm ở cả hai danh sách.
  const overlap = keywordOverlap(form.handoffKeywords, form.notifyKeywords);
  if (overlap.length > 0 && !errors.notifyKeywords) {
    const message = overlapMessage(overlap);
    errors.notifyKeywords = message;
    for (const i of overlapIndexes(form.handoffKeywords, form.notifyKeywords)) {
      errors[`notifyKeywords.${i}`] ??= message;
    }
  }
  if (Object.keys(errors).length > 0 || !parsed.success) return { ok: false, errors };
  return { ok: true, data: parsed.data };
}

export const NAME_CONFLICT_MESSAGE = 'Đã có chatbot mang tên này. Vui lòng chọn tên khác.';

/** Lỗi API khi lưu → lỗi từng ô (400 có `errors[]`, 409 trùng tên) + thông báo chung (nếu có). */
export function apiErrorToForm(
  err: unknown,
  form?: ChatbotFormValues,
): { errors: FormErrors; message: string | null } {
  if (!(err instanceof ApiError)) return { errors: {}, message: 'Không lưu được chatbot. Vui lòng thử lại.' };
  if (err.status === 409) return { errors: { name: NAME_CONFLICT_MESSAGE }, message: null };
  if (err.status === 400 && err.body && typeof err.body === 'object' && 'errors' in err.body) {
    const raw = (err.body as { errors: unknown }).errors;
    const errors: FormErrors = {};
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const rawPath = String((item as { path?: unknown }).path ?? '');
        if (!rawPath) continue;
        const path = form ? remapExamplePath(rawPath, form) : rawPath;
        errors[path] ??= fieldMessage(path);
      }
    }
    if (Object.keys(errors).length > 0) return { errors, message: null };
  }
  return { errors: {}, message: err.message };
}

/** Tab của trình soạn và trường thuộc tab đó (để đánh dấu tab có lỗi). */
export const EDITOR_TABS = ['instructions', 'knowledge', 'examples', 'handoff', 'staff', 'advanced'] as const;
export type EditorTab = (typeof EDITOR_TABS)[number];

const FIELD_TAB: Record<string, EditorTab> = {
  instructions: 'instructions',
  knowledge: 'knowledge',
  examples: 'examples',
  handoffKeywords: 'handoff',
  notifyKeywords: 'handoff',
  handoffMessage: 'handoff',
  escalateWhenUnsure: 'handoff',
  handoffAckLabel: 'handoff',
  handoffResolveLabel: 'handoff',
  handoffActionLark: 'handoff',
  handoffAckMessage: 'handoff',
  handoffResolveMessage: 'handoff',
  agentReplyMode: 'staff',
  agentPauseMinutes: 'staff',
  handoffReminderEnabled: 'staff',
  handoffReminderMin: 'staff',
  model: 'advanced',
  responseSpeed: 'advanced',
  temperature: 'advanced',
  replyDelaySec: 'advanced',
  maxWaitSec: 'advanced',
  maxRepliesPerHour: 'advanced',
  isActive: 'advanced',
};

/** Tab chứa lỗi (name/description nằm ngoài tab => không tính). */
export function tabsWithErrors(errors: FormErrors): Set<EditorTab> {
  const out = new Set<EditorTab>();
  for (const path of Object.keys(errors)) {
    const tab = FIELD_TAB[path.split('.')[0]!];
    if (tab) out.add(tab);
  }
  return out;
}

/**
 * So sánh form (bỏ khóa dòng) để biết có thay đổi chưa lưu. Số phút nhắc lại khi đang TẮT nhắc lại không
 * được gửi đi (luôn 0) nên không tính.
 */
export function isFormDirty(form: ChatbotFormValues, baseline: ChatbotFormValues): boolean {
  const strip = (f: ChatbotFormValues) =>
    JSON.stringify({
      ...f,
      examples: f.examples.map((e) => [e.customer, e.reply]),
      handoffReminderMin: f.handoffReminderEnabled ? f.handoffReminderMin : '',
    });
  return strip(form) !== strip(baseline);
}

/** Bật/tắt "Nhắc lại khi chưa ai nhận hội thoại": bật mà ô số trống ⇒ điền sẵn 15 phút. */
export function toggleHandoffReminder(
  form: Pick<ChatbotFormValues, 'handoffReminderMin'>,
  enabled: boolean,
): Pick<ChatbotFormValues, 'handoffReminderEnabled' | 'handoffReminderMin'> {
  const empty = !form.handoffReminderMin.trim();
  return {
    handoffReminderEnabled: enabled,
    handoffReminderMin: enabled && empty ? String(DEFAULT_HANDOFF_REMINDER_MIN) : form.handoffReminderMin,
  };
}

// ---------- Từ khóa chuyển người ----------

/** Bỏ dấu + thường hóa để so trùng (giống cách server so khớp). */
export function keywordIdentity(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Thêm từ khóa từ ô nhập (tách theo dấu phẩy, chấm phẩy, xuống dòng); bỏ trống, bỏ trùng (không dấu,
 * không phân biệt hoa thường), cắt độ dài tối đa, giới hạn số lượng.
 */
export function addKeywords(current: readonly string[], input: string): string[] {
  const out = [...current];
  const seen = new Set(current.map(keywordIdentity));
  for (const piece of input.split(/[,;\n]/)) {
    const keyword = piece.normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, CHATBOT_LIMITS.keywordMax);
    const id = keywordIdentity(keyword);
    if (!id || seen.has(id) || out.length >= CHATBOT_LIMITS.keywordsMax) continue;
    seen.add(id);
    out.push(keyword);
  }
  return out;
}

export function hasKeyword(current: readonly string[], keyword: string): boolean {
  const id = keywordIdentity(keyword);
  return current.some((k) => keywordIdentity(k) === id);
}

/** Từ khóa của danh sách "bot VẪN trả lời" trùng (không dấu, không hoa thường) với danh sách "DỪNG bot". */
export function keywordOverlap(handoff: readonly string[], notify: readonly string[]): string[] {
  const ids = new Set(handoff.map(keywordIdentity));
  return notify.filter((k) => ids.has(keywordIdentity(k)));
}

/** Chỉ số trong danh sách "bot VẪN trả lời" của các từ khóa trùng. */
function overlapIndexes(handoff: readonly string[], notify: readonly string[]): number[] {
  const ids = new Set(handoff.map(keywordIdentity));
  return notify.flatMap((k, i) => (ids.has(keywordIdentity(k)) ? [i] : []));
}

/** Lỗi khi từ khóa nằm ở cả hai danh sách. */
export function overlapMessage(overlap: readonly string[]): string {
  const list = overlap.map((k) => `“${k}”`).join(', ');
  const subject = overlap.length === 1 ? `Từ khóa ${list}` : `Các từ khóa ${list}`;
  return `${subject} đã có ở danh sách “Báo nhân viên + DỪNG bot”. Mỗi từ khóa chỉ được nằm ở một danh sách.`;
}

// ---------- Danh sách ----------

/** Chuyển phần tử từ vị trí `from` sang `to` (ngoài phạm vi => giữ nguyên). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item!);
  return out;
}

/**
 * Áp mẫu tham khảo sẽ THAY nội dung ô Hướng dẫn: cần hỏi lại khi ô đang có nội dung khác mẫu
 * (ô trống hoặc đã đúng mẫu đó thì áp luôn).
 */
export function templateNeedsConfirm(current: string, template: string): boolean {
  const value = current.trim();
  return value !== '' && value !== template.trim();
}

// ---------- Nhân bản ----------

/** "Tên (bản sao)", "Tên (bản sao 2)"... không trùng tên đã có (so sánh không phân biệt hoa thường). */
export function duplicateName(name: string, existing: readonly string[]): string {
  const taken = new Set(existing.map((x) => x.trim().toLowerCase()));
  for (let i = 1; i < 1000; i += 1) {
    const suffix = i === 1 ? ' (bản sao)' : ` (bản sao ${i})`;
    const candidate = `${name.slice(0, CHATBOT_LIMITS.nameMax - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${name.slice(0, CHATBOT_LIMITS.nameMax - 14)} (${Date.now()})`;
}

/** Bot đầy đủ → body tạo bản sao (bản sao để TẮT cho tới khi admin kiểm tra lại). */
export function duplicateRequest(dto: ChatbotDto, existingNames: readonly string[]): CreateChatbotRequest {
  return {
    name: duplicateName(dto.name, existingNames),
    description: dto.description,
    isActive: false,
    instructions: dto.instructions,
    knowledge: dto.knowledge,
    examples: dto.examples.map((e) => ({ customer: e.customer, reply: e.reply })),
    handoffKeywords: [...dto.handoffKeywords],
    notifyKeywords: [...(dto.notifyKeywords ?? [])],
    handoffMessage: dto.handoffMessage,
    escalateWhenUnsure: dto.escalateWhenUnsure,
    handoffAckLabel: dto.handoffAckLabel ?? null,
    handoffResolveLabel: dto.handoffResolveLabel ?? null,
    handoffActionLark: dto.handoffActionLark ?? CHATBOT_DEFAULTS.handoffActionLark,
    handoffAckMessage: dto.handoffAckMessage ?? null,
    handoffResolveMessage: dto.handoffResolveMessage ?? null,
    responseSpeed: normalizeResponseSpeed(dto.responseSpeed),
    agentReplyMode: normalizeAgentReplyMode(dto.agentReplyMode),
    agentPauseMinutes: dto.agentPauseMinutes ?? null,
    handoffReminderMin: normalizeReminderMin(dto.handoffReminderMin),
    model: dto.model,
    temperature: dto.temperature,
    replyDelaySec: dto.replyDelaySec,
    maxWaitSec: dto.maxWaitSec,
    maxRepliesPerHour: dto.maxRepliesPerHour,
  };
}

/** "Đang dùng ở 3 hội thoại" / "Chưa dùng ở hội thoại nào". */
export function usageText(count: number): string {
  return count > 0 ? `Đang dùng ở ${n(count)} hội thoại` : 'Chưa dùng ở hội thoại nào';
}

/** Gợi ý đặt cạnh "Độ trễ gom tin" để bot trả lời dưới 4 giây. */
export const FAST_REPLY_TIP = 'Muốn trả lời dưới 4 giây: đặt 0–1 giây và chọn Nhanh nhất.';

/**
 * Độ trễ gom tin lớn nhất vẫn giữ được "dưới 4 giây" (đo thật với Nhanh nhất:
 * 0 giây ≈ 1,8 s, 1 giây ≈ 3,0 s; mỗi giây trễ thêm ≈ 1,1 s nên 2 giây đã ≈ 4,1 s).
 */
export const FAST_REPLY_MAX_DELAY_SEC = 1;

/**
 * Cấu hình hiện tại có đạt "dưới 4 giây" không: độ trễ gom tin 0–1 giây + tốc độ Nhanh nhất.
 * Ô độ trễ rỗng/không hợp lệ => false.
 */
export function isFastReplySetup(form: Pick<ChatbotFormValues, 'replyDelaySec' | 'responseSpeed'>): boolean {
  const delay = parseNumberField(form.replyDelaySec);
  return (
    form.responseSpeed === 'fast' && Number.isFinite(delay) && delay >= 0 && delay <= FAST_REPLY_MAX_DELAY_SEC
  );
}

/**
 * Cảnh báo khi độ trễ gom tin từ 2 giây trở lên (không thể dưới 4 giây nữa).
 * Ước lượng thời gian khách chờ ≈ độ trễ + 2 giây. Ô rỗng/không hợp lệ/≤ 1 giây => null.
 */
export function slowReplyWarning(form: Pick<ChatbotFormValues, 'replyDelaySec'>): string | null {
  const delay = parseNumberField(form.replyDelaySec);
  if (!Number.isFinite(delay) || delay <= FAST_REPLY_MAX_DELAY_SEC) return null;
  return `Đang đặt ${n(delay)} giây: khách sẽ chờ khoảng ${n(Math.round(delay + 2))} giây trở lên mới thấy bot trả lời.`;
}

/** Mô tả nhanh nhiệt độ cho thanh trượt. */
export function temperatureHint(t: number): string {
  if (t <= 0.25) return 'Rất ổn định: trả lời gần như giống nhau, bám sát kiến thức.';
  if (t <= 0.55) return 'Cân bằng (khuyên dùng): tự nhiên nhưng vẫn bám sát kiến thức.';
  if (t <= 0.8) return 'Linh hoạt: câu chữ đa dạng hơn, đôi khi diễn đạt xa kiến thức.';
  return 'Sáng tạo: nhiều biến tấu, dễ trả lời lệch — không khuyên dùng khi cần thông tin chính xác.';
}
