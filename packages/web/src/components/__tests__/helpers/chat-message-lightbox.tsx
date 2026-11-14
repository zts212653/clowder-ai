import { ChatMessage } from '@/components/ChatMessage';
import { ArtworkLightboxHost } from '@/components/content-review/ArtworkLightboxHost';
import { ArtworkLightboxProvider } from '@/components/content-review/ArtworkLightboxScope';
import type { ChatMessage as ChatMessageData } from '@/stores/chat-types';

/** The same media host boundary mounted by ChatContainer, with the real message entry. */
export function ChatMessageLightboxHost({ message }: { message: ChatMessageData }) {
  return (
    <ArtworkLightboxProvider threadId="thread-1">
      <ChatMessage message={message} getCatById={() => undefined} />
      <ArtworkLightboxHost />
    </ArtworkLightboxProvider>
  );
}
