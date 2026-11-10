// Hợp đồng "Danh sách nhãn có màu": admin tạo bộ nhãn khách hàng cố định (tên + màu) ở Quản trị;
// nhân viên chọn từ danh sách khi gắn nhãn cho khách (tránh gõ sai). Ngày giờ là chuỗi ISO 8601 (UTC).
import { z } from 'zod';

/** Màu nhãn (khớp CHECK contact_tags_color_check của bảng contact_tags). */
export const TAG_COLORS = [
  'gray',
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'indigo',
  'purple',
  'pink',
] as const;
export type TagColor = (typeof TAG_COLORS)[number];

/** Tên màu tiếng Việt cho ô chọn màu. */
export const TAG_COLOR_LABELS: Record<TagColor, string> = {
  gray: 'Xám',
  red: 'Đỏ',
  orange: 'Cam',
  amber: 'Vàng',
  green: 'Xanh lá',
  teal: 'Xanh ngọc',
  blue: 'Xanh dương',
  indigo: 'Chàm',
  purple: 'Tím',
  pink: 'Hồng',
};

/** Số nhãn tối đa trong danh sách. */
export const CONTACT_TAGS_MAX = 100;
/** Độ dài tối đa của tên nhãn (khớp giới hạn một tag trong PATCH /contacts/:id). */
export const CONTACT_TAG_NAME_MAX = 50;

export interface ContactTagDto {
  id: string;
  name: string;
  color: TagColor;
  sortOrder: number;
  /** Số khách đang có nhãn này (so khớp không phân biệt hoa thường). */
  contactCount: number;
  createdAt: string;
}

export const tagColorSchema = z.enum(TAG_COLORS);
const tagNameSchema = z.string().trim().min(1).max(CONTACT_TAG_NAME_MAX);

/** POST /contact-tags (admin). */
export const createContactTagSchema = z.object({
  name: tagNameSchema,
  color: tagColorSchema.default('blue'),
});
export type CreateContactTagRequest = z.infer<typeof createContactTagSchema>;

/** PATCH /contact-tags/:id (admin). Đổi tên ⇒ đổi luôn nhãn trên mọi khách. */
export const updateContactTagSchema = z
  .object({
    name: tagNameSchema.optional(),
    color: tagColorSchema.optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .refine((v) => v.name !== undefined || v.color !== undefined || v.sortOrder !== undefined, {
    message: 'Không có gì để cập nhật',
  });
export type UpdateContactTagRequest = z.infer<typeof updateContactTagSchema>;

/** POST /contact-tags/reorder (admin): sort_order = vị trí trong `ids`. */
export const reorderContactTagsSchema = z.object({
  ids: z.array(z.uuid()).max(CONTACT_TAGS_MAX),
});
export type ReorderContactTagsRequest = z.infer<typeof reorderContactTagsSchema>;

/** DELETE /contact-tags/:id (admin). */
export interface DeleteContactTagResponse {
  /** Số khách bị gỡ nhãn này. */
  removedFromContacts: number;
}
