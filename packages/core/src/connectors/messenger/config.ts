// Kiểu cấu hình/credentials của connector Messenger.

export interface MessengerConfig {
  appId: string;
  appSecret: string;
  /** META_GRAPH_BASE_URL, mặc định https://graph.facebook.com */
  graphBaseUrl: string;
  /** META_GRAPH_VERSION, ví dụ v26.0 */
  graphVersion: string;
  /** Host của dialog đăng nhập Facebook (mặc định https://www.facebook.com). */
  loginDialogBaseUrl?: string;
  /** Cho phép tiêm fetch khi test. */
  fetch?: typeof fetch;
}

/** Credentials lưu (mã hóa) trong channel_accounts.credentials cho Messenger. */
export interface MessengerCredentials {
  pageAccessToken: string;
}

/** Gọi Graph API phục vụ kết nối Fanpage (trang admin Kênh). */
export interface MessengerGraphApi {
  /** GET /me?fields=id,name bằng Page Access Token. Ném lỗi tiếng Việt nếu token sai/không phải token Page. */
  getPage(pageAccessToken: string): Promise<{ id: string; name: string }>;
  /** Đăng ký app nhận webhook của Page (subscribed_apps với các field cần thiết). */
  subscribeApp(pageId: string, pageAccessToken: string): Promise<void>;
  unsubscribeApp(pageId: string, pageAccessToken: string): Promise<void>;
}
