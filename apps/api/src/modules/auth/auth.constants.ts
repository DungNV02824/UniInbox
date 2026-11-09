/** Thông báo chung cho mọi lỗi đăng nhập — không tiết lộ email có tồn tại hay không. */
export const INVALID_CREDENTIALS_MESSAGE = 'Email hoặc mật khẩu không đúng';
export const LOGIN_REQUIRED_MESSAGE = 'Vui lòng đăng nhập';
export const SESSION_INVALID_MESSAGE = 'Phiên đăng nhập đã hết hạn hoặc không hợp lệ';
export const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này';

/** Cookie refresh chỉ gửi kèm các route /auth/* */
export const REFRESH_COOKIE_PATH = '/auth';
export const JWT_ISSUER = 'dezon-omni-inbox';
export const JWT_ALGORITHM = 'HS256';
