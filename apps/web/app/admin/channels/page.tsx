import type { Metadata } from 'next';
import { ChannelsAdmin } from '@/components/admin/channels-admin';

export const metadata: Metadata = { title: 'Kênh' };

export default function ChannelsPage() {
  return <ChannelsAdmin />;
}
