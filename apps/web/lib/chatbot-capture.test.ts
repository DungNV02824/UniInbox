import {
  CAPTURE_KEY_PATTERN,
  CAPTURE_LIMITS,
  DEFAULT_CAPTURE_CONFIG,
  DEFAULT_PROJECT_LOG_CONFIG,
  PROJECT_LOG_LIMITS,
  type CaptureConfig,
  type ContactTagDto,
} from '@dezon/shared';
import { describe, expect, it } from 'vitest';
import {
  addCaptureField,
  addField,
  canAddCaptureField,
  canAddField,
  captureEnabledCount,
  captureFieldMessage,
  captureFormErrors,
  captureFormToRequest,
  captureKeyFromLabel,
  captureTabCount,
  captureToForm,
  defaultPhoneTagFor,
  patchCaptureField,
  patchField,
  PROJECT_LOG_FIELD_SPEC,
  projectLogToForm,
  removeCaptureField,
  removeField,
  resolvePhoneTag,
  slugifyCaptureLabel,
} from './chatbot-capture';

const tag = (name: string, i = 0): ContactTagDto => ({ id: `t-${i}`, name, sortOrder: i }) as ContactTagDto;

describe('captureToForm / captureFormToRequest', () => {
  it('thiếu cấu hình ⇒ mặc định; khứ hồi giữ nguyên', () => {
    const f = captureToForm(undefined);
    expect(f.enabled).toBe(false);
    expect(f.fields.map((x) => x.key)).toEqual(['phone', 'need']);
    expect(f.phoneTag).toBe('Tiềm năng');
    expect(captureFormToRequest(f)).toEqual(DEFAULT_CAPTURE_CONFIG);
  });

  it('trường có sẵn luôn có, đứng đầu, tên cố định; bỏ khóa trùng/sai; phoneTag null ⇔ ""', () => {
    const f = captureToForm({
      enabled: true,
      fields: [
        { key: 'khu_vuc', label: 'Khu vực', hint: 'a', enabled: true },
        { key: 'need', label: 'Nhu cau sai', hint: 'b', enabled: false },
        { key: 'khu_vuc', label: 'Trùng', hint: '', enabled: true },
        { key: 'Bad Key', label: 'Sai', hint: '', enabled: true },
      ],
      phoneTag: null,
      projectLog: DEFAULT_PROJECT_LOG_CONFIG,
    });
    expect(f.fields.map((x) => [x.key, x.label, x.enabled])).toEqual([
      ['phone', 'SĐT', true],
      ['need', 'Nhu cầu', false],
      ['khu_vuc', 'Khu vực', true],
    ]);
    expect(f.phoneTag).toBe('');
    const body = captureFormToRequest({
      ...f,
      fields: f.fields.map((x) => ({ ...x, label: ` ${x.label} `, hint: ` ${x.hint} ` })),
    });
    expect(body.phoneTag).toBeNull();
    expect(body.fields[1]).toEqual({ key: 'need', label: 'Nhu cầu', hint: 'b', enabled: false });
    expect(body.fields[2]).toEqual({ key: 'khu_vuc', label: 'Khu vực', hint: 'a', enabled: true });
  });
});

describe('khóa trường', () => {
  it('slug bỏ dấu tiếng Việt, chữ thường, gạch dưới', () => {
    expect(slugifyCaptureLabel('Khu vực / Tỉnh')).toBe('khu_vuc_tinh');
    expect(slugifyCaptureLabel('  Đường đi  ')).toBe('duong_di');
    expect(slugifyCaptureLabel('Ngân sách (triệu)')).toBe('ngan_sach_trieu');
  });

  it('không trùng, khớp mẫu, tối đa 32 ký tự; không dùng được ⇒ truong_<n>', () => {
    expect(captureKeyFromLabel('Khu vực', ['phone', 'need'])).toBe('khu_vuc');
    expect(captureKeyFromLabel('Khu vực', ['khu_vuc', 'khu_vuc_2'])).toBe('khu_vuc_3');
    expect(captureKeyFromLabel('Phone', ['phone', 'need'])).toBe('phone_2');
    expect(captureKeyFromLabel('123', [])).toBe('truong_1');
    expect(captureKeyFromLabel('!!!', ['truong_1'])).toBe('truong_2');
    const long = captureKeyFromLabel('Thời gian dự kiến bắt đầu thi công công trình', []);
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long).toMatch(CAPTURE_KEY_PATTERN);
    const longDup = captureKeyFromLabel('Thời gian dự kiến bắt đầu thi công công trình', [long]);
    expect(longDup).toMatch(CAPTURE_KEY_PATTERN);
    expect(longDup).not.toBe(long);
  });
});

