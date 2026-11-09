// Tách văn bản dài thành các đoạn ≤ max ký tự (mục 6.6), ưu tiên cắt ở xuống dòng rồi khoảng trắng.
import { OUTBOUND_TEXT_MAX_CHARS } from '@dezon/shared';

/** Không cắt ở dấu xuống dòng/khoảng trắng nằm quá sớm (đoạn quá ngắn). */
const MIN_FILL_RATIO = 0.5;

function findCut(window: string, max: number): number {
  const minCut = Math.floor(max * MIN_FILL_RATIO);
  const newline = window.lastIndexOf('\n');
  if (newline >= minCut) return newline;
  const space = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\t'));
  if (space >= minCut) return space;
  // Cắt cứng; không tách đôi cặp surrogate (emoji).
  const code = window.charCodeAt(max - 1);
  return code >= 0xd800 && code <= 0xdbff && max > 1 ? max - 1 : max;
}

export function splitOutboundText(text: string, max = OUTBOUND_TEXT_MAX_CHARS): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const cut = findCut(rest.slice(0, max), max);
    const head = rest.slice(0, cut).trimEnd();
    if (head) parts.push(head);
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}
