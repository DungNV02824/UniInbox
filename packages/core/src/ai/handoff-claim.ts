// Phát hiện bong bóng `reply` tự nói đã/sẽ chuyển cho người thật (nhân viên, bộ phận…) mà không gọi `escalate`
// (model 'fast' — thinking minimal — hay mắc). So khớp KHÔNG DẤU (normalizeForMatch), từng câu một.
import { normalizeForMatch } from './prefilter';

/** Ranh giới từ trên chuỗi đã bỏ dấu (chỉ còn a-z, số và ký hiệu). */
const B = '(?<![a-z0-9])';
const E = '(?![a-z0-9])';

/** Người thật / nơi nhận hồ sơ. */
const STAFF =
  '(?:nhan vien|bo phan|nguoi phu trach|quan ly|ke toan|cap tren|admin|ben duyet|ben kiem duyet|phong ban|nguoi that|tu van vien|cskh)';
/** Động từ "chuyển/gửi/báo". */
const VERB = '(?:chuyen tiep|chuyen|gui|bao lai|bao)';
/** Giới từ trước nơi nhận. */
const PREP = '(?:cho|sang|toi|den|qua|len|ve|voi)';
/**
 * Một "từ đệm" giữa động từ và nơi nhận (vd. "hồ sơ", "ảnh", "lời", "giúp"). KHÔNG được là từ nối mệnh đề, đại từ
 * người nhắn hay "của": "em báo anh/chị biết là bộ phận…", "em gửi anh/chị số của bộ phận…" không phải lời chuyển.
 */
const FILLER = `(?:\\s+(?!(?:biet|la|rang|va|nhung|de|thi|ma|neu|khi|cua|chi|ban|anh/chi|a/c|dien|thoai|sdt|hotline|zalo|link)${E})[a-z0-9/]+)`;

/** "<người thật> [≤ 4 từ] sẽ/đang [sớm|nhanh chóng|liền] " — phần đầu của lời hứa người thật sẽ làm gì. */
const STAFF_WILL = `${B}${STAFF}(?:\\s+[a-z0-9/]+){0,4}?\\s+(?:se|dang)\\s+(?:som\\s+|nhanh chong\\s+|lien\\s+)?`;

/**
 * Mẫu lời khẳng định (chuỗi đã bỏ dấu). `subject: true` ⇒ chủ ngữ ngay trước động từ không được là người nhắn
 * ("anh/chị đã chuyển…", "cảm ơn anh đã gửi hồ sơ cho…") và không bị phủ định ("em chưa chuyển được…").
 */
const CLAIM_PATTERNS: { re: RegExp; subject: boolean; unlessAnywhere?: RegExp }[] = [
  // "em (đã) chuyển/gửi/báo [≤ 5 từ đệm] cho/sang… nhân viên/bộ phận…"; không từ đệm thì giới từ tùy chọn
  // ("chuyển bộ phận duyệt", "báo người phụ trách"). "Chuyện này bộ phận…" (có từ đệm, không giới từ) không khớp.
  {
    re: new RegExp(
      `${B}${VERB}(?:${FILLER}{1,5}?\\s+${PREP}|(?:\\s+${PREP})?)\\s+(?:ben\\s+|phia\\s+|cac\\s+)?${STAFF}${E}`,
    ),
    subject: true,
  },
  // "chuyển hồ sơ", "đã chuyển cho/sang …" (nơi nhận không phải người nhắn), "gửi hồ sơ sang/cho …" (không phải
  // gửi cho em/bên em).
  { re: new RegExp(`${B}chuyen ho so${E}`), subject: true },
  {
    re: new RegExp(
      `${B}da chuyen (?:cho|sang|qua|toi|den) (?!(?:em|minh|anh|chi|ban|a/c|anh/chi|quy khach|khach|shop)${E})`,
    ),
    subject: true,
  },
  {
    re: new RegExp(
      `${B}gui ho so (?:sang|cho|toi|den|qua|len) (?!(?:em|minh|ben em|shop|dezon|anh|chi|ban|a/c|anh/chi)${E})`,
    ),
    subject: true,
  },
  // "nhân viên (bên em) sẽ liên hệ/gọi…", "người phụ trách sẽ phản hồi…": hứa người thật liên hệ.
  {
    re: new RegExp(`${STAFF_WILL}(?:lien he|lien lac|goi|phan hoi|tra loi|nhan tin|ho tro)${E}`),
    subject: false,
  },
  // "bộ phận duyệt sẽ/đang duyệt/kiểm tra…" — trừ câu giải thích quy trình chung ("… sẽ duyệt trong vòng 3 ngày
  // làm việc", "sau khi nhận đủ ảnh bộ phận duyệt sẽ kiểm tra").
  {
    re: new RegExp(`${STAFF_WILL}(?:duyet|xem xet|kiem tra|xu ly|thanh toan)${E}`),
    subject: false,
    unlessAnywhere:
      /(?<![a-z0-9])(?:sau khi|khi|neu|thuong|thong thuong|trong vong|trong \d|ngay lam viec|moi ho so|hang ngay|hang tuan)(?![a-z0-9])/,
  },
];

