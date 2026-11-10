import type { Metadata } from 'next';
import { SettingsAdmin } from '@/components/admin/settings/settings-admin';

export const metadata: Metadata = { title: 'Cài đặt' };

export default function SettingsPage() {
  return <SettingsAdmin />;
}
