import type { ChannelAccountDto } from '@dezon/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import {
  canDeleteChannel,
  connectedByText,
  deleteErrorText,
  deleteImpactText,
  formatChannelStats,
  formatCount,
  isDeleteConfirmed,
  normalizeConfirmName,
  splitChannels,
  summarizeChannels,
  summaryParts,
} from './channels-admin';

function ch(
  id: string,
  status: ChannelAccountDto['status'],
  displayName: string,
  updatedAt = '2026-11-05T00:00:00.000Z',
) {
  return { id, status, displayName, updatedAt };
}

describe('splitChannels', () => {
  it('chia mục: hết hạn/lỗi lên đầu, rồi theo tên; đã ngắt theo ngày ngắt mới nhất', () => {
    const { active, disconnected } = splitChannels([
      ch('1', 'connected', 'Xây Dựng'),
      ch('2', 'disconnected', 'Demo app', '2026-11-01T00:00:00.000Z'),
      ch('3', 'expired', 'Zeta'),
      ch('4', 'connected', 'Ánh Dương'),
      ch('5', 'disconnected', 'Dezon Shop', '2026-11-06T00:00:00.000Z'),
      ch('6', 'error', 'Beta'),
      ch('7', 'disconnected', 'Cũ', 'không phải ngày'),
    ]);
    expect(active.map((c) => c.id)).toEqual(['6', '3', '4', '1']);
    expect(disconnected.map((c) => c.id)).toEqual(['5', '2', '7']);
  });

  it('không làm đổi mảng gốc; danh sách rỗng', () => {
    const input = [ch('1', 'connected', 'B'), ch('2', 'connected', 'A')];
    splitChannels(input);
    expect(input.map((c) => c.id)).toEqual(['1', '2']);
    expect(splitChannels([])).toEqual({ active: [], disconnected: [] });
  });
});

describe('summarizeChannels / summaryParts', () => {
  it('đếm theo trạng thái và bỏ phần bằng 0', () => {
    const s = summarizeChannels([
      { status: 'connected' },
      { status: 'connected' },
      { status: 'expired' },
      { status: 'disconnected' },
      { status: 'disconnected' },
      { status: 'disconnected' },
    ]);
    expect(s).toEqual({ connected: 2, attention: 1, disconnected: 3 });
    expect(summaryParts(s)).toEqual([
      { tone: 'ok', text: '2 kênh đang hoạt động' },
      { tone: 'warn', text: '1 cần kết nối lại' },
      { tone: 'muted', text: '3 đã ngắt' },
    ]);
    expect(summaryParts({ connected: 0, attention: 0, disconnected: 0 }).map((p) => p.text)).toEqual([
      '0 kênh đang hoạt động',
    ]);
  });
});

describe('định dạng số liệu', () => {
  it('formatCount dùng dấu chấm hàng nghìn, chặn giá trị lạ', () => {
    expect(formatCount(1234567)).toBe('1.234.567');
    expect(formatCount(12)).toBe('12');
    expect(formatCount(-3)).toBe('0');
    expect(formatCount(Number.NaN)).toBe('0');
  });

  it('formatChannelStats', () => {
    expect(formatChannelStats({ conversations: 12, messages: 340 })).toBe('12 hội thoại · 340 tin');
    expect(formatChannelStats({ conversations: 0, messages: 1500 })).toBe('0 hội thoại · 1.500 tin');
    expect(formatChannelStats(null)).toBeNull();
    expect(formatChannelStats(undefined)).toBeNull();
  });

  it('deleteImpactText', () => {
    expect(deleteImpactText({ conversations: 12, messages: 340 })).toBe(
      'Sẽ xóa 12 hội thoại và 340 tin nhắn',
    );
    expect(deleteImpactText({ conversations: 0, messages: 0 })).toBe(
      'Kênh này chưa có hội thoại hay tin nhắn nào',
    );
    expect(deleteImpactText(null)).toBe('Sẽ xóa toàn bộ hội thoại và tin nhắn của kênh này');
  });
});

describe('xác nhận xóa kênh', () => {
  it('chỉ xóa được kênh không còn kết nối', () => {
    expect(canDeleteChannel({ status: 'connected' })).toBe(false);
    expect(canDeleteChannel({ status: 'disconnected' })).toBe(true);
    expect(canDeleteChannel({ status: 'expired' })).toBe(true);
    expect(canDeleteChannel({ status: 'error' })).toBe(true);
  });

  it('tên gõ lại phải trùng chính xác (bỏ khoảng trắng đầu/cuối)', () => {
    expect(isDeleteConfirmed('Demo app', 'Demo app')).toBe(true);
    expect(isDeleteConfirmed('  Demo app  ', 'Demo app')).toBe(true);
    expect(isDeleteConfirmed('demo app', 'Demo app')).toBe(false);
    expect(isDeleteConfirmed('Demo', 'Demo app')).toBe(false);
    expect(isDeleteConfirmed('Xây Dựng Tín Nghĩa', 'Xây Dựng Tín Nghĩa')).toBe(true);
    expect(isDeleteConfirmed('   ', '   ')).toBe(false);
    expect(isDeleteConfirmed('', '')).toBe(false);
    // Bộ gõ sinh chữ tổ hợp (NFD) vẫn khớp; sai dấu vẫn không khớp.
    expect(isDeleteConfirmed('Xây Dựng Tín Nghĩa'.normalize('NFD'), 'Xây Dựng Tín Nghĩa')).toBe(true);
    expect(isDeleteConfirmed('Xay Dung Tin Nghia', 'Xây Dựng Tín Nghĩa')).toBe(false);
  });

  it('deleteErrorText giữ thông báo của API, 404 có câu riêng', () => {
    expect(deleteErrorText(new ApiError(409, 'Hãy ngắt kết nối kênh trước khi xóa'))).toBe(
      'Hãy ngắt kết nối kênh trước khi xóa',
    );
    expect(deleteErrorText(new ApiError(400, 'Tên kênh xác nhận không khớp'))).toBe(
      'Tên kênh xác nhận không khớp',
    );
    expect(deleteErrorText(new ApiError(404, 'x'))).toMatch(/không còn tồn tại/);
    expect(deleteErrorText(new Error('boom'))).toBe('Không xóa được kênh. Vui lòng thử lại.');
  });
});

describe('connectedByText', () => {
  it('theo cách kết nối', () => {
    expect(
      connectedByText({
        connectedBy: { provider: 'facebook_login', fbUserId: '1', fbUserName: ' Hằng Nguyễn ' },
      }),
    ).toBe('Kết nối bởi Hằng Nguyễn');
    expect(connectedByText({ connectedBy: { provider: 'facebook_login' } })).toBe(
      'Kết nối bởi tài khoản Facebook',
    );
    expect(connectedByText({ connectedBy: { provider: 'token' } })).toBe('Kết nối bằng Page Access Token');
    expect(connectedByText({ connectedBy: null })).toBeNull();
    expect(connectedByText({})).toBeNull();
  });
});

describe('normalizeConfirmName', () => {
  it('chuẩn hóa NFC và bỏ khoảng trắng đầu/cuối', () => {
    const nfd = '  Kênh thử xóa '.normalize('NFD');
    expect(normalizeConfirmName(nfd)).toBe('Kênh thử xóa'.normalize('NFC'));
  });
});
