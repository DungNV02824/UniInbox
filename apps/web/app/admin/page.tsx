import { redirect } from 'next/navigation';

// Giai đoạn 1A mới có trang Kênh.
export default function AdminIndexPage() {
  redirect('/admin/channels');
}
