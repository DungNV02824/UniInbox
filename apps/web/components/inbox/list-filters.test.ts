import { describe, expect, it } from 'vitest';
import {
  activeQuickTab,
  applyQuickTab,
  channelFilterFor,
  channelFilterOptions,
  channelOptionLabel,
  clearPopoverFilters,
  countPopoverFilters,
  groupChannelsForFilter,
  selectedChannelKey,
  type ChannelFilterChannel,
} from './list-filters';

function ch(
  id: string,
  displayName: string,
  type: ChannelFilterChannel['type'] = 'messenger',
  status: ChannelFilterChannel['status'] = 'connected',
): ChannelFilterChannel {
  return { id, type, displayName, color: '#2563eb', status };
}

describe('groupChannelsForFilter', () => {
  it('nhóm theo nền tảng (Facebook trước), kênh đang kết nối trước rồi theo tên, kênh đã ngắt cuối', () => {
    const groups = groupChannelsForFilter([
      ch('z1', 'Shop Zalo', 'zalo_oa'),
      ch('1', 'Xây Dựng Tín Nghĩa'),
      ch('2', 'Dezon Design (test)', 'messenger', 'disconnected'),
      ch('3', 'Demo app'),
      ch('4', 'Ánh Dương', 'messenger', 'expired'),
      ch('p1', 'Minh Anh', 'zalo_personal'),
    ]);
    expect(groups.map((g) => [g.label, g.channels.map((c) => c.id)])).toEqual([
      ['Facebook', ['3', '1', '4', '2']],
      ['Zalo OA', ['z1']],
      ['Zalo cá nhân', ['p1']],
    ]);
  });

  it('danh sách rỗng → không có nhóm', () => {
    expect(groupChannelsForFilter([])).toEqual([]);
  });
});

describe('channelOptionLabel', () => {
  it('thêm hậu tố cho kênh không hoạt động', () => {
    expect(channelOptionLabel(ch('1', 'Demo app'))).toBe('Demo app');
    expect(channelOptionLabel(ch('1', 'Demo app', 'messenger', 'disconnected'))).toBe('Demo app (đã ngắt)');
    expect(channelOptionLabel(ch('1', 'Demo app', 'messenger', 'expired'))).toBe('Demo app (hết hạn)');
    expect(channelOptionLabel(ch('1', 'Demo app', 'messenger', 'error'))).toBe('Demo app (lỗi)');
  });
});

describe('channelFilterOptions / chọn kênh', () => {
  const groups = groupChannelsForFilter([ch('1', 'B'), ch('2', 'A'), ch('z', 'OA', 'zalo_oa')]);
  const options = channelFilterOptions(groups);

  it('thứ tự: tất cả, nhóm Facebook + kênh, nhóm Zalo OA + kênh', () => {
    expect(options.map((o) => o.key)).toEqual([
      'all',
      'type:messenger',
      'acc:2',
      'acc:1',
      'type:zalo_oa',
      'acc:z',
    ]);
    expect(options[1]).toMatchObject({ kind: 'type', label: 'Facebook', count: 2 });
  });

  it('chọn mục đặt đúng một khóa lọc và xóa khóa kia', () => {
    expect(channelFilterFor(options[0]!)).toEqual({ channelType: undefined, channelAccountId: undefined });
    expect(channelFilterFor(options[1]!)).toEqual({ channelType: 'messenger', channelAccountId: undefined });
    expect(channelFilterFor(options[2]!)).toEqual({ channelType: undefined, channelAccountId: '2' });
  });

  it('khóa đang chọn theo bộ lọc', () => {
    expect(selectedChannelKey({})).toBe('all');
    expect(selectedChannelKey({ channelType: 'zalo_oa' })).toBe('type:zalo_oa');
    expect(selectedChannelKey({ channelAccountId: '7', channelType: 'messenger' })).toBe('acc:7');
  });
});

describe('tab nhanh', () => {
  it('tab đang sáng: Chưa đọc ưu tiên, rồi Của tôi', () => {
    expect(activeQuickTab({})).toBe('all');
    expect(activeQuickTab({ assignee: 'none' })).toBeNull();
    expect(activeQuickTab({ assignee: 'u1' })).toBeNull();
    expect(activeQuickTab({ assignee: 'me' })).toBe('mine');
    expect(activeQuickTab({ unread: true, assignee: 'me' })).toBe('unread');
  });

  it('các tab loại trừ nhau, giữ bộ lọc khác', () => {
    const base = { status: 'open' as const, channelAccountId: 'x' };
    expect(applyQuickTab(base, 'mine')).toEqual({ ...base, unread: undefined, assignee: 'me' });
    expect(applyQuickTab({ ...base, assignee: 'me' }, 'unread')).toEqual({
      ...base,
      unread: true,
      assignee: undefined,
    });
    expect(applyQuickTab({ ...base, unread: true, assignee: 'none' }, 'all')).toEqual({
      ...base,
      unread: undefined,
      assignee: undefined,
    });
    expect(applyQuickTab({ ...base, assignee: 'u1' }, 'all')).toEqual({
      ...base,
      unread: undefined,
      assignee: undefined,
    });
    expect(applyQuickTab({ unread: true, assignee: 'u1' }, 'unread')).toEqual({
      unread: true,
      assignee: 'u1',
    });
  });
});

describe('countPopoverFilters / clearPopoverFilters', () => {
  it('đếm trạng thái + người phụ trách, không tính "Của tôi" đã hiện ở tab', () => {
    expect(countPopoverFilters({})).toBe(0);
    expect(countPopoverFilters({ unread: true })).toBe(0);
    expect(countPopoverFilters({ status: 'open' })).toBe(1);
    expect(countPopoverFilters({ assignee: 'none' })).toBe(1);
    expect(countPopoverFilters({ assignee: 'me' })).toBe(0);
    expect(countPopoverFilters({ assignee: 'me', unread: true })).toBe(1);
    expect(countPopoverFilters({ status: 'resolved', assignee: 'u1' })).toBe(2);
  });

  it('xóa bộ lọc popover giữ kênh và Chưa đọc', () => {
    expect(
      clearPopoverFilters({ channelType: 'messenger', unread: true, status: 'open', assignee: 'none' }),
    ).toEqual({ channelType: 'messenger', unread: true, status: undefined, assignee: undefined });
  });
});
