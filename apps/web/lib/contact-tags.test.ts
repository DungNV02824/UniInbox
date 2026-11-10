import { describe, expect, it } from 'vitest';
import type { ContactTagDto, TagColor } from '@dezon/shared';
import {
  applyTagOrder,
  buildTagIndex,
  buildTagOptions,
  contactTagsOf,
  findCatalogTag,
  firstSelectableIndex,
  foldTag,
  moveActiveIndex,
  moveItem,
  splitVisibleTags,
  NOT_IN_CATALOG_HINT,
  searchCatalog,
  sortTags,
  tagKey,
  tagUsageText,
  validateTagName,
  type TagOption,
} from './contact-tags';

function tag(id: string, name: string, sortOrder: number, color: TagColor = 'blue'): ContactTagDto {
  return { id, name, color, sortOrder, contactCount: 0, createdAt: '2026-11-09T00:00:00.000Z' };
}

const catalog = [
  tag('c', 'Đã báo giá', 2, 'green'),
  tag('a', 'Khách VIP', 0, 'red'),
  tag('b', 'Cần gọi lại', 1, 'amber'),
  tag('d', 'Khách sỉ', 3),
];

describe('tagKey / foldTag', () => {
  it('tagKey: không phân biệt hoa thường, gộp khoảng trắng, NFC', () => {
    expect(tagKey('  Khách   VIP ')).toBe('khách vip');
    expect(tagKey('Khách VIP'.normalize('NFD'))).toBe(tagKey('khách vip'));
  });
  it('foldTag bỏ dấu (kể cả đ)', () => {
    expect(foldTag('Đã báo giá')).toBe('da bao gia');
    expect(foldTag('KHÁCH  Sỉ')).toBe('khach si');
  });
});

