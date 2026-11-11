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
interface ClaimPattern {
  re: RegExp;
  subject: boolean;
  unlessAnywhere?: RegExp;
  /** Khớp "báo nhân viên" thuần của mẫu này được bỏ qua khi allowStaffNotified (STAFF_NOTIFIED_RE). */
  notifyTolerant?: boolean;
  /**
   * Mẫu lời "chuyển/gửi/báo cho nhân viên/bộ phận" — khi allowHandedOff (hội thoại đã thật sự được chuyển cho nhân
   * viên) chỉ khớp ở thì quá khứ ("em đã chuyển …", isPastTransfer) được bỏ qua; "em sẽ/đang chuyển …" vẫn chặn.
   * Mẫu hứa "nhân viên/bộ phận sẽ liên hệ/duyệt…" không có cờ này: vẫn chặn.
   */
  transfer?: boolean;
}

const CLAIM_PATTERNS: ClaimPattern[] = [
  // "em (đã) chuyển/gửi/báo [≤ 5 từ đệm] cho/sang… nhân viên/bộ phận…"; không từ đệm thì giới từ tùy chọn
  // ("chuyển bộ phận duyệt", "báo người phụ trách"). "Chuyện này bộ phận…" (có từ đệm, không giới từ) không khớp.
  {
    re: new RegExp(
      `${B}${VERB}(?:${FILLER}{1,5}?\\s+${PREP}|(?:\\s+${PREP})?)\\s+(?:ben\\s+|phia\\s+|cac\\s+)?${STAFF}${E}`,
    ),
    subject: true,
    notifyTolerant: true,
    transfer: true,
  },
  // "chuyển hồ sơ", "đã chuyển cho/sang …" (nơi nhận không phải người nhắn), "gửi hồ sơ sang/cho …" (không phải
  // gửi cho em/bên em).
  { re: new RegExp(`${B}chuyen ho so${E}`), subject: true, transfer: true },
  {
    re: new RegExp(
      `${B}da chuyen (?:cho|sang|qua|toi|den) (?!(?:em|minh|anh|chi|ban|a/c|anh/chi|quy khach|khach|shop)${E})`,
    ),
    subject: true,
    transfer: true,
  },
  {
    re: new RegExp(
      `${B}gui ho so (?:sang|cho|toi|den|qua|len) (?!(?:em|minh|ben em|shop|dezon|anh|chi|ban|a/c|anh/chi)${E})`,
    ),
    subject: true,
    transfer: true,
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

/**
 * Lời "đã báo nhân viên" thuần (động từ báo / báo lại, nơi nhận đúng là "nhân viên") — một khớp của mẫu đầu tiên.
 * Được bỏ qua khi hệ thống đã THẬT SỰ báo nhân viên (allowStaffNotified); "chuyển/gửi … cho bộ phận …", "nhân viên
 * sẽ liên hệ" vẫn bị chặn.
 */
const STAFF_NOTIFIED_RE = /^bao(?: lai)?(?![a-z0-9]).*(?<![a-z0-9])nhan vien$/;

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

/** Dấu hiệu thì TƯƠNG LAI / đang làm trước động từ chuyển ("em sẽ chuyển", "em đang báo", "em sắp gửi"). */
const FUTURE_MARKERS = new Set(['se', 'dang', 'sap']);
/** Dấu hiệu việc ĐÃ làm trước động từ chuyển ("em đã chuyển", "em vừa gửi"). */
const PAST_MARKERS = new Set(['da', 'vua']);
/** "… cho bộ phận rồi ạ" — "rồi" SAU lời chuyển ⇒ việc đã làm. */
const PAST_SUFFIX_RE = /(?<![a-z0-9])roi(?![a-z0-9])/;

/**
 * Lời chuyển ở thì QUÁ KHỨ ("em đã/vừa chuyển … cho bộ phận …", "em chuyển cho bộ phận rồi ạ") — chỉ lời này được
 * bỏ qua khi allowHandedOff (yêu cầu cũ đã thật sự chuyển). `lead` = phần mệnh đề trước động từ (kể cả "đã" của mẫu
 * "đã chuyển cho …"), `rest` = phần sau khớp. Dấu hiệu thì gần động từ nhất quyết định: sẽ/đang/sắp ⇒ không phải
 * quá khứ (lời hứa chuyển yêu cầu MỚI, vẫn chặn). "da" ở ĐẦU mệnh đề là "Dạ" (bỏ dấu trùng "đã") ⇒ không tính.
 * Không có dấu hiệu nào ("em chuyển cho nhân viên nhé", "em báo quản lý ngay") ⇒ không phải quá khứ.
 */
function isPastTransfer(lead: string, rest: string): boolean {
  const words = lead.split(/[^a-z0-9/]+/).filter(Boolean);
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i]!;
    if (FUTURE_MARKERS.has(w)) return false;
    if (PAST_MARKERS.has(w) && !(w === 'da' && i === 0)) return true;
  }
  return PAST_SUFFIX_RE.test(rest);
}

