// Ánh xạ lỗi Send API -> PermanentSendError / TransientSendError (docs/research/messenger-platform.md §7).
// Thông điệp tiếng Việt ngắn cho nhân viên; không chép message gốc của Graph (tránh lộ dữ liệu/token).
import { PermanentSendError, TransientSendError } from '../types';
import { graphErrorCode, type GraphErrorInfo } from './graph';

const OUTSIDE_WINDOW_SUBCODES = new Set([2018278, 2534022, 2018065]);
const TOKEN_SUBCODES = new Set([458, 459, 460, 463, 464, 467, 492]);
const ATTACHMENT_SUBCODES = new Set([2018008, 2018047, 2018109, 2018294]);
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 613, 80001, 80006]);

export const MSG_OUTSIDE_WINDOW = 'Đã ngoài cửa sổ gửi tin của Messenger';
export const MSG_TOKEN_INVALID = 'Token Fanpage không hợp lệ hoặc đã hết hạn — cần kết nối lại Fanpage';
export const MSG_THREAD_CONTROLLED =
  'Hội thoại đang do ứng dụng khác kiểm soát (Hộp thư Meta Business Suite hoặc Meta AI) — hãy trả lời từ đó hoặc chuyển quyền điều khiển';

function isTokenError(e: GraphErrorInfo): boolean {
  if (e.code === 190 || e.code === 102) return true;
  return e.type === 'OAuthException' && e.subcode !== undefined && TOKEN_SUBCODES.has(e.subcode);
}

function isOutsideWindow(e: GraphErrorInfo): boolean {
  if (e.subcode !== undefined && OUTSIDE_WINDOW_SUBCODES.has(e.subcode)) return true;
  return /outside of (the )?allowed window/i.test(e.message ?? '');
}

/** Lỗi HTTP/Graph của một lần gửi -> lỗi chuẩn của connector. */
export function mapSendError(status: number, e: GraphErrorInfo): PermanentSendError | TransientSendError {
  const code = graphErrorCode(status, e);
  const permanent = (msg: string, credentialsInvalid = false) =>
    new PermanentSendError(`${msg} (mã ${code})`, credentialsInvalid, code);
  const transient = (msg: string) => new TransientSendError(`${msg} (mã ${code})`, code);

  if (isTokenError(e)) return permanent(MSG_TOKEN_INVALID, true);

  switch (e.code) {
    case 10:
      if (isOutsideWindow(e)) {
        return new PermanentSendError(`${MSG_OUTSIDE_WINDOW} (mã ${code})`, false, code, 'outside_window');
      }
      if (e.subcode === 2018300) return permanent(MSG_THREAD_CONTROLLED);
      if (e.subcode === 2018108) return permanent('Khách hiện không nhận được tin nhắn từ Fanpage');
      if (e.subcode === 1893063) return permanent('Fanpage đang bị Facebook tạm hạn chế gửi tin');
      return permanent('Ứng dụng chưa có quyền gửi tin cho Fanpage này');
    case 551:
      return permanent('Khách hiện không nhận tin nhắn từ Fanpage (đã chặn hoặc không khả dụng)');
    case 200:
      if (e.subcode === 1545041) return permanent('Khách hiện không khả dụng để nhận tin');
      return permanent('Ứng dụng chưa được cấp quyền gửi tin (pages_messaging)');
    case 100:
      if (e.subcode === 2018001) return permanent('Không tìm thấy người nhận trên Messenger');
      if (e.subcode !== undefined && ATTACHMENT_SUBCODES.has(e.subcode))
        return permanent('Facebook không nhận tệp đính kèm này (sai định dạng hoặc quá lớn)');
      return permanent('Yêu cầu gửi tin không hợp lệ');
    case 368:
      return permanent('Fanpage đang bị tạm chặn gửi tin do vi phạm chính sách');
    case 613:
      if (e.subcode === 2018338) return permanent('Đã gửi quá nhiều tin có thẻ cho khách này');
      return transient('Facebook đang giới hạn tần suất gửi, sẽ thử lại');
    default:
      break;
  }

  if (e.code !== undefined && TRANSIENT_CODES.has(e.code)) {
    return transient('Facebook tạm thời lỗi hoặc giới hạn tần suất, sẽ thử lại');
  }
  if (status >= 500 || status === 429) return transient('Facebook tạm thời lỗi, sẽ thử lại');
  return permanent('Facebook từ chối gửi tin');
}

/** Lỗi mạng / timeout -> luôn tạm thời. */
export function networkSendError(timeout: boolean): TransientSendError {
  return new TransientSendError(
    timeout ? 'Facebook phản hồi quá chậm, sẽ thử lại' : 'Không kết nối được tới Facebook, sẽ thử lại',
    timeout ? 'timeout' : 'network',
  );
}

export const MSG_READ_FORBIDDEN =
  'Ứng dụng chưa có quyền đọc hội thoại của Fanpage (cần quyền pages_messaging) — hãy kết nối lại Fanpage';

/** Lỗi khi ĐỌC hội thoại (Conversations API) -> lỗi chuẩn của connector. Token hỏng => credentialsInvalid. */
export function mapReadError(status: number, e: GraphErrorInfo): PermanentSendError | TransientSendError {
  const code = graphErrorCode(status, e);
  if (isTokenError(e)) return new PermanentSendError(`${MSG_TOKEN_INVALID} (mã ${code})`, true, code);
  if (e.code === 10 || (e.code !== undefined && e.code >= 200 && e.code < 300)) {
    return new PermanentSendError(`${MSG_READ_FORBIDDEN} (mã ${code})`, false, code);
  }
  if ((e.code !== undefined && TRANSIENT_CODES.has(e.code)) || status >= 500 || status === 429) {
    return new TransientSendError(
      `Facebook tạm thời lỗi hoặc giới hạn tần suất khi đọc hội thoại, sẽ thử lại (mã ${code})`,
      code,
    );
  }
  return new PermanentSendError(`Facebook từ chối yêu cầu đọc hội thoại (mã ${code})`, false, code);
}

/** Lỗi mạng khi đọc hội thoại -> tạm thời. */
export function networkReadError(timeout: boolean): TransientSendError {
  return new TransientSendError(
    timeout
      ? 'Facebook phản hồi quá chậm khi đọc hội thoại, sẽ thử lại'
      : 'Không kết nối được tới Facebook khi đọc hội thoại, sẽ thử lại',
    timeout ? 'timeout' : 'network',
  );
}
