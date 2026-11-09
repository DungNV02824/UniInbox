import { describe, expect, it, vi } from 'vitest';
import { processSystemJob, SYSTEM_JOBS } from './system.processor';

describe('processSystemJob', () => {
  it('heartbeat trả về { ok: true, at } và log ở mức info', async () => {
    const info = vi.fn();
    const now = new Date('2026-01-02T03:04:05.000Z');
    const result = await processSystemJob(
      { id: '1', name: SYSTEM_JOBS.heartbeat, data: {} },
      { logger: { info }, now: () => now },
    );
    expect(result).toEqual({ ok: true, at: '2026-01-02T03:04:05.000Z' });
    expect(info).toHaveBeenCalledOnce();
  });

  it('heartbeat không cần context', async () => {
    const result = (await processSystemJob({ id: '1', name: SYSTEM_JOBS.heartbeat, data: {} })) as {
      at: string;
    };
    expect(Number.isNaN(Date.parse(result.at))).toBe(false);
  });

  it('echo trả về đúng payload', async () => {
    const data = { message: 'Chào chị Lan 👋', n: 1, nested: { a: [1, 2] } };
    await expect(processSystemJob({ id: '2', name: SYSTEM_JOBS.echo, data })).resolves.toEqual(data);
  });

  it('job lạ thì ném lỗi', async () => {
    await expect(processSystemJob({ id: '3', name: 'khong-ton-tai', data: {} })).rejects.toThrow(
      /khong-ton-tai/,
    );
  });
});
