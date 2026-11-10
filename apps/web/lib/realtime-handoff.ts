// Thông báo "Cần người" khi nhận sự kiện realtime `handoff.created`: nội dung toast, bộ đếm trên tiêu đề
// tab, tiếng "bíp" bằng WebAudio (không cần tệp âm thanh). Phần thuần được test riêng.
import type { HandoffCreatedPayload } from '@dezon/shared';
import { handoffReasonLabel } from '@/lib/inbox-ai';

const COUNTER_PREFIX = /^\(\d+\+?\)\s+/;

/** Bỏ tiền tố "(3) " do bộ đếm thêm vào (để luôn tính từ tiêu đề gốc). */
export function stripTitleCounter(title: string): string {
  return title.replace(COUNTER_PREFIX, '');
}

/** Tiêu đề tab kèm bộ đếm: "(3) Hộp thư · Dezon". count ≤ 0 ⇒ tiêu đề gốc. */
export function titleWithCounter(title: string, count: number): string {
  const base = stripTitleCounter(title);
  if (count <= 0) return base;
  return `(${count > 99 ? '99+' : count}) ${base}`;
}

export interface HandoffToastText {
  /** "Cần người: Chị Lan (Dezon Nội Thất) — Khách muốn gặp nhân viên"; nhắc lại thêm "Nhắc lại · ". */
  title: string;
  /** Tóm tắt cho nhân viên (có thể rỗng). */
  description: string;
}

export function handoffToastText(p: HandoffCreatedPayload): HandoffToastText {
  const who = p.channelName ? `${p.contactName} (${p.channelName})` : p.contactName;
  const title = `${p.reminder ? 'Nhắc lại · ' : ''}Cần người: ${who} — ${handoffReasonLabel(p.reasonCode)}`;
  return { title, description: p.summary?.trim() ?? '' };
}

// ---------- Âm thanh ----------

type AudioCtor = typeof AudioContext;

let ctx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (ctx) return ctx;
  const Ctor: AudioCtor | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    ctx = null;
  }
  return ctx;
}

/**
 * Trình duyệt chỉ cho phát âm thanh sau một thao tác của người dùng: gọi hàm này trong sự kiện
 * pointerdown/keydown đầu tiên để "mở khóa" AudioContext.
 */
export function unlockHandoffAudio(): void {
  const ac = audioContext();
  if (ac && ac.state === 'suspended') void ac.resume().catch(() => undefined);
}

/** Hai tiếng bíp ngắn (880 Hz rồi 660 Hz, ~0,35 s). Lỗi/không hỗ trợ thì im lặng. */
export function playHandoffBeep(): void {
  const ac = audioContext();
  if (!ac) return;
  try {
    if (ac.state === 'suspended') void ac.resume().catch(() => undefined);
    const start = ac.currentTime + 0.01;
    [880, 660].forEach((freq, i) => {
      const t = start + i * 0.18;
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      osc.connect(gain).connect(ac.destination);
      osc.start(t);
      osc.stop(t + 0.16);
    });
  } catch {
    // Không phát được âm thanh: bỏ qua, vẫn còn toast + tiêu đề tab.
  }
}
