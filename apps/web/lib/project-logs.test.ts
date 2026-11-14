import type { ConversationDetail, ProjectLogDto } from '@dezon/shared';
import { describe, expect, it } from 'vitest';
import { conv } from './__fixtures__/inbox';
import {
  canJumpToProjectLog,
  looksLikeProjectLogs,
  PROJECT_LOG_JUMP_WINDOW_MS,
  projectLogJumpTarget,
  projectLogView,
  withoutProjectLog,
} from './project-logs';

function log(overrides: Partial<ProjectLogDto> = {}): ProjectLogDto {
  return {
    id: 'pl-1',
    conversationId: 'c-1',
    fields: [
      { key: 'dia_chi', label: 'Địa chỉ công trình', value: '252 Đ. Nguyễn Thái Bình, Tân Bình' },
      { key: 'nha_thau', label: 'Nhà thầu', value: 'Công ty CP Xây dựng TVL' },
      { key: 'sdt_nha_thau', label: 'SĐT nhà thầu', value: '0937 549 534' },
      { key: 'ngay_chup', label: 'Ngày chụp', value: '  ' },
    ],
    messageIds: ['m-1', 'm-2', 'm-3'],
    anchorMessageId: 'm-1',
    createdAt: '2026-11-09T08:00:00.000Z',
    ...overrides,
  };
}

describe('projectLogView', () => {
  it('địa chỉ làm tiêu đề, các trường còn lại có giá trị theo thứ tự', () => {
    const v = projectLogView(log());
    expect(v.title).toBe('252 Đ. Nguyễn Thái Bình, Tân Bình');
    expect(v.lines.map((f) => `${f.label}: ${f.value}`)).toEqual([
      'Nhà thầu: Công ty CP Xây dựng TVL',
      'SĐT nhà thầu: 0937 549 534',
    ]);
  });

  it('không có địa chỉ ⇒ tiêu đề null; nhãn trống ⇒ dùng khóa', () => {
    const v = projectLogView(log({ fields: [{ key: 'hang_muc', label: ' ', value: 'Móng' }] }));
    expect(v.title).toBeNull();
    expect(v.lines).toEqual([{ key: 'hang_muc', label: 'hang_muc', value: 'Móng' }]);
  });
});

describe('projectLogJumpTarget', () => {
  it('tin neo + mọi tin của lượt; mốc thôi tải = lúc ghi - PROJECT_LOG_JUMP_WINDOW_MS', () => {
    const t = projectLogJumpTarget(log({ messageIds: ['m-1', 'm-2', 'm-2'] }));
    expect(t.anchorId).toBe('m-1');
    expect(t.highlightIds).toEqual(['m-1', 'm-2']);
    expect(Date.parse(t.notBefore!)).toBe(
      Date.parse('2026-11-09T08:00:00.000Z') - PROJECT_LOG_JUMP_WINDOW_MS,
    );
  });

  it('không có tin neo ⇒ anchorId null; ngày hỏng ⇒ notBefore null', () => {
    const t = projectLogJumpTarget(log({ anchorMessageId: null, createdAt: 'x' }));
    expect(t.anchorId).toBeNull();
    expect(t.notBefore).toBeNull();
    expect(canJumpToProjectLog(log({ anchorMessageId: null, messageIds: [] }))).toBe(false);
    expect(canJumpToProjectLog(log({ anchorMessageId: null }))).toBe(true);
  });
});

describe('cache khi xóa', () => {
  const detail = (logs: ProjectLogDto[]): ConversationDetail => ({
    ...conv(),
    contactDetail: {
      ...conv().contact,
      phone: null,
      phoneSource: null,
      email: null,
      notes: null,
      profileFields: [],
      identities: [],
    },
    projectLogs: logs,
  });

  it('withoutProjectLog bỏ đúng dòng; không có ⇒ trả về nguyên', () => {
    const d = detail([log(), log({ id: 'pl-2' })]);
    expect(withoutProjectLog(d, 'pl-1')!.projectLogs.map((l) => l.id)).toEqual(['pl-2']);
    expect(withoutProjectLog(d, 'nope')).toBe(d);
    expect(withoutProjectLog(undefined, 'pl-1')).toBeUndefined();
  });

  it('looksLikeProjectLogs: mảng dòng có id; 204 (undefined) ⇒ false', () => {
    expect(looksLikeProjectLogs([log()])).toBe(true);
    expect(looksLikeProjectLogs([])).toBe(true);
    expect(looksLikeProjectLogs(undefined)).toBe(false);
    expect(looksLikeProjectLogs([{}])).toBe(false);
  });
});
