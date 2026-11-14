// toChatbotConfig: ghép bot đã lưu với bản nháp "Chat thử" (thuần, không DB).
import { describe, expect, it } from 'vitest';
import { DEFAULT_CAPTURE_CONFIG, DEFAULT_PROJECT_LOG_CONFIG, type CaptureConfig } from '@dezon/shared';
import { captureFieldRefs, parseCaptureConfig, toChatbotConfig } from './config';

const row = {
  id: 'bot-1',
  name: 'Tư vấn',
  instructions: 'Thân thiện',
  knowledge: 'Bảo hành 5 năm',
  examples: [],
  handoffKeywords: ['gặp nhân viên'],
  notifyKeywords: ['bảo hành'],
  handoffMessage: null,
  model: null,
  temperature: 0.4,
  escalateWhenUnsure: true,
  responseSpeed: 'balanced' as const,
  aiHandoffMode: 'stop' as const,
};

describe('toChatbotConfig', () => {
  it('lấy responseSpeed của bot đã lưu', () => {
    expect(toChatbotConfig(row)).toMatchObject({ id: 'bot-1', responseSpeed: 'balanced' });
  });

  it('draft ghi đè responseSpeed (và các trường khác); draft không có ⇒ giữ bản đã lưu', () => {
    expect(toChatbotConfig(row, { responseSpeed: 'thorough' }).responseSpeed).toBe('thorough');
    expect(toChatbotConfig(row, { name: 'Nháp' })).toMatchObject({ name: 'Nháp', responseSpeed: 'balanced' });
  });

  it('notifyKeywords: lấy bản đã lưu; draft ghi đè (kể cả mảng rỗng)', () => {
    expect(toChatbotConfig(row).notifyKeywords).toEqual(['bảo hành']);
    expect(toChatbotConfig(row, { notifyKeywords: ['đơn gấp'] }).notifyKeywords).toEqual(['đơn gấp']);
    expect(toChatbotConfig(row, { notifyKeywords: [] }).notifyKeywords).toEqual([]);
    expect(toChatbotConfig(row, { name: 'Nháp' }).notifyKeywords).toEqual(['bảo hành']);
  });

  it('aiHandoffMode: lấy bản đã lưu; draft ghi đè', () => {
    expect(toChatbotConfig(row).aiHandoffMode).toBe('stop');
    expect(toChatbotConfig(row, { aiHandoffMode: 'continue' }).aiHandoffMode).toBe('continue');
    expect(toChatbotConfig({ ...row, aiHandoffMode: 'continue' }, { name: 'Nháp' }).aiHandoffMode).toBe(
      'continue',
    );
  });

  it('capture: null / thiếu / sai dạng ⇒ mặc định (tắt); hợp lệ ⇒ giữ; draft ghi đè', () => {
    expect(toChatbotConfig(row).capture).toEqual(DEFAULT_CAPTURE_CONFIG);
    expect(toChatbotConfig({ ...row, capture: null }).capture).toEqual(DEFAULT_CAPTURE_CONFIG);
    const on: CaptureConfig = {
      ...DEFAULT_CAPTURE_CONFIG,
      enabled: true,
      fields: [
        ...DEFAULT_CAPTURE_CONFIG.fields,
        { key: 'khu_vuc', label: 'Khu vực', hint: '', enabled: true },
      ],
    };
    expect(toChatbotConfig({ ...row, capture: on }).capture).toEqual(on);
    expect(toChatbotConfig({ ...row, capture: null }, { capture: on }).capture).toEqual(on);
    // Thiếu trường có sẵn / khóa trùng ⇒ không dùng được ⇒ mặc định.
    expect(parseCaptureConfig({ enabled: true, fields: [], phoneTag: null })).toEqual(DEFAULT_CAPTURE_CONFIG);
    expect(parseCaptureConfig('rác')).toEqual(DEFAULT_CAPTURE_CONFIG);
  });
});