describe('thêm / sửa / xóa trường', () => {
  it('thêm tạo khóa một lần; đổi tên không đổi khóa', () => {
    const f = addCaptureField(captureToForm(null), '  Khu   vực ');
    expect(f.fields[2]).toEqual({ key: 'khu_vuc', label: 'Khu vực', hint: '', enabled: true });
    const renamed = patchCaptureField(f, 'khu_vuc', { label: 'Tỉnh thành' });
    expect(renamed.fields[2]!.key).toBe('khu_vuc');
    expect(renamed.fields[2]!.label).toBe('Tỉnh thành');
  });

  it('tên trống / đủ số trường ⇒ không thêm', () => {
    const base = captureToForm(null);
    expect(addCaptureField(base, '   ')).toBe(base);
    let f = base;
    for (let i = 0; i < 20; i += 1) f = addCaptureField(f, `Trường ${i}`);
    expect(f.fields).toHaveLength(CAPTURE_LIMITS.maxFields);
    expect(canAddCaptureField(f)).toBe(false);
    expect(new Set(f.fields.map((x) => x.key)).size).toBe(CAPTURE_LIMITS.maxFields);
  });

  it('trường có sẵn: không đổi tên, không xóa (chỉ tắt)', () => {
    const base = captureToForm(null);
    const p = patchCaptureField(base, 'phone', { label: 'Điện thoại', hint: 'x', enabled: false });
    expect(p.fields[0]).toMatchObject({ key: 'phone', label: 'SĐT', hint: 'x', enabled: false });
    expect(removeCaptureField(base, 'need')).toBe(base);
    const withCustom = addCaptureField(base, 'Khu vực');
    expect(removeCaptureField(withCustom, 'khu_vuc').fields.map((x) => x.key)).toEqual(['phone', 'need']);
  });

  it('số trên tab = số trường bật khi đang bật tính năng', () => {
    const f = addCaptureField(captureToForm(null), 'Khu vực');
    expect(captureEnabledCount(f)).toBe(0);
    expect(captureEnabledCount({ ...f, enabled: true })).toBe(3);
    expect(captureEnabledCount(patchCaptureField({ ...f, enabled: true }, 'need', { enabled: false }))).toBe(
      2,
    );
  });
});

describe('kiểm tra & thông báo', () => {
  it('trùng tên (không dấu, không hoa thường, kể cả trường có sẵn)', () => {
    const f = captureToForm(null);
    const withDup = {
      ...f,
      fields: [
        ...f.fields,
        { key: 'sdt', label: 'sdt', hint: '', enabled: true },
        { key: 'khu_vuc', label: 'Khu vực', hint: '', enabled: true },
        { key: 'khu_vuc_2', label: 'KHU VUC', hint: '', enabled: true },
      ],
    };
    expect(captureFormErrors(withDup)).toEqual({
      'capture.fields.2.label': 'Trùng tên với trường khác',
      'capture.fields.4.label': 'Trùng tên với trường khác',
    });
    expect(captureFormErrors(f)).toEqual({});
  });

  it('thông báo theo đường dẫn', () => {
    expect(captureFieldMessage('capture.fields')).toBe('Tối đa 10 trường');
    expect(captureFieldMessage('capture.fields.3.label', 'too_big')).toBe('Tên trường tối đa 40 ký tự');
    expect(captureFieldMessage('capture.fields.3.label', 'too_small')).toBe('Nhập tên trường');
    expect(captureFieldMessage('capture.fields.3.hint')).toBe('Hướng dẫn tối đa 300 ký tự');
    expect(captureFieldMessage('capture.phoneTag')).toBe('Nhãn không hợp lệ');
  });
});

describe('nhãn khi lấy được SĐT', () => {
  it('resolvePhoneTag: khớp không phân biệt hoa thường; thiếu ⇒ đánh dấu; chưa tải ⇒ không báo', () => {
    const catalog = [tag('VIP', 0), tag('Tiềm năng', 1)];
    expect(resolvePhoneTag('tiềm năng', catalog)).toEqual({ value: 'Tiềm năng', missing: false });
    expect(resolvePhoneTag('Đã xóa', catalog)).toEqual({ value: 'Đã xóa', missing: true });
    expect(resolvePhoneTag('Đã xóa', undefined)).toEqual({ value: 'Đã xóa', missing: false });
    expect(resolvePhoneTag(' ', catalog)).toEqual({ value: '', missing: false });
  });

  it('defaultPhoneTagFor: bot mới giữ "Tiềm năng" khi có trong danh sách, không có ⇒ không gắn', () => {
    expect(defaultPhoneTagFor('Tiềm năng', [tag('Tiềm năng')])).toBeNull();
    expect(defaultPhoneTagFor('Tiềm năng', [tag('VIP')])).toBe('');
    expect(defaultPhoneTagFor('Tiềm năng', [tag('TIỀM NĂNG')])).toBe('TIỀM NĂNG');
    expect(defaultPhoneTagFor('VIP', [])).toBeNull();
    expect(defaultPhoneTagFor('', [])).toBeNull();
  });
});

