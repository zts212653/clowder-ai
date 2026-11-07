import { createRoot } from 'react-dom/client';
import { ChatReferenceScope } from '@/components/chat-references/ChatReferenceScope';
import { MarkdownContent } from '@/components/MarkdownContent';
import { MessageActions } from '@/components/MessageActions';
import { NativeReplyText } from '@/components/reply-layers/NativeReplyText';
import type { CatData } from '@/hooks/useCatData';
import { refreshMentionData } from '@/lib/mention-highlight';
import type { Thread } from '@/stores/chat-types';
import { type ChatMessage, useChatStore } from '@/stores/chatStore';
import '@/app/globals.css';

const data = JSON.parse(document.getElementById('fixture')?.textContent ?? '{}') as {
  source: Thread;
  target: Thread;
  messages: ChatMessage[];
  cats: CatData[];
  nativeStart: number;
  nativeMessageIds: string[];
};
useChatStore.setState({ currentThreadId: data.source.id, threads: [data.source, data.target] });
refreshMentionData(data.cats);

const root = document.getElementById('root');
if (!root) throw new Error('Missing reference quote fixture root');
createRoot(root).render(
  <ChatReferenceScope value={data.source.id}>
    <main style={{ maxWidth: 780, margin: '40px auto', padding: 24 }}>
      {data.messages.map((message, index) => (
        <article key={message.id} data-specimen={index} style={{ marginBottom: 48 }}>
          <MessageActions threadId={data.source.id} message={message}>
            <header data-quote-exclude style={{ height: 40 }}>
              Source message
            </header>
            <section data-select-source>
              {data.nativeMessageIds.includes(message.id) ? (
                <NativeReplyText
                  run={{
                    kind: 'text',
                    id: 'answer',
                    text: message.content.slice(data.nativeStart),
                    start: data.nativeStart,
                    end: message.content.length,
                  }}
                />
              ) : (
                <MarkdownContent content={message.content} referenceThreadId={data.source.id} />
              )}
            </section>
          </MessageActions>
        </article>
      ))}
    </main>
  </ChatReferenceScope>,
);
