import type { ChatMessage, WorkspaceOpenRequest } from '@/stores/chat-types';

/** Generic image names become a traceable caption only when the original message is available. */
export function workspaceEntryTitle(
  target: WorkspaceOpenRequest['target'],
  messages: ChatMessage[],
  catName: (id: string) => string,
  imageLabel: string,
): string | null {
  if (!('title' in target) || !/^(generated image|image|图片)$/i.test(target.title.trim())) return null;
  const source =
    target.kind === 'message-publication'
      ? target.source
      : target.kind === 'publication'
        ? target.messagePublicationSource
        : null;
  if (!source) return null;
  const message = messages.find((item) => item.id === source.messageId);
  if (!message?.catId || !Number.isFinite(message.timestamp)) return null;
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${target.title.toLowerCase() === 'generated image' ? imageLabel : target.title} · ${catName(message.catId)} ${time}`;
}
