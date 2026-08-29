'use client';

import { ChatMessage } from '@/components/ChatMessage';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';

const MESSAGE_ID = 'f294-long-message-export-fixture';
const paragraphs = Array.from({ length: 140 }, (_, index) =>
  index === 139 ? 'EXPORT_LONG_MESSAGE_BOTTOM_SENTINEL' : `Long export paragraph ${index + 1}`,
);

const message: ChatMessageType = {
  id: MESSAGE_ID,
  type: 'assistant',
  catId: 'fable-5',
  content: paragraphs.join('\n\n'),
  timestamp: Date.UTC(2026, 7, 27, 3, 38),
};

export default function LongMessageExportFixture() {
  return (
    <main data-export-root data-export-ready="true" className="mx-auto min-h-screen max-w-4xl p-4">
      <style>{`
        [data-long-message-export-fixture] .markdown-content > p:last-child {
          min-height: 80px;
          background: rgb(255, 0, 255);
        }
      `}</style>
      <h1 className="mb-4 text-lg font-semibold text-cafe-primary">F294 long message export fixture</h1>
      <div data-long-message-export-fixture>
        <ChatMessage message={message} threadId="thread-f294-long-export" getCatById={() => undefined} />
      </div>
    </main>
  );
}
