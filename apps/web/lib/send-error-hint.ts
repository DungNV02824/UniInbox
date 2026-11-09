// Gợi ý thêm dưới tin gửi thất bại. Khách kéo về bằng đồng bộ (không có vai trò trong Meta App) hiện trong
// hộp thư, nhưng khi app ở chế độ Phát triển Facebook không cho trả lời họ — lỗi trả về chỉ là "chưa có
// quyền gửi tin" / "không tìm thấy người nhận", nhân viên khó đoán ra nguyên nhân.
const PERMISSION_ERRORS = [
  'chưa có quyền gửi tin',
  'chưa được cấp quyền gửi tin',
  'không tìm thấy người nhận',
];

export const DEV_MODE_SEND_HINT =
  'Nếu Meta App còn ở chế độ Phát triển, Facebook chỉ cho trả lời người có vai trò trong app (quản trị viên, nhà phát triển, người dùng thử). Muốn trả lời mọi khách, app cần được duyệt quyền pages_messaging và chuyển sang chế độ Chính thức.';

export function sendErrorHint(error: string | null | undefined): string | null {
  if (!error) return null;
  const text = error.toLowerCase();
  return PERMISSION_ERRORS.some((e) => text.includes(e)) ? DEV_MODE_SEND_HINT : null;
}
