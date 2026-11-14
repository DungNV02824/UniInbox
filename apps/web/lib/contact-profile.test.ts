import type { ContactDetail, ContactProfileFieldDto } from '@dezon/shared';
import { describe, expect, it } from 'vitest';
import { applyContactUpdate, contactNoteFields, phoneUpdate, profileFieldUpdate } from './contact-profile';

const field = (patch: Partial<ContactProfileFieldDto> = {}): ContactProfileFieldDto => ({
  key: 'need',
  label: 'Nhu cầu',
  value: 'Nhà phố 3 tầng',
  source: 'ai',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...patch,
});

const contact = (patch: Partial<ContactDetail> = {}): ContactDetail => ({
  id: 'k-1',
  displayName: 'Chị Lan',
  avatarUrl: null,
  tags: [],
  phone: null,
  phoneSource: null,
  email: null,
  notes: null,
  profileFields: [],
  identities: [],
  ...patch,
});

describe('contactNoteFields', () => {
  it('Nhu cầu luôn có (trống nếu chưa điền), các trường khác theo thứ tự, bỏ trùng', () => {
    const empty = contactNoteFields(contact());
    expect(empty.need).toEqual({ key: 'need', label: 'Nhu cầu', value: '', source: null });
    expect(empty.others).toEqual([]);

    const { need, others } = contactNoteFields(
      contact({
        profileFields: [
          field({ key: 'khu_vuc', label: 'Khu vực', value: 'Thủ Đức', source: 'user' }),
          field(),
          field({ key: 'khu_vuc', label: 'Trùng', value: 'x' }),
          field({ key: 'ngan_sach', label: ' ', value: '2 tỷ' }),
        ],
      }),
    );
    expect(need).toEqual({ key: 'need', label: 'Nhu cầu', value: 'Nhà phố 3 tầng', source: 'ai' });
    expect(others).toEqual([
      { key: 'khu_vuc', label: 'Khu vực', value: 'Thủ Đức', source: 'user' },
      { key: 'ngan_sach', label: 'ngan_sach', value: '2 tỷ', source: 'ai' },
    ]);
  });

  it('trường bot cấu hình hiện sẵn (trống nếu chưa điền, tên theo cấu hình), rồi trường có giá trị ngoài cấu hình', () => {
    const { need, others } = contactNoteFields(
      contact({
        profileFields: [
          field({ value: 'Sofa' }),
          field({ key: 'mau', label: 'Màu', value: 'Trắng', source: 'user' }),
          field({ key: 'ngan_sach', label: 'Ngân sách (cũ)', value: '50tr' }),
        ],
      }),
      [
        { key: 'phone', label: 'SĐT' },
        { key: 'need', label: 'Nhu cầu' },
        { key: 'khu_vuc', label: 'Khu vực' },
        { key: 'ngan_sach', label: 'Ngân sách' },
        { key: 'khu_vuc', label: 'Trùng' },
      ],
    );
    expect(need).toEqual({ key: 'need', label: 'Nhu cầu', value: 'Sofa', source: 'ai' });
    expect(others).toEqual([
      { key: 'khu_vuc', label: 'Khu vực', value: '', source: null },
      { key: 'ngan_sach', label: 'Ngân sách', value: '50tr', source: 'ai' },
      { key: 'mau', label: 'Màu', value: 'Trắng', source: 'user' },
    ]);
    // Sửa trường trống của cấu hình ⇒ PATCH kèm tên trường.
    expect(profileFieldUpdate(others[0]!, ' Quận 7 ')).toEqual({
      profileFields: [{ key: 'khu_vuc', label: 'Khu vực', value: 'Quận 7' }],
    });
  });

  it('không có bot / bot không bật thu thập (captureFields undefined/null) ⇒ chỉ trường có giá trị', () => {
    const c = contact({ profileFields: [field({ key: 'mau', label: 'Màu', value: 'Trắng' })] });
    expect(contactNoteFields(c, undefined).others.map((f) => f.key)).toEqual(['mau']);
    expect(contactNoteFields(c, null).others.map((f) => f.key)).toEqual(['mau']);
  });

  it('máy chủ cũ chưa gửi profileFields ⇒ chỉ Nhu cầu trống', () => {
    const legacy = { ...contact(), profileFields: undefined } as unknown as ContactDetail;
    expect(contactNoteFields(legacy).others).toEqual([]);
  });
});

