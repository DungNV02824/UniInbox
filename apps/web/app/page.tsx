import { redirect } from 'next/navigation';

// Trang gốc chuyển thẳng tới hộp thư; /inbox tự chuyển về /login nếu chưa đăng nhập.
export default function HomePage() {
  redirect('/inbox');
}
