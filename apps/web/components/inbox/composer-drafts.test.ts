import { afterEach, describe, expect, it } from 'vitest';
import { clearDrafts, getDraft, setDraft } from './composer-drafts';

afterEach(() => clearDrafts());

describe('composer drafts', () => {
  it('giữ nháp theo hội thoại', () => {
    setDraft('u1', 'c1', 'chào anh');
    expect(getDraft('u1', 'c1')).toBe('chào anh');
    expect(getDraft('u1', 'c2')).toBe('');
  });

  it('người dùng khác không thấy nháp của nhau', () => {
    setDraft('u1', 'c1', 'nháp của A');
    expect(getDraft('u2', 'c1')).toBe('');
  });

  it('xóa hết khi đăng xuất; nháp rỗng thì bỏ', () => {
    setDraft('u1', 'c1', 'x');
    setDraft('u1', 'c2', 'y');
    setDraft('u1', 'c2', '');
    expect(getDraft('u1', 'c2')).toBe('');
    clearDrafts();
    expect(getDraft('u1', 'c1')).toBe('');
  });
});
