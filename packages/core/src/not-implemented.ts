/** Chỗ giữ cho hàm chưa cài đặt (chỉ dùng trong quá trình phát triển song song). */
export function notImplemented(name: string): never {
  throw new Error(`${name}: chưa cài đặt`);
}
