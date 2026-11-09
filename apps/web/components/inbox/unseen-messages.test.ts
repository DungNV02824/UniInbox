import { describe, expect, it } from 'vitest';
import { countNewCustomerMessages } from './unseen-messages';

const msgs = [
  { id: 'm1', senderType: 'customer' as const },
  { id: 'm2', senderType: 'agent' as const },
  { id: 'm3', senderType: 'customer' as const },
  { id: 'm4', senderType: 'customer' as const },
];

describe('countNewCustomerMessages', () => {
  it('đếm tin khách sau tin cuối lần trước', () => {
    expect(countNewCustomerMessages('m2', msgs)).toBe(2);
    expect(countNewCustomerMessages('m1', msgs)).toBe(2);
  });

  it('không có tin mới', () => {
    expect(countNewCustomerMessages('m4', msgs)).toBe(0);
  });

  it('bỏ qua tin của nhân viên', () => {
    expect(countNewCustomerMessages('m3', [...msgs.slice(0, 3), { id: 'm5', senderType: 'agent' }])).toBe(0);
  });

  it('không tìm thấy tin cũ hoặc lần đầu → 0', () => {
    expect(countNewCustomerMessages(undefined, msgs)).toBe(0);
    expect(countNewCustomerMessages('zz', msgs)).toBe(0);
  });
});