/** Câu điều kiện / đề nghị: dấu hiệu nằm TRƯỚC lời chuyển ("nếu cần, em chuyển…", "khi đủ ảnh em sẽ chuyển…"). */
const CONDITIONAL_RE =
  /(?<![a-z0-9])(?:neu|khi|sau khi|truoc khi|luc nao|muon|can em|de em|hay de|cho em xin)(?![a-z0-9])/;
/** Câu hỏi không có '?': "... chuyển cho nhân viên không ạ". */
const TRAILING_QUESTION_RE = /(?<![a-z0-9])(?:khong|chua|nhi)(?:\s+(?:a|nha|nhe|vay|ha|nhi))?[\s.!…]*$/;
/** Trạng từ được bỏ qua khi tìm chủ ngữ ngay trước động từ. */
const ADVERBS = new Set([
  'da',
  'dang',
  'se',
  'vua',
  'moi',
  'cung',
  'giup',
  'hay',
  'vui',
  'long',
  'lai',
  'xin',
  'phep',
  'nho',
  'tiep',
  'ngay',
  'roi',
  'duoc',
  'the',
  'lien',
  'luon',
  'can',
  'chua',
  'khong',
  'chang',
  'cha',
  'ko',
]);
const NEGATIONS = new Set(['chua', 'khong', 'chang', 'cha', 'ko']);
/** Đại từ chỉ người nhắn (chủ ngữ ⇒ không phải bot tự nhận). "anh" trùng "ảnh" khi bỏ dấu — chấp nhận bỏ sót. */
const CUSTOMER_SUBJECTS = new Set(['anh', 'chi', 'ban', 'anh/chi', 'a/c', 'ac', 'khach', 'minh']);

/** Chủ ngữ ngay trước vị trí động từ là người nhắn, hoặc động từ bị phủ định ⇒ không phải lời khẳng định của bot. */
function subjectBlocks(prefix: string): boolean {
  const words = prefix.split(/[^a-z0-9/]+/).filter(Boolean);
  let i = words.length - 1;
  let negated = false;
  while (i >= 0 && ADVERBS.has(words[i]!)) {
    if (NEGATIONS.has(words[i]!)) negated = true;
    i--;
  }
  return negated || (i >= 0 && CUSTOMER_SUBJECTS.has(words[i]!));
}

/** Một câu (đã bỏ dấu) có lời khẳng định chuyển cho người thật không. */
function sentenceClaims(sentence: string): boolean {
  if (sentence.includes('?') || TRAILING_QUESTION_RE.test(sentence)) return false;
  for (const { re, subject, unlessAnywhere } of CLAIM_PATTERNS) {
    const m = re.exec(sentence);
    if (!m || unlessAnywhere?.test(sentence)) continue;
    const prefix = sentence.slice(0, m.index);
    if (CONDITIONAL_RE.test(prefix)) continue;
    if (subject && subjectBlocks(prefix)) continue;
    return true;
  }
  return false;
}

/** Tách câu: sau . ! ? … và xuống dòng; dấu phẩy/chấm phẩy cũng tách mệnh đề cho phần tìm chủ ngữ. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Bong bóng reply có câu KHẲNG ĐỊNH bot đã/đang/sẽ chuyển (gửi hồ sơ, báo) cho nhân viên/bộ phận/người phụ trách,
 * hoặc hứa "nhân viên sẽ liên hệ", "bộ phận … sẽ duyệt" không. Bỏ qua câu hỏi ('?' hoặc kết thúc bằng "không/chưa ạ"),
 * câu điều kiện/đề nghị (nếu/khi/muốn… đứng trước), phủ định (chưa/không chuyển) và câu có chủ ngữ là người nhắn.
 */
export function claimsHandoffInReply(messages: readonly string[]): boolean {
  return messages.some((bubble) =>
    splitSentences(bubble).some((sentence) =>
      // Mỗi mệnh đề sau dấu phẩy/chấm phẩy xét riêng (chủ ngữ/điều kiện của mệnh đề trước không áp sang).
      // Riêng dấu hiệu điều kiện ở mệnh đề trước ("Nếu anh/chị cần, em chuyển…") vẫn áp: xét cả câu trước.
      sentenceClaimsWithClauses(normalizeForMatch(sentence)),
    ),
  );
}

function sentenceClaimsWithClauses(sentence: string): boolean {
  if (sentence.includes('?') || TRAILING_QUESTION_RE.test(sentence)) return false;
  const clauses = sentence.split(/\s*[,;:]\s*/);
  let conditionalBefore = false;
  for (const clause of clauses) {
    if (!conditionalBefore && sentenceClaims(clause)) return true;
    if (CONDITIONAL_RE.test(clause)) conditionalBefore = true;
  }
  return false;
}
