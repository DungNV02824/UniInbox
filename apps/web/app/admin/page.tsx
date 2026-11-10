import { redirect } from 'next/navigation';

// Trang mặc định của khu quản trị: Kênh (các mục khác: Chatbot AI, Cài đặt — xem AdminNav).
export default function AdminIndexPage() {
  redirect('/admin/channels');
}