describe('Nhật ký công trình', () => {
  it('thiếu cấu hình (bot cũ) ⇒ mặc định tắt, 4 trường có sẵn; khứ hồi giữ nguyên', () => {
    const legacy = { ...DEFAULT_CAPTURE_CONFIG, projectLog: undefined } as unknown as CaptureConfig;
    const f = captureToForm(legacy);
    expect(f.projectLog.enabled).toBe(false);
    expect(f.projectLog.fields.map((x) => x.key)).toEqual([
      'dia_chi',
      'nha_thau',
      'sdt_nha_thau',
      'ngay_chup',
    ]);
    expect(captureFormToRequest(f).projectLog).toEqual(DEFAULT_PROJECT_LOG_CONFIG);
  });

  it('trường có sẵn tên cố định, đứng đầu; trường riêng giữ thứ tự, bỏ khóa trùng', () => {
    const f = projectLogToForm({
      enabled: true,
      fields: [
        { key: 'hang_muc', label: 'Hạng mục', hint: 'x', enabled: true },
        { key: 'ngay_chup', label: 'Sai tên', hint: 'h', enabled: false },
        { key: 'hang_muc', label: 'Trùng', hint: '', enabled: true },
      ],
    });
    expect(f.fields.map((x) => [x.key, x.label, x.enabled])).toEqual([
      ['dia_chi', 'Địa chỉ công trình', true],
      ['nha_thau', 'Nhà thầu', true],
      ['sdt_nha_thau', 'SĐT nhà thầu', true],
      ['ngay_chup', 'Ngày chụp', false],
      ['hang_muc', 'Hạng mục', true],
    ]);
  });

  it('thêm / sửa / xóa dùng chung bộ hàm; trường có sẵn không đổi tên, không xóa', () => {
    const rows = projectLogToForm(null).fields;
    const added = addField(rows, 'Hạng mục', PROJECT_LOG_FIELD_SPEC);
    expect(added.at(-1)).toEqual({ key: 'hang_muc', label: 'Hạng mục', hint: '', enabled: true });
    expect(patchField(added, 'dia_chi', { label: 'X', hint: 'y' }, PROJECT_LOG_FIELD_SPEC)[0]).toMatchObject({
      label: 'Địa chỉ công trình',
      hint: 'y',
    });
    expect(removeField(added, 'nha_thau', PROJECT_LOG_FIELD_SPEC)).toBe(added);
    expect(removeField(added, 'hang_muc', PROJECT_LOG_FIELD_SPEC)).toHaveLength(4);
    let full = rows;
    for (let i = 0; i < 20; i += 1) full = addField(full, `Trường ${i}`, PROJECT_LOG_FIELD_SPEC);
    expect(full).toHaveLength(PROJECT_LOG_LIMITS.maxFields);
    expect(canAddField(full, PROJECT_LOG_FIELD_SPEC)).toBe(false);
  });

  it('trùng tên báo lỗi ở capture.projectLog.fields.<i>.label; thông báo theo đường dẫn', () => {
    const f = captureToForm(null);
    const dup = {
      ...f,
      projectLog: {
        ...f.projectLog,
        fields: [...f.projectLog.fields, { key: 'nha_thau_2', label: 'NHÀ THẦU', hint: '', enabled: true }],
      },
    };
    expect(captureFormErrors(dup)).toEqual({
      'capture.projectLog.fields.4.label': 'Trùng tên với trường khác',
    });
    expect(captureFieldMessage('capture.projectLog.fields')).toBe('Tối đa 10 trường');
    expect(captureFieldMessage('capture.projectLog.fields.5.hint')).toBe('Hướng dẫn tối đa 300 ký tự');
    expect(captureFieldMessage('capture.projectLog.fields.5.label')).toBe('Nhập tên trường');
    expect(captureFieldMessage('capture.projectLog.enabled')).toBe(
      'Cấu hình nhật ký công trình không hợp lệ',
    );
  });

  it('số trên tab = trường bật của Ghi chú (khi bật) + Nhật ký công trình (khi bật)', () => {
    const f = captureToForm(null);
    expect(captureTabCount(f)).toBe(0);
    expect(captureTabCount({ ...f, projectLog: { ...f.projectLog, enabled: true } })).toBe(4);
    expect(captureTabCount({ ...f, enabled: true, projectLog: { ...f.projectLog, enabled: true } })).toBe(6);
  });
});
