import type { Metadata } from 'next';
import { ChatbotEditorPage } from '@/components/admin/chatbots/chatbot-editor';

export const metadata: Metadata = { title: 'Sửa chatbot' };

export default async function EditChatbotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ChatbotEditorPage id={id} />;
}