/**
 * Một câu (đã bỏ dấu) có lời khẳng định chuyển cho người thật không. Mặc định chỉ xét khớp ĐẦU TIÊN của mỗi mẫu;
 * allowStaffNotified ⇒ mẫu notifyTolerant xét MỌI khớp và bỏ qua khớp "báo nhân viên" thuần (STAFF_NOTIFIED_RE).
 * allowHandedOff ⇒ mẫu `transfer` xét MỌI khớp và chỉ bỏ qua lời chuyển ở thì quá khứ (isPastTransfer); lời hứa
 * "em sẽ/đang chuyển …" vẫn bị chặn (bot phải `escalate` yêu cầu mới thật).
 */
function sentenceClaims(sentence: string, allowStaffNotified: boolean, allowHandedOff: boolean): boolean {
  if (sentence.includes('?') || TRAILING_QUESTION_RE.test(sentence)) return false;
  for (const { re, subject, unlessAnywhere, notifyTolerant, transfer } of CLAIM_PATTERNS) {
    if (unlessAnywhere?.test(sentence)) continue;
    const tolerant = allowStaffNotified && notifyTolerant === true;
    const handedOff = allowHandedOff && transfer === true;
    const found =
      tolerant || handedOff ? [...sentence.matchAll(new RegExp(re.source, 'g'))] : [re.exec(sentence)];
    for (const m of found) {
      if (!m) continue;
      if (tolerant && STAFF_NOTIFIED_RE.test(m[0])) continue;
      const prefix = sentence.slice(0, m.index);
      if (handedOff) {
        // Mẫu "đã chuyển cho …" mang sẵn "đã" trong khớp.
        const lead = m[0].startsWith('da ') ? sentence.slice(0, m.index + 2) : prefix;
        if (isPastTransfer(lead, sentence.slice(m.index + m[0].length))) continue;
      }
      if (CONDITIONAL_RE.test(prefix)) continue;
      if (subject && subjectBlocks(prefix)) continue;
      return true;
    }
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
 * `allowStaffNotified` ⇒ bỏ qua lời "đã báo nhân viên" thuần (xem HandoffClaimOptions).
 */
export function claimsHandoffInReply(
  messages: readonly string[],
  options: HandoffClaimOptions = {},
): boolean {
  const allow = options.allowStaffNotified === true;
  const handedOff = options.allowHandedOff === true;
  return messages.some((bubble) =>
    splitSentences(bubble).some((sentence) =>
      // Mỗi mệnh đề sau dấu phẩy/chấm phẩy xét riêng (chủ ngữ/điều kiện của mệnh đề trước không áp sang).
      // Riêng dấu hiệu điều kiện ở mệnh đề trước ("Nếu anh/chị cần, em chuyển…") vẫn áp: xét cả câu trước.
      sentenceClaimsWithClauses(normalizeForMatch(sentence), allow, handedOff),
    ),
  );
}

export interface HandoffClaimOptions {
  /**
   * Hệ thống ĐÃ báo nhân viên thật (dòng [Hệ thống] "Đã báo nhân viên …" trong lịch sử gần đây — từ khóa "Báo nhân
   * viên, bot VẪN trả lời") ⇒ lời "em đã báo (lại) nhân viên" là đúng sự thật, không tính là tự nói đã chuyển. Các
   * lời chuyển khác ("đã chuyển hồ sơ cho bộ phận duyệt", "nhân viên sẽ liên hệ") vẫn bị chặn.
   */
  allowStaffNotified?: boolean;
  /**
   * Hội thoại ĐÃ thật sự được chuyển cho nhân viên (handoff còn mở) mà bot vẫn trả lời (aiHandoffMode 'continue') ⇒
   * lời "em đã/vừa chuyển (thông tin/hồ sơ) cho bộ phận …", "… cho bộ phận rồi ạ" (thì quá khứ) là đúng sự thật,
   * không tính là tự nói đã chuyển. Lời hứa chuyển yêu cầu mới ("em sẽ/đang chuyển …", "em báo quản lý ngay"),
   * "nhân viên sẽ liên hệ/gọi lại", "bộ phận … sẽ duyệt" vẫn bị chặn.
   */
  allowHandedOff?: boolean;
}

function sentenceClaimsWithClauses(
  sentence: string,
  allowStaffNotified: boolean,
  allowHandedOff: boolean,
): boolean {
  if (sentence.includes('?') || TRAILING_QUESTION_RE.test(sentence)) return false;
  const clauses = sentence.split(/\s*[,;:]\s*/);
  let conditionalBefore = false;
  for (const clause of clauses) {
    if (!conditionalBefore && sentenceClaims(clause, allowStaffNotified, allowHandedOff)) return true;
    if (CONDITIONAL_RE.test(clause)) conditionalBefore = true;
  }
  return false;
}
