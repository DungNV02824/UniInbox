import { describe, expect, it } from 'vitest';
import type { ChannelAccountDto, ChannelSyncState } from '@dezon/shared';
import { ApiError } from './api';
import {
  CHANNELS_POLL_FAST_MS,
  CHANNELS_POLL_SLOW_MS,
  channelsRefetchInterval,
  DEFAULT_SYNC_DAYS,
  describeSyncStatus,
  formatAgo,
  showSyncStatus,
  parseSyncDays,
  SYNC_DAY_OPTIONS,
  syncErrorText,
} from './channel-sync';

const now = new Date('2026-11-05T10:00:00.000Z');

function sync(overrides: Partial<ChannelSyncState> = {}): ChannelSyncState {
  return {
    lastSyncedAt: null,
    lastBackfillAt: null,
    backfillDays: null,
    backfillRunning: false,
    lastError: null,
    lastErrorAt: null,
    ...overrides,
  };
}

function channel(s: ChannelSyncState | null | undefined): ChannelAccountDto {
  return {
    id: 'ch-1',
    type: 'messenger',
    displayName: 'Demo app',
    externalId: '1',
    status: 'connected',
    lastError: null,
    color: '#123456',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    sync: s,
  };
}

describe('formatAgo', () => {
  it('giờ tương đối có chữ "trước"', () => {
    expect(formatAgo('2026-11-05T09:59:30.000Z', now)).toBe('vừa xong');
    expect(formatAgo('2026-11-05T09:55:00.000Z', now)).toBe('5 phút trước');
    expect(formatAgo('2026-11-05T07:00:00.000Z', now)).toBe('3 giờ trước');
    expect(formatAgo('2026-11-03T10:00:00.000Z', now)).toBe('2 ngày trước');
    expect(formatAgo('không phải ngày', now)).toBe('');
  });
});

describe('describeSyncStatus', () => {
  it('không có thông tin đồng bộ → không hiển thị gì', () => {
    expect(describeSyncStatus(null, now)).toEqual({
      running: false,
      lastSynced: null,
      backfill: null,
      error: null,
      warnings: [],
    });
  });

  it('số hội thoại/tin của lần đồng bộ lịch sử, cảnh báo chạm giới hạn và tạm dừng', () => {
    const v = describeSyncStatus(
      sync({
        lastSyncedAt: '2026-11-05T09:58:00.000Z',
        lastBackfillAt: '2026-11-05T09:00:00.000Z',
        backfillDays: 180,
        backfillConversations: 500,
        backfillMessagesStored: 1234,
        backfillTruncated: true,
        pausedUntil: '2026-11-05T10:10:00.000Z',
      }),
      now,
    );
    expect(v.backfill).toMatch(/180 ngày lúc .* · 500 hội thoại, 1234 tin mới$/);
    expect(v.warnings).toHaveLength(2);
    expect(v.warnings[0]).toMatch(/giới hạn/);
    expect(v.warnings[1]).toMatch(/^Đồng bộ định kỳ tạm dừng đến /);
    // Hết thời gian tạm dừng: không cảnh báo nữa.
    expect(describeSyncStatus(sync({ pausedUntil: '2026-11-05T09:00:00.000Z' }), now).warnings).toEqual([]);
  });

  it('kênh không kết nối (hết hạn) thì không hiện trạng thái đồng bộ (tránh lỗi lặp 2 lần)', () => {
    expect(showSyncStatus(channel(sync()))).toBe(true);
    expect(showSyncStatus({ ...channel(sync()), status: 'expired' })).toBe(false);
    expect(showSyncStatus(channel(null))).toBe(false);
  });

  it('đồng bộ lần cuối + mô tả lần đồng bộ lịch sử', () => {
    const v = describeSyncStatus(
      sync({
        lastSyncedAt: '2026-11-05T09:58:00.000Z',
        lastBackfillAt: '2026-11-05T09:00:00.000Z',
        backfillDays: 30,
      }),
      now,
    );
    expect(v.lastSynced).toBe('Đồng bộ lần cuối: 2 phút trước');
    expect(v.backfill).toMatch(/^Đã đồng bộ lịch sử 30 ngày lúc /);
    expect(v.running).toBe(false);
    expect(v.error).toBeNull();
  });

  it('chưa đồng bộ lần nào, đang đồng bộ lịch sử', () => {
    const v = describeSyncStatus(sync({ backfillRunning: true }), now);
    expect(v.lastSynced).toBe('Chưa đồng bộ lần nào');
    expect(v.running).toBe(true);
  });

  it('lỗi chỉ hiện khi mới hơn lần đồng bộ thành công gần nhất', () => {
    const newer = describeSyncStatus(
      sync({
        lastSyncedAt: '2026-11-05T09:00:00.000Z',
        lastError: 'Token hết hạn',
        lastErrorAt: '2026-11-05T09:50:00.000Z',
      }),
      now,
    );
    expect(newer.error).toEqual({ message: 'Token hết hạn', at: '10 phút trước' });

    const older = describeSyncStatus(
      sync({
        lastSyncedAt: '2026-11-05T09:55:00.000Z',
        lastError: 'Token hết hạn',
        lastErrorAt: '2026-11-05T09:50:00.000Z',
      }),
      now,
    );
    expect(older.error).toBeNull();

    // Chưa từng thành công: luôn hiện lỗi (kể cả không rõ thời điểm).
    expect(describeSyncStatus(sync({ lastError: 'Lỗi mạng' }), now).error).toEqual({
      message: 'Lỗi mạng',
      at: null,
    });
    // Đã thành công mà không rõ lúc lỗi: coi là lỗi cũ.
    expect(
      describeSyncStatus(sync({ lastSyncedAt: '2026-11-05T09:00:00.000Z', lastError: 'x' }), now).error,
    ).toBeNull();
  });
});

