import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadAppConfig } from './load-config';

describe('loadAppConfig', () => {
  afterEach(() => vi.restoreAllMocks());

  it('env sai => in lỗi (không lộ secret) và thoát với mã 1', () => {
    const saved = { ...process.env };
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      process.env.DATABASE_URL = '';
      process.env.JWT_SECRET = 'ngan-qua';
      expect(() => loadAppConfig()).toThrow('exit');
      expect(exit).toHaveBeenCalledWith(1);
      const output = stderr.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('DATABASE_URL');
      expect(output).toContain('JWT_SECRET');
      expect(output).not.toContain('ngan-qua');
    } finally {
      process.env = saved;
    }
  });
});
