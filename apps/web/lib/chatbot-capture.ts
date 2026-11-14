// Tab "Thu thập thông tin" của trình soạn chatbot: chuyển đổi form ↔ cấu hình, tạo khóa trường, kiểm tra.
// Gồm 2 danh sách trường cùng kiểu (Ghi chú khách, Nhật ký công trình) dùng chung bộ hàm danh sách trường.
// Hàm thuần để test.
import {
  CAPTURE_BUILTIN_KEYS,
  CAPTURE_BUILTIN_LABELS,
  CAPTURE_KEY_PATTERN,
  CAPTURE_LIMITS,
  DEFAULT_CAPTURE_CONFIG,
  DEFAULT_PROJECT_LOG_CONFIG,
  PROJECT_LOG_BUILTIN_KEYS,
  PROJECT_LOG_BUILTIN_LABELS,
  PROJECT_LOG_LIMITS,
  type CaptureBuiltinKey,
  type CaptureConfig,
  type CaptureField,
  type ContactTagDto,
  type ProjectLogConfig,
} from '@dezon/shared';
import { tagKey } from '@/lib/contact-tags';

/** Một trường trong form. `key` cố định từ lúc thêm (dùng làm khóa React), người dùng không thấy. */
export interface CaptureFieldRow {
  key: string;
  label: string;
  hint: string;
  enabled: boolean;
}

/** Mục "Nhật ký công trình" trong tab. */
export interface ProjectLogFormValues {
  /** "Bot ghi nhật ký khi tiếp nhận công trình". */
  enabled: boolean;
  /** Luôn có 4 trường có sẵn ở đầu, rồi các trường riêng theo thứ tự thêm. */
  fields: CaptureFieldRow[];
}

export interface CaptureFormValues {
  /** "Bot tự điền thông tin khách vào Ghi chú". */
  enabled: boolean;
  /** Luôn có 2 trường có sẵn (SĐT, Nhu cầu) ở đầu, rồi các trường riêng theo thứ tự thêm. */
  fields: CaptureFieldRow[];
  /** Nhãn tự gắn khi lấy được SĐT; '' = không gắn nhãn. */
  phoneTag: string;
  /** Nhật ký công trình (độc lập với `enabled`). */
  projectLog: ProjectLogFormValues;
}

// ---------- Danh sách trường dùng chung ----------

/** Mô tả một danh sách trường: trường có sẵn (tên cố định, không xóa), mặc định, số trường tối đa. */
export interface FieldListSpec {
  builtinKeys: readonly string[];
  builtinLabels: Readonly<Record<string, string>>;
  defaults: readonly CaptureField[];
  maxFields: number;
}

export const CAPTURE_FIELD_SPEC: FieldListSpec = {
  builtinKeys: CAPTURE_BUILTIN_KEYS,
  builtinLabels: CAPTURE_BUILTIN_LABELS,
  defaults: DEFAULT_CAPTURE_CONFIG.fields,
  maxFields: CAPTURE_LIMITS.maxFields,
};

export const PROJECT_LOG_FIELD_SPEC: FieldListSpec = {
  builtinKeys: PROJECT_LOG_BUILTIN_KEYS,
  builtinLabels: PROJECT_LOG_BUILTIN_LABELS,
  defaults: DEFAULT_PROJECT_LOG_CONFIG.fields,
  maxFields: PROJECT_LOG_LIMITS.maxFields,
};

export function isBuiltinFieldKey(spec: FieldListSpec, key: string): boolean {
  return spec.builtinKeys.includes(key);
}

export function isBuiltinCaptureKey(key: string): key is CaptureBuiltinKey {
  return isBuiltinFieldKey(CAPTURE_FIELD_SPEC, key);
}

/** Tên hiển thị của trường (trường có sẵn ⇒ tên cố định). */
export function fieldLabel(spec: FieldListSpec, field: Pick<CaptureFieldRow, 'key' | 'label'>): string {
  return isBuiltinFieldKey(spec, field.key) ? (spec.builtinLabels[field.key] ?? field.label) : field.label;
}

function builtinDefault(spec: FieldListSpec, key: string): CaptureFieldRow {
  const def = spec.defaults.find((f) => f.key === key);
  return { key, label: spec.builtinLabels[key] ?? key, hint: def?.hint ?? '', enabled: def?.enabled ?? true };
}

/**
 * Danh sách từ API → form. Trường có sẵn luôn có mặt, đứng đầu theo thứ tự cố định, tên cố định; trường riêng
 * giữ thứ tự, bỏ khóa trùng/không hợp lệ.
 */
