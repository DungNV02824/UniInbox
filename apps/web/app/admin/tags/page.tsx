import type { Metadata } from 'next';
import { TagsAdmin } from '@/components/admin/tags/tags-admin';

export const metadata: Metadata = { title: 'Nhãn khách' };

export default function TagsPage() {
  return <TagsAdmin />;
}
