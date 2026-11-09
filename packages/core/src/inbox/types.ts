import type { UserRole } from '@dezon/shared';
import type { UrlSigner } from '../media/types';
import type { PolicyOptions } from '../policy';

/** Người đang thao tác (lấy từ JWT). */
export interface Viewer {
  id: string;
  role: UserRole;
}

/** Phụ thuộc chung của phần đọc/ghi hộp thư. */
export interface InboxContext {
  signUrl: UrlSigner;
  now: () => Date;
  policy: PolicyOptions;
}