export function fieldsToForm(list: unknown, spec: FieldListSpec): CaptureFieldRow[] {
  const items = (Array.isArray(list) ? list : []) as (Partial<CaptureField> | null)[];
  const builtins = spec.builtinKeys.map((key) => {
    const found = items.find((f) => f?.key === key);
    return found
      ? {
          key,
          label: spec.builtinLabels[key] ?? key,
          hint: found.hint ?? '',
          enabled: found.enabled !== false,
        }
      : builtinDefault(spec, key);
  });
  const seen = new Set<string>(spec.builtinKeys);
  const custom: CaptureFieldRow[] = [];
  for (const f of items) {
    if (!f || typeof f.key !== 'string' || seen.has(f.key) || !CAPTURE_KEY_PATTERN.test(f.key)) continue;
    seen.add(f.key);
    custom.push({ key: f.key, label: f.label ?? '', hint: f.hint ?? '', enabled: f.enabled !== false });
  }
  return [...builtins, ...custom];
}

/** Form → danh sách gửi lên API (trim; tên trường có sẵn luôn là tên cố định). */
export function fieldsToRequest(rows: readonly CaptureFieldRow[], spec: FieldListSpec): CaptureField[] {
  return rows.map((f) => ({
    key: f.key,
    label: isBuiltinFieldKey(spec, f.key) ? (spec.builtinLabels[f.key] ?? f.label) : f.label.trim(),
    hint: f.hint.trim(),
    enabled: f.enabled,
  }));
}

export function canAddField(rows: readonly CaptureFieldRow[], spec: FieldListSpec): boolean {
  return rows.length < spec.maxFields;
}

/** Thêm trường riêng (bật sẵn, hướng dẫn trống). Đã đủ số trường / tên trống ⇒ trả về đúng `rows`. */
export function addField(rows: CaptureFieldRow[], label: string, spec: FieldListSpec): CaptureFieldRow[] {
  const name = label.replace(/\s+/g, ' ').trim().slice(0, CAPTURE_LIMITS.labelMax);
  if (!name || !canAddField(rows, spec)) return rows;
  const key = captureKeyFromLabel(
    name,
    rows.map((f) => f.key),
  );
  return [...rows, { key, label: name, hint: '', enabled: true }];
}

/** Sửa một trường theo khóa (trường có sẵn không đổi tên được). */
export function patchField(
  rows: readonly CaptureFieldRow[],
  key: string,
  patch: Partial<Omit<CaptureFieldRow, 'key'>>,
  spec: FieldListSpec,
): CaptureFieldRow[] {
  const safe = isBuiltinFieldKey(spec, key) ? { ...patch, label: undefined } : patch;
  return rows.map((f) =>
    f.key === key
      ? {
          ...f,
          ...(safe.label !== undefined && { label: safe.label }),
          ...(safe.hint !== undefined && { hint: safe.hint }),
          ...(safe.enabled !== undefined && { enabled: safe.enabled }),
        }
      : f,
  );
}

/** Xóa trường riêng (trường có sẵn không xóa được — chỉ tắt). Không xóa được ⇒ trả về đúng `rows`. */
export function removeField(rows: CaptureFieldRow[], key: string, spec: FieldListSpec): CaptureFieldRow[] {
  if (isBuiltinFieldKey(spec, key)) return rows;
  return rows.filter((f) => f.key !== key);
}

function labelIdentity(label: string): string {
  return slugifyCaptureLabel(label).replace(/_/g, ' ');
}

/** Tên trường không trùng nhau (không dấu, không hoa thường, kể cả trường có sẵn); lỗi ở `<prefix>.<i>.label`. */
export function fieldLabelErrors(
  rows: readonly CaptureFieldRow[],
  spec: FieldListSpec,
  prefix: string,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const seen = new Set<string>();
  rows.forEach((f, i) => {
    const id = labelIdentity(fieldLabel(spec, f));
    if (!id) return;
    if (seen.has(id)) errors[`${prefix}.${i}.label`] = 'Trùng tên với trường khác';
    seen.add(id);
  });
  return errors;
}

/** Lỗi của ô `sub` ở trường thứ `index` (đường dẫn `<prefix>.<i>.<sub>`). */
export function fieldErrorAt(
  errors: Record<string, string>,
  prefix: string,
  index: number,
  sub: 'label' | 'hint',
): string | undefined {
  return errors[`${prefix}.${index}.${sub}`];
}

// ---------- Ghi chú khách + Nhật ký công trình ----------

