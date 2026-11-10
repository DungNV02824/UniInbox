/**
 * Giới hạn số lần gọi trong cửa sổ trượt, giữ trong bộ nhớ (theo từng instance API) — đủ để chặn bấm
 * liên tục làm tốn quota API key, không phải cơ chế bảo mật.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** true = được phép (đã tính lần này); false = vượt giới hạn. */
  take(key: string): boolean {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    this.prune(now);
    return true;
  }

  /** Dọn khóa đã hết hạn để Map không phình mãi. */
  private prune(now: number): void {
    if (this.hits.size < 1000) return;
    for (const [key, times] of this.hits) {
      if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
    }
  }
}
