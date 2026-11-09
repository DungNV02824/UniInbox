import { describe, expect, it } from 'vitest';
import { PLATFORM_LABELS, readFacebookReturnParams, stripFacebookReturnParams } from './channel-groups';

describe('PLATFORM_LABELS', () => {
  it('có nhãn cho mọi nền tảng', () => {
    expect(PLATFORM_LABELS).toEqual({
      messenger: 'Facebook',
      zalo_oa: 'Zalo OA',
      zalo_personal: 'Zalo cá nhân',
    });
  });
});

describe('readFacebookReturnParams', () => {
  const SID = 'abcdefghijklmnopqrstuvwxyz012345';

  it('fbSession hợp lệ', () => {
    expect(readFacebookReturnParams(`?fbSession=${SID}`)).toEqual({
      sessionId: SID,
      error: null,
      hasParams: true,
    });
  });

  it('fbError biết / không biết', () => {
    expect(readFacebookReturnParams('?fbError=denied').error).toBe('denied');
    expect(readFacebookReturnParams('?fbError=xyz').error).toBe('unknown');
  });

  it('fbSession sai định dạng => lỗi state; không có tham số', () => {
    expect(readFacebookReturnParams('?fbSession=<script>')).toEqual({
      sessionId: null,
      error: 'state',
      hasParams: true,
    });
    expect(readFacebookReturnParams('?tab=1')).toEqual({ sessionId: null, error: null, hasParams: false });
  });

  it('stripFacebookReturnParams giữ path, query khác, hash', () => {
    expect(stripFacebookReturnParams(`http://x.test/admin/channels?fbSession=${SID}&tab=2#a`)).toBe(
      '/admin/channels?tab=2#a',
    );
    expect(stripFacebookReturnParams('http://x.test/admin/channels?fbError=denied')).toBe('/admin/channels');
  });
});
