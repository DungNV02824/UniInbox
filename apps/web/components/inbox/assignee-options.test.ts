import { describe, expect, it } from 'vitest';
import { assigneeOptions } from './assignee-options';

const admin = { id: 'a1', name: 'Quản trị', role: 'admin' as const };
const agent = { id: 'u1', name: 'Lan', role: 'agent' as const };
const directory = [
  { id: 'a1', name: 'Quản trị' },
  { id: 'u1', name: 'Lan' },
  { id: 'u2', name: 'Minh' },
];

describe('assigneeOptions', () => {
  it('admin thấy cả danh bạ, đánh dấu chính mình', () => {
    const opts = assigneeOptions({ viewer: admin, assigned: null, directory });
    expect(opts.map((o) => o.value)).toEqual(['', 'a1', 'u1', 'u2']);
    expect(opts[1]?.label).toBe('Quản trị (tôi)');
    expect(opts.every((o) => !o.disabled)).toBe(true);
  });

  it('admin: danh bạ chưa tải vẫn có người đang phụ trách và chính mình', () => {
    const opts = assigneeOptions({ viewer: admin, assigned: { id: 'u2', name: 'Minh' }, directory: [] });
    expect(opts.map((o) => o.value)).toEqual(['', 'u2', 'a1']);
  });

  it('agent, hội thoại chưa phân công: chỉ có "Chưa phân công" và nhận về mình', () => {
    const opts = assigneeOptions({ viewer: agent, assigned: null, directory });
    expect(opts).toEqual([
      { value: '', label: 'Chưa phân công', disabled: false },
      { value: 'u1', label: 'Lan (tôi)' },
    ]);
  });

  it('agent, hội thoại của mình: được bỏ nhận', () => {
    const opts = assigneeOptions({ viewer: agent, assigned: { id: 'u1', name: 'Lan' }, directory });
    expect(opts.map((o) => o.value)).toEqual(['', 'u1']);
    expect(opts[0]?.disabled).toBe(false);
  });

  it('agent, hội thoại của người khác: không bỏ nhận/chuyển hộ, chỉ nhận về mình', () => {
    const opts = assigneeOptions({ viewer: agent, assigned: { id: 'u2', name: 'Minh' }, directory });
    expect(opts).toEqual([
      { value: '', label: 'Chưa phân công', disabled: true },
      { value: 'u1', label: 'Lan (tôi)' },
      { value: 'u2', label: 'Minh', disabled: true },
    ]);
  });
});
