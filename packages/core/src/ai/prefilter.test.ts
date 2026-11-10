import { describe, expect, it } from 'vitest';
import { keywordHandoffReason, matchHandoffKeyword, normalizeForMatch } from './prefilter';

describe('normalizeForMatch', () => {
  it('bỏ dấu, chữ thường, gộp khoảng trắng, đ ⇒ d', () => {
    expect(normalizeForMatch('Gặp NHÂN   viên')).toBe('gap nhan vien');
    expect(normalizeForMatch('  Đặt hàng ĐỒNG ý  ')).toBe('dat hang dong y');
    expect(normalizeForMatch('Khuyến mãi\tgiảm\ngiá')).toBe('khuyen mai giam gia');
  });

  it('xử lý chữ dựng sẵn (NFC) lẫn tổ hợp (NFD)', () => {
    expect(normalizeForMatch('giảm'.normalize('NFD'))).toBe('giam');
    expect(normalizeForMatch('giảm'.normalize('NFC'))).toBe('giam');
  });
});

describe('matchHandoffKeyword', () => {
  const keywords = ['giảm giá', 'có bớt', 'gặp nhân viên', 'gia', 'khiếu nại'];

  it('khớp không dấu, không phân biệt hoa thường', () => {
    expect(matchHandoffKeyword('Giam gia khong?', keywords)).toBe('giảm giá');
    expect(matchHandoffKeyword('GIẢM GIÁ được ko shop', keywords)).toBe('giảm giá');
    expect(matchHandoffKeyword('Cái này có bớt không ạ', keywords)).toBe('có bớt');
    expect(matchHandoffKeyword('co bot ko', keywords)).toBe('có bớt');
  });

  it('cụm nhiều từ bỏ qua dấu câu và khoảng trắng thừa giữa các từ', () => {
    expect(matchHandoffKeyword('cho em gặp,  nhân viên!!', keywords)).toBe('gặp nhân viên');
  });

  it('chỉ khớp nguyên từ: "gia" không khớp "giao hàng" hay "giá" trong từ khác', () => {
    expect(matchHandoffKeyword('bao giờ giao hàng', ['gia'])).toBeNull();
    expect(matchHandoffKeyword('giá bao nhiêu', ['gia'])).toBe('gia');
    expect(matchHandoffKeyword('Khiếu nại!', keywords)).toBe('khiếu nại');
    expect(matchHandoffKeyword('nại', ['khiếu nại'])).toBeNull();
  });

  it('trả về từ khóa gốc đầu tiên theo thứ tự danh sách', () => {
    expect(matchHandoffKeyword('giảm giá đi gặp nhân viên', ['gặp nhân viên', 'giảm giá'])).toBe(
      'gặp nhân viên',
    );
  });

  it('bỏ qua từ khóa rỗng/chỉ dấu câu; không khớp ⇒ null', () => {
    expect(matchHandoffKeyword('xin chào', ['', '  ', '!!'])).toBeNull();
    expect(matchHandoffKeyword('', keywords)).toBeNull();
    expect(matchHandoffKeyword('tủ bếp gỗ sồi', keywords)).toBeNull();
    expect(matchHandoffKeyword('abc', [])).toBeNull();
  });

  it('đ/Đ khớp d', () => {
    expect(matchHandoffKeyword('Đổi trả thế nào', ['doi tra'])).toBe('doi tra');
    expect(matchHandoffKeyword('doi tra the nao', ['Đổi trả'])).toBe('Đổi trả');
  });
});

describe('keywordHandoffReason', () => {
  it('suy lý do từ từ khóa theo bảng dựng sẵn (không dấu)', () => {
    expect(keywordHandoffReason('giảm giá')).toBe('discount');
    expect(keywordHandoffReason('Xin BỚT giá')).toBe('discount');
    expect(keywordHandoffReason('bớt')).toBe('discount');
    expect(keywordHandoffReason('chiết khấu')).toBe('discount');
    expect(keywordHandoffReason('khuyến mãi')).toBe('discount');
    expect(keywordHandoffReason('khiếu nại')).toBe('complaint');
    expect(keywordHandoffReason('phàn nàn')).toBe('complaint');
    expect(keywordHandoffReason('hoàn tiền')).toBe('complaint');
    expect(keywordHandoffReason('chốt đơn')).toBe('closing');
    expect(keywordHandoffReason('gặp nhân viên')).toBe('human_request');
    expect(keywordHandoffReason('người thật')).toBe('human_request');
    expect(keywordHandoffReason('không nói chuyện với bot')).toBe('human_request');
    expect(keywordHandoffReason('xyz')).toBe('human_request');
  });
});
