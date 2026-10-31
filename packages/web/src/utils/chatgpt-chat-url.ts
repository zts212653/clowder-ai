const CHATGPT_CONVERSATION_URL = /^https:\/\/chatgpt\.com\/c\/([a-zA-Z0-9-]+)\/?$/;

export function parseChatGptConversationUrl(chatUrl: unknown): { chatUrl: string; conversationId: string } | null {
  if (typeof chatUrl !== 'string') return null;
  const match = CHATGPT_CONVERSATION_URL.exec(chatUrl);
  if (!match) return null;
  return { chatUrl, conversationId: match[1] };
}