describe('channelsRefetchInterval', () => {
  it('5s khi có kênh đang đồng bộ lịch sử, 60s khi không', () => {
    expect(CHANNELS_POLL_FAST_MS).toBe(5_000);
    expect(CHANNELS_POLL_SLOW_MS).toBe(60_000);
    expect(channelsRefetchInterval(undefined)).toBe(CHANNELS_POLL_SLOW_MS);
    expect(channelsRefetchInterval([])).toBe(CHANNELS_POLL_SLOW_MS);
    expect(channelsRefetchInterval([channel(null), channel(undefined), channel(sync())])).toBe(
      CHANNELS_POLL_SLOW_MS,
    );
    expect(channelsRefetchInterval([channel(sync()), channel(sync({ backfillRunning: true }))])).toBe(
      CHANNELS_POLL_FAST_MS,
    );
  });
});

describe('parseSyncDays (hộp thoại Đồng bộ lịch sử)', () => {
  it('mặc định 30 ngày nằm trong các lựa chọn và mọi lựa chọn đều hợp lệ', () => {
    expect(DEFAULT_SYNC_DAYS).toBe(30);
    expect(SYNC_DAY_OPTIONS).toContain(DEFAULT_SYNC_DAYS);
    for (const n of SYNC_DAY_OPTIONS) expect(parseSyncDays(String(n))).toEqual({ ok: true, days: n });
  });

  it('từ chối số ngày ngoài 1–365, số lẻ, rỗng, không phải số', () => {
    for (const bad of ['0', '366', '7.5', '', '  ', 'abc', '-1', 'NaN', 'Infinity']) {
      expect(parseSyncDays(bad).ok).toBe(false);
    }
    expect(parseSyncDays(365)).toEqual({ ok: true, days: 365 });
    expect(parseSyncDays(' 90 ')).toEqual({ ok: true, days: 90 });
  });
});

describe('syncErrorText', () => {
  it('409 → đang đồng bộ; 422 → thông báo máy chủ; lỗi khác', () => {
    expect(syncErrorText(new ApiError(409, 'Conflict'))).toBe('Đang đồng bộ, vui lòng chờ');
    expect(syncErrorText(new ApiError(422, 'Kênh đã ngắt kết nối'))).toBe('Kênh đã ngắt kết nối');
    expect(syncErrorText(new ApiError(500, 'Máy chủ lỗi'))).toBe('Máy chủ lỗi');
    expect(syncErrorText(new Error('x'))).toBe('Không bắt đầu được đồng bộ. Vui lòng thử lại.');
  });
});