describe('body PATCH', () => {
  it('rỗng ⇒ null (xóa), có chữ ⇒ trim', () => {
    expect(phoneUpdate('  ')).toEqual({ phone: null });
    expect(phoneUpdate(' 0912 345 678 ')).toEqual({ phone: '0912 345 678' });
    expect(profileFieldUpdate({ key: 'need', label: 'Nhu cầu' }, ' Nhà ')).toEqual({
      profileFields: [{ key: 'need', label: 'Nhu cầu', value: 'Nhà' }],
    });
    expect(profileFieldUpdate({ key: 'khu_vuc', label: 'Khu vực' }, '')).toEqual({
      profileFields: [{ key: 'khu_vuc', label: 'Khu vực', value: null }],
    });
  });
});

describe('applyContactUpdate (máy chủ không trả hồ sơ)', () => {
  const now = '2026-11-14T00:00:00.000Z';

  it('SĐT: nhân viên sửa ⇒ nguồn user; xóa ⇒ null', () => {
    const c = contact({ phone: '090', phoneSource: 'ai' });
    expect(applyContactUpdate(c, { phone: '0912' }, now)).toMatchObject({
      phone: '0912',
      phoneSource: 'user',
    });
    expect(applyContactUpdate(c, { phone: null }, now)).toMatchObject({ phone: null, phoneSource: null });
  });

  it('trường: sửa giữ vị trí + nguồn user; thêm mới (Nhu cầu lên đầu); rỗng ⇒ xóa', () => {
    const c = contact({ profileFields: [field({ key: 'khu_vuc', label: 'Khu vực', value: 'Q1' })] });
    const edited = applyContactUpdate(c, profileFieldUpdate({ key: 'khu_vuc', label: 'Khu vực' }, 'Q7'), now);
    expect(edited.profileFields).toEqual([
      { key: 'khu_vuc', label: 'Khu vực', value: 'Q7', source: 'user', updatedAt: now },
    ]);
    const withNeed = applyContactUpdate(
      edited,
      profileFieldUpdate({ key: 'need', label: 'Nhu cầu' }, 'Nhà'),
      now,
    );
    expect(withNeed.profileFields.map((f) => f.key)).toEqual(['need', 'khu_vuc']);
    const removed = applyContactUpdate(
      withNeed,
      profileFieldUpdate({ key: 'khu_vuc', label: 'Khu vực' }, ' '),
      now,
    );
    expect(removed.profileFields.map((f) => f.key)).toEqual(['need']);
  });

  it('trường trống của cấu hình được điền ⇒ thêm với tên gửi lên; tên gửi lên thắng tên đang có (như máy chủ)', () => {
    const c = contact({ profileFields: [field({ key: 'mau', label: 'Màu cũ', value: 'Đỏ' })] });
    const added = applyContactUpdate(c, profileFieldUpdate({ key: 'khu_vuc', label: 'Khu vực' }, 'Q7'), now);
    expect(added.profileFields.map((f) => [f.key, f.label])).toEqual([
      ['mau', 'Màu cũ'],
      ['khu_vuc', 'Khu vực'],
    ]);
    const renamed = applyContactUpdate(c, profileFieldUpdate({ key: 'mau', label: 'Màu' }, 'Xanh'), now);
    expect(renamed.profileFields[0]).toMatchObject({ label: 'Màu', value: 'Xanh', source: 'user' });
  });

  it('các trường cũ (tên, ghi chú, nhãn) vẫn áp như trước', () => {
    expect(
      applyContactUpdate(contact(), { displayName: 'Lan', notes: 'x', tags: ['VIP'] }, now),
    ).toMatchObject({
      displayName: 'Lan',
      notes: 'x',
      tags: ['VIP'],
    });
  });
});
