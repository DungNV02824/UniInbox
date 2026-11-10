import type { Metadata } from 'next';
import { ChatbotsAdmin } from '@/components/admin/chatbots/chatbots-admin';

export const metadata: Metadata = { title: 'Chatbot AI' };

export default function ChatbotsPage() {
  return <ChatbotsAdmin />;
}
