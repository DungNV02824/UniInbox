import type { Metadata } from 'next';
import { ChatbotEditorPage } from '@/components/admin/chatbots/chatbot-editor';

export const metadata: Metadata = { title: 'Tạo chatbot' };

export default function NewChatbotPage() {
  return <ChatbotEditorPage id={null} />;
}