describe('catalog lookup', () => {
  it('sortTags theo sortOrder', () => {
    expect(sortTags(catalog).map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('findCatalogTag không phân biệt hoa thường; nhãn cũ = undefined', () => {
    const idx = buildTagIndex(catalog);
    expect(findCatalogTag(idx, 'khách vip')?.id).toBe('a');
    expect(findCatalogTag(idx, 'KHÁCH VIP ')?.color).toBe('red');
    // Khác dấu là nhãn khác (chỉ ô tìm kiếm mới bỏ dấu).
    expect(findCatalogTag(idx, 'khach vip')).toBeUndefined();
    expect(findCatalogTag(idx, 'vip cũ')).toBeUndefined();
  });
});

describe('searchCatalog', () => {
  it('rỗng = toàn bộ (trừ nhãn đã gắn), theo thứ tự', () => {
    expect(searchCatalog(catalog, '', ['khách vip']).map((t) => t.id)).toEqual(['b', 'c', 'd']);
  });
  it('bỏ dấu khi tìm', () => {
    expect(searchCatalog(catalog, 'khach', []).map((t) => t.id)).toEqual(['a', 'd']);
    expect(searchCatalog(catalog, 'gia', []).map((t) => t.id)).toEqual(['c']);
    expect(searchCatalog(catalog, 'GỌI', []).map((t) => t.id)).toEqual(['b']);
    expect(searchCatalog(catalog, 'zzz', [])).toEqual([]);
  });
  it('nhãn bắt đầu bằng chuỗi gõ đứng trước nhãn chỉ chứa nó', () => {
    const list = [tag('y', 'Khách mới', 0), tag('x', 'Mới mua', 1)];
    expect(searchCatalog(list, 'moi', []).map((t) => t.id)).toEqual(['x', 'y']);
  });
});

describe('buildTagOptions', () => {
  it('admin thấy "Tạo nhãn" khi tên chưa có', () => {
    const opts = buildTagOptions(catalog, ' Khách  mới ', [], true);
    expect(opts.at(-1)).toEqual({ kind: 'create', name: 'Khách mới' });
  });
  it('nhân viên thấy lời nhắc, không chọn được', () => {
    const opts = buildTagOptions(catalog, 'xyz', [], false);
    expect(opts).toEqual([{ kind: 'hint', text: NOT_IN_CATALOG_HINT }]);
    expect(firstSelectableIndex(opts)).toBe(-1);
  });
  it('tên đã có (khác hoa thường) hoặc đã gắn: không có mục tạo', () => {
    expect(buildTagOptions(catalog, 'khách vip', [], true)).toEqual([{ kind: 'tag', tag: catalog[1] }]);
    expect(buildTagOptions(catalog, 'khách vip', ['Khách VIP'], true)).toEqual([]);
    expect(buildTagOptions(catalog, 'nhãn cũ', ['Nhãn cũ'], true)).toEqual([]);
  });
  it('rỗng hoặc quá dài: chỉ danh sách', () => {
    expect(buildTagOptions(catalog, '', [], true).every((o) => o.kind === 'tag')).toBe(true);
    expect(buildTagOptions([], 'x'.repeat(51), [], true)).toEqual([]);
  });
});

describe('moveActiveIndex', () => {
  const opts: TagOption[] = [
    { kind: 'tag', tag: catalog[0]! },
    { kind: 'tag', tag: catalog[1]! },
    { kind: 'hint', text: 'h' },
  ];
  it('xuống/lên quay vòng, bỏ qua lời nhắc', () => {
    expect(moveActiveIndex(opts, -1, 1)).toBe(0);
    expect(moveActiveIndex(opts, 0, 1)).toBe(1);
    expect(moveActiveIndex(opts, 1, 1)).toBe(0);
    expect(moveActiveIndex(opts, 0, -1)).toBe(1);
    expect(moveActiveIndex(opts, -1, -1)).toBe(1);
  });
  it('không có mục chọn được = -1', () => {
    expect(moveActiveIndex([], 0, 1)).toBe(-1);
    expect(moveActiveIndex([{ kind: 'hint', text: 'h' }], 0, 1)).toBe(-1);
  });
});

describe('reorder helpers', () => {
  it('moveItem đổi chỗ, ngoài biên giữ nguyên', () => {
    expect(moveItem(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });
  it('applyTagOrder đặt lại sortOrder theo vị trí; id lạ bỏ, nhãn thiếu xếp cuối', () => {
    const out = applyTagOrder(catalog, ['d', 'zzz', 'a']);
    expect(out.map((t) => [t.id, t.sortOrder])).toEqual([
      ['d', 0],
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
  });
});

describe('validateTagName / tagUsageText', () => {
  it('bắt rỗng, quá dài, trùng (trừ chính nó)', () => {
    expect(validateTagName('  ', catalog)).toBe('Nhập tên nhãn.');
    expect(validateTagName('x'.repeat(51), catalog)).toMatch(/50/);
    expect(validateTagName('khách vip', catalog)).toBe('Đã có nhãn này');
    expect(validateTagName('KHÁCH VIP', catalog, 'a')).toBeNull();
    expect(validateTagName('Mới', catalog)).toBeNull();
  });
  it('số khách', () => {
    expect(tagUsageText(0)).toBe('Chưa gắn cho khách nào');
    expect(tagUsageText(1234)).toBe('1.234 khách');
  });
});

describe('nhãn cạnh tên khách', () => {
  it('contactTagsOf: an toàn khi thiếu tags, bỏ rỗng/trùng (không phân biệt hoa thường), giữ thứ tự', () => {
    expect(contactTagsOf(undefined)).toEqual([]);
    expect(contactTagsOf({})).toEqual([]);
    expect(contactTagsOf({ tags: null })).toEqual([]);
    expect(contactTagsOf({ tags: ['VIP', ' ', 'vip', 'Sỉ ', 'Mới'] })).toEqual(['VIP', 'Sỉ', 'Mới']);
  });

  it('splitVisibleTags: N nhãn đầu + số còn lại', () => {
    expect(splitVisibleTags(['a', 'b', 'c', 'd'], 2)).toEqual({
      visible: ['a', 'b'],
      hidden: ['c', 'd'],
      overflow: 2,
    });
    expect(splitVisibleTags(['a'], 2)).toEqual({ visible: ['a'], hidden: [], overflow: 0 });
    expect(splitVisibleTags([], 2)).toEqual({ visible: [], hidden: [], overflow: 0 });
    expect(splitVisibleTags(['a', 'b'], 0)).toEqual({ visible: [], hidden: ['a', 'b'], overflow: 2 });
    expect(splitVisibleTags(['a', 'b'], -1).overflow).toBe(2);
  });
});