/** Đường dẫn lỗi của 2 danh sách trường (khớp đường dẫn Zod/API). */
export const CAPTURE_FIELDS_PATH = 'capture.fields';
export const PROJECT_LOG_FIELDS_PATH = 'capture.projectLog.fields';

/** Cấu hình nhật ký công trình từ API → form. Thiếu (API/bot cũ) ⇒ mặc định. */
export function projectLogToForm(config: ProjectLogConfig | null | undefined): ProjectLogFormValues {
  const cfg = config ?? DEFAULT_PROJECT_LOG_CONFIG;
  return { enabled: cfg.enabled === true, fields: fieldsToForm(cfg.fields, PROJECT_LOG_FIELD_SPEC) };
}

export function projectLogFormToRequest(form: ProjectLogFormValues): ProjectLogConfig {
  return { enabled: form.enabled, fields: fieldsToRequest(form.fields, PROJECT_LOG_FIELD_SPEC) };
}

/**
 * Cấu hình từ API → form. Thiếu cấu hình (API cũ) ⇒ mặc định. Trường có sẵn luôn có mặt, đứng đầu theo thứ tự
 * cố định, tên cố định; trường riêng giữ thứ tự, bỏ khóa trùng/không hợp lệ.
 */
export function captureToForm(config: CaptureConfig | null | undefined): CaptureFormValues {
  const cfg = config ?? DEFAULT_CAPTURE_CONFIG;
  return {
    enabled: cfg.enabled === true,
    fields: fieldsToForm(cfg.fields, CAPTURE_FIELD_SPEC),
    phoneTag: typeof cfg.phoneTag === 'string' ? cfg.phoneTag : '',
    projectLog: projectLogToForm(cfg.projectLog),
  };
}

/** Form → cấu hình gửi lên API (trim; tên trường có sẵn luôn là tên cố định). */
export function captureFormToRequest(form: CaptureFormValues): CaptureConfig {
  return {
    enabled: form.enabled,
    fields: fieldsToRequest(form.fields, CAPTURE_FIELD_SPEC),
    phoneTag: form.phoneTag.trim() || null,
    projectLog: projectLogFormToRequest(form.projectLog),
  };
}

