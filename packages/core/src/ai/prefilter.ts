// Pre-filter (mục 7.4): từ khóa chuyển người khớp ⇒ escalate ngay, không gọi LLM.
import type { HandoffReasonCode } from '@dezon/shared';

/**
 * Bỏ dấu tiếng Việt (NFD + xóa dấu kết hợp, 'đ'/'Đ' ⇒ 'd'), chữ thường, gộp khoảng trắng, trim.
 * Ví dụ: 'Gặp NHÂN   viên' ⇒ 'gap nhan vien'.
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tách thành các "từ" (chữ/số Unicode); dấu câu, emoji, khoảng trắng đều là ranh giới. */
function tokenize(normalized: string): string[] {
  return normalized.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
}

function containsSequence(words: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length === 0 || phrase.length > words.length) return false;
  for (let i = 0; i + phrase.length <= words.length; i++) {
    let ok = true;
    for (let j = 0; j < phrase.length; j++) {
      if (words[i + j] !== phrase[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Trả về từ khóa ĐẦU TIÊN (giá trị gốc trong `keywords`) xuất hiện trong `text`, so khớp không dấu,
 * không phân biệt hoa thường, theo ranh giới từ (từ khóa 'gia' KHÔNG khớp 'giao hàng'; cụm nhiều từ
 * khớp liên tiếp, bỏ qua dấu câu giữa các từ). Từ khóa rỗng sau chuẩn hóa bị bỏ qua. Không khớp ⇒ null.
 */
export function matchHandoffKeyword(text: string, keywords: readonly string[]): string | null {
  if (!text || keywords.length === 0) return null;
  const words = tokenize(normalizeForMatch(text));
  if (words.length === 0) return null;
  for (const keyword of keywords) {
    const phrase = tokenize(normalizeForMatch(keyword));
    if (containsSequence(words, phrase)) return keyword;
  }
  return null;
}

/**
 * Bảng dựng sẵn (đã bỏ dấu) để suy lý do chuyển người từ từ khóa khớp: từ khóa chứa cụm nào (theo ranh giới
 * từ) thì lấy lý do đó; thứ tự ưu tiên theo bảng. Không khớp ⇒ 'human_request'.
 */
const KEYWORD_REASON_TABLE: readonly {
  reason: HandoffReasonCode;
  phrases: readonly string[];
  /** Chỉ khớp khi cả từ khóa (bỏ dấu) đúng bằng. */
  exact?: readonly string[];
}[] = [
  {
    reason: 'complaint',
    phrases: [
      'khieu nai',
      'phan nan',
      'hoan tien',
      'tra hang',
      'doi tra',
      'boi thuong',
      'lua dao',
      'boc phot',
    ],
  },
  {
    reason: 'discount',
    // 'bớt' chỉ khi cả từ khóa là "bớt" hoặc đi kèm giá/chút/đi (tránh nhầm "bot" = chatbot).
    phrases: [
      'giam gia',
      'bot gia',
      'bot chut',
      'bot di',
      'chiet khau',
      'khuyen mai',
      'uu dai',
      'voucher',
      'ma giam',
      'sale',
      'giam',
    ],
    exact: ['bot'],
  },
  {
    reason: 'closing',
    phrases: ['chot don', 'dat hang', 'dat coc', 'len don', 'thanh toan', 'chuyen khoan', 'bao gia'],
  },
];

const KEYWORD_REASON_PHRASES = KEYWORD_REASON_TABLE.map((row) => ({
  reason: row.reason,
  phrases: row.phrases.map((p) => tokenize(p)),
  exact: row.exact ?? [],
}));

/** Lý do chuyển người suy từ từ khóa (xem KEYWORD_REASON_TABLE); mặc định 'human_request'. */
export function keywordHandoffReason(keyword: string): HandoffReasonCode {
  const words = tokenize(normalizeForMatch(keyword));
  for (const row of KEYWORD_REASON_PHRASES) {
    if (row.exact.includes(words.join(' '))) return row.reason;
    if (row.phrases.some((phrase) => containsSequence(words, phrase))) return row.reason;
  }
  return 'human_request';
}