describe('captureFieldRefs', () => {
  it('chỉ trường bật, theo thứ tự cấu hình, chỉ { key, label }; tắt / chưa cấu hình / hỏng ⇒ undefined', () => {
    const on: CaptureConfig = {
      enabled: true,
      phoneTag: null,
      projectLog: DEFAULT_PROJECT_LOG_CONFIG,
      fields: [
        { key: 'khu_vuc', label: 'Khu vực', hint: 'Quận/huyện', enabled: true },
        DEFAULT_CAPTURE_CONFIG.fields[0]!,
        { ...DEFAULT_CAPTURE_CONFIG.fields[1]!, enabled: false },
        { key: 'ngan_sach', label: 'Ngân sách', hint: '', enabled: true },
      ],
    };
    expect(captureFieldRefs(on)).toEqual([
      { key: 'khu_vuc', label: 'Khu vực' },
      { key: 'phone', label: 'SĐT' },
      { key: 'ngan_sach', label: 'Ngân sách' },
    ]);
    expect(captureFieldRefs({ ...on, enabled: false })).toBeUndefined();
    expect(captureFieldRefs(null)).toBeUndefined();
    expect(captureFieldRefs(undefined)).toBeUndefined();
    expect(captureFieldRefs({ enabled: true, fields: [], phoneTag: null })).toBeUndefined();
    expect(
      captureFieldRefs({ ...on, fields: on.fields.map((f) => ({ ...f, enabled: false })) }),
    ).toBeUndefined();
  });
});

describe('parseCaptureConfig — projectLog (Nhật ký công trình)', () => {
  const legacy = {
    enabled: true,
    fields: DEFAULT_CAPTURE_CONFIG.fields,
    phoneTag: 'Tiềm năng',
  };

  it('cấu hình cũ chưa có projectLog ⇒ projectLog mặc định (tắt), phần còn lại giữ nguyên', () => {
    const parsed = parseCaptureConfig(legacy);
    expect(parsed.projectLog).toEqual(DEFAULT_PROJECT_LOG_CONFIG);
    expect(parsed.projectLog.enabled).toBe(false);
    expect(parsed).toMatchObject({ enabled: true, phoneTag: 'Tiềm năng' });
    expect(parseCaptureConfig(null).projectLog).toEqual(DEFAULT_PROJECT_LOG_CONFIG);
  });

  it('projectLog hợp lệ ⇒ giữ (độc lập với enabled của thu thập); hỏng ⇒ chỉ projectLog về mặc định', () => {
    const projectLog = {
      enabled: true,
      fields: [
        ...DEFAULT_PROJECT_LOG_CONFIG.fields,
        { key: 'hang_muc', label: 'Hạng mục', hint: '', enabled: true },
      ],
    };
    expect(parseCaptureConfig({ ...legacy, enabled: false, projectLog }).projectLog).toEqual(projectLog);
    // Thiếu trường có sẵn của nhật ký ⇒ nhật ký mặc định, thu thập vẫn giữ.
    const broken = parseCaptureConfig({ ...legacy, projectLog: { enabled: true, fields: [] } });
    expect(broken.projectLog).toEqual(DEFAULT_PROJECT_LOG_CONFIG);
    expect(broken).toMatchObject({ enabled: true, phoneTag: 'Tiềm năng' });
    expect(parseCaptureConfig({ ...legacy, projectLog: 'rác' }).projectLog).toEqual(
      DEFAULT_PROJECT_LOG_CONFIG,
    );
    // Phần thu thập hỏng ⇒ toàn bộ mặc định như trước.
    expect(parseCaptureConfig({ enabled: true, fields: [], phoneTag: null, projectLog })).toEqual(
      DEFAULT_CAPTURE_CONFIG,
    );
    expect(toChatbotConfig({ ...row, capture: { ...legacy, projectLog } }).capture.projectLog).toEqual(
      projectLog,
    );
  });
});
