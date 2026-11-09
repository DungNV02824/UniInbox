/** `MediaStorage | null` — null khi chưa cấu hình S3 (app vẫn chạy, upload trả 503). */
export const MEDIA_STORAGE = Symbol('MEDIA_STORAGE');

export const STORAGE_NOT_CONFIGURED_MESSAGE = 'Chưa cấu hình lưu trữ tệp (S3)';
