// Gọi API "Nhãn khách" + khóa cache TanStack Query.
import { useQuery } from '@tanstack/react-query';
import type {
  ContactTagDto,
  CreateContactTagRequest,
  DeleteContactTagResponse,
  UpdateContactTagRequest,
} from '@dezon/shared';
import { api } from '@/lib/api';
import { sortTags } from '@/lib/contact-tags';

const enc = encodeURIComponent;

export const contactTagKeys = {
  all: ['contact-tags'] as const,
};

export const contactTagsApi = {
  /** Mọi nhân viên đọc được. */
  list() {
    return api.request<ContactTagDto[]>('/contact-tags');
  },
  /** Admin. 409 = "Đã có nhãn này". */
  create(body: CreateContactTagRequest) {
    return api.request<ContactTagDto>('/contact-tags', { method: 'POST', body });
  },
  /** Admin. Đổi tên áp cho mọi khách đang có nhãn. */
  update(id: string, body: UpdateContactTagRequest) {
    return api.request<ContactTagDto>(`/contact-tags/${enc(id)}`, { method: 'PATCH', body });
  },
  /** Admin. */
  reorder(ids: string[]) {
    return api.request<unknown>('/contact-tags/reorder', { method: 'POST', body: { ids } });
  },
  /** Admin. Gỡ nhãn khỏi mọi khách. */
  remove(id: string) {
    return api.request<DeleteContactTagResponse>(`/contact-tags/${enc(id)}`, { method: 'DELETE' });
  },
};

/** Danh sách nhãn (đã sắp xếp). Realtime `contact_tags.updated` làm mới nên ô chọn không cần tải lại thường. */
export function useContactTags(opts: { staleTime?: number } = {}) {
  return useQuery({
    queryKey: contactTagKeys.all,
    queryFn: () => contactTagsApi.list(),
    select: sortTags,
    staleTime: opts.staleTime ?? 60_000,
  });
}