/** Bỏ dấu tiếng Việt, chữ thường, ký tự khác chữ/số ⇒ gạch dưới ("Khu vực / Tỉnh" ⇒ "khu_vuc_tinh"). */
export function slugifyCaptureLabel(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const KEY_MAX = 32;

/**
 * Khóa cho trường mới từ tên trường: slug không dấu, khớp CAPTURE_KEY_PATTERN, không trùng `taken`
 * (trùng ⇒ thêm _2, _3…). Slug rỗng/không bắt đầu bằng chữ ⇒ 'truong_<n>'.
 */
export function captureKeyFromLabel(label: string, taken: readonly string[]): string {
  const used = new Set(taken);
  const slug = slugifyCaptureLabel(label).slice(0, KEY_MAX).replace(/_+$/, '');
  if (CAPTURE_KEY_PATTERN.test(slug)) {
    if (!used.has(slug)) return slug;
    for (let i = 2; i < 1000; i += 1) {
      const suffix = `_${i}`;
      const candidate = `${slug.slice(0, KEY_MAX - suffix.length).replace(/_+$/, '')}${suffix}`;
      if (!used.has(candidate)) return candidate;
    }
  }
  for (let i = 1; ; i += 1) {
    const candidate = `truong_${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function canAddCaptureField(form: CaptureFormValues): boolean {
  return canAddField(form.fields, CAPTURE_FIELD_SPEC);
}

/** Thêm trường riêng (bật sẵn, hướng dẫn trống). Đã đủ số trường / tên trống ⇒ giữ nguyên. */
export function addCaptureField(form: CaptureFormValues, label: string): CaptureFormValues {
  const fields = addField(form.fields, label, CAPTURE_FIELD_SPEC);
  return fields === form.fields ? form : { ...form, fields };
}

/** Sửa một trường theo khóa (trường có sẵn không đổi tên được). */
export function patchCaptureField(
  form: CaptureFormValues,
  key: string,
  patch: Partial<Omit<CaptureFieldRow, 'key'>>,
): CaptureFormValues {
  return { ...form, fields: patchField(form.fields, key, patch, CAPTURE_FIELD_SPEC) };
}

/** Xóa trường riêng (trường có sẵn không xóa được — chỉ tắt). */
export function removeCaptureField(form: CaptureFormValues, key: string): CaptureFormValues {
  const fields = removeField(form.fields, key, CAPTURE_FIELD_SPEC);
  return fields === form.fields ? form : { ...form, fields };
}

/** Số trường đang bật (Ghi chú khách) — 0 khi tắt tính năng. */
export function captureEnabledCount(form: CaptureFormValues): number {
  return form.enabled ? form.fields.filter((f) => f.enabled).length : 0;
}

/** Số trường nhật ký công trình đang bật — 0 khi tắt nhật ký. */
export function projectLogEnabledCount(form: ProjectLogFormValues): number {
  return form.enabled ? form.fields.filter((f) => f.enabled).length : 0;
}

/**
 * Số trên tab "Thu thập thông tin": tổng số trường AI đang lấy (Ghi chú khách khi bật + Nhật ký công trình khi
 * bật); 0 khi tắt cả hai.
 */
export function captureTabCount(form: CaptureFormValues): number {
  return captureEnabledCount(form) + projectLogEnabledCount(form.projectLog);
}

/**
 * Ràng buộc phía form: tên trường không trùng nhau trong từng danh sách (không dấu, không hoa thường, kể cả
 * trường có sẵn).
 */
export function captureFormErrors(form: CaptureFormValues): Record<string, string> {
  return {
    ...fieldLabelErrors(form.fields, CAPTURE_FIELD_SPEC, CAPTURE_FIELDS_PATH),
    ...fieldLabelErrors(form.projectLog.fields, PROJECT_LOG_FIELD_SPEC, PROJECT_LOG_FIELDS_PATH),
  };
}

/** Thông báo tiếng Việt cho lỗi Zod/API của `capture.*` (gồm `capture.projectLog.*`). */
export function captureFieldMessage(path: string, code?: string): string {
  const parts = path.split('.');
  const projectLog = parts[1] === 'projectLog';
  const [group, index, sub] = projectLog ? parts.slice(2) : parts.slice(1);
  if (group === 'fields') {
    if (index === undefined) {
      return `Tối đa ${projectLog ? PROJECT_LOG_LIMITS.maxFields : CAPTURE_LIMITS.maxFields} trường`;
    }
    if (sub === 'hint') return `Hướng dẫn tối đa ${CAPTURE_LIMITS.hintMax} ký tự`;
    if (sub === 'label') {
      return code === 'too_big' ? `Tên trường tối đa ${CAPTURE_LIMITS.labelMax} ký tự` : 'Nhập tên trường';
    }
    return 'Trường không hợp lệ';
  }
  if (projectLog) return 'Cấu hình nhật ký công trình không hợp lệ';
  if (group === 'phoneTag') return 'Nhãn không hợp lệ';
  return 'Cấu hình thu thập thông tin không hợp lệ';
}

/** Lỗi của ô `sub` ở trường thứ `index` (đường dẫn `capture.fields.<i>.<sub>`). */
export function captureFieldError(errors: Record<string, string>, index: number, sub: 'label' | 'hint') {
  return fieldErrorAt(errors, CAPTURE_FIELDS_PATH, index, sub);
}

export interface PhoneTagChoice {
  /** Giá trị cho ô chọn ('' = không gắn nhãn). */
  value: string;
  /** Nhãn đang chọn không có trong danh sách Nhãn khách (đã xóa / chưa tạo). */
  missing: boolean;
}

/**
 * Nhãn đang chọn so với danh sách Nhãn khách (không phân biệt hoa thường): khớp ⇒ dùng đúng tên trong danh
 * sách; không khớp ⇒ vẫn hiện (đánh dấu thiếu) để người dùng biết. Danh sách chưa tải ⇒ không báo thiếu.
 */
export function resolvePhoneTag(
  phoneTag: string,
  catalog: readonly ContactTagDto[] | undefined,
): PhoneTagChoice {
  const value = phoneTag.trim();
  if (!value) return { value: '', missing: false };
  if (!catalog) return { value, missing: false };
  const match = catalog.find((t) => tagKey(t.name) === tagKey(value));
  return match ? { value: match.name, missing: false } : { value, missing: true };
}

/**
 * Bot mới: nhãn mặc định "Tiềm năng" chỉ giữ khi có trong danh sách Nhãn khách; không có ⇒ '' (không gắn).
 * Trả về null khi không cần đổi.
 */
export function defaultPhoneTagFor(phoneTag: string, catalog: readonly ContactTagDto[]): string | null {
  const def = DEFAULT_CAPTURE_CONFIG.phoneTag ?? '';
  if (!def || tagKey(phoneTag) !== tagKey(def)) return null;
  const match = catalog.find((t) => tagKey(t.name) === tagKey(def));
  if (!match) return '';
  return match.name === phoneTag ? null : match.name;
}
