import { describe, expect, it } from 'vitest';
import { extractBearerToken } from './jwt-auth.guard';

describe('extractBearerToken', () => {
  it('lấy token từ header Bearer', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken('bearer   abc')).toBe('abc');
  });

  it('từ chối header sai dạng', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('')).toBeNull();
    expect(extractBearerToken('Basic abc')).toBeNull();
    expect(extractBearerToken('Bearer')).toBeNull();
    expect(extractBearerToken('Bearer a b')).toBeNull();
  });
});
