import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MarkdownContent } from '@/components/MarkdownContent';
import { useChatStore } from '@/stores/chatStore';
import '../../../src/app/globals.css';

const threadId = 'reference-demand-browser';
useChatStore.setState({ currentThreadId: threadId });
const history = Array.from({ length: 192 }, (_, index) => `Read docs/history-${index}.md .`).join('\n\n');

function Conversation() {
  const [revision, setRevision] = useState(0);
  return (
    <main>
      <button type="button" onClick={() => setRevision((value) => value + 1)}>
        Stream
      </button>
      <div data-chat-container style={{ height: 520, overflowY: 'auto' }}>
        <section data-visible>
          <MarkdownContent
            referenceThreadId={threadId}
            content={`Read docs/visible.md and owner/repo . Revision ${revision}`}
          />
        </section>
        <div style={{ height: 1800 }} />
        <section data-history>
          <MarkdownContent referenceThreadId={threadId} content={history} />
        </section>
        <div style={{ height: 800 }} />
      </div>
    </main>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('Browser proof root missing');
createRoot(container).render(<Conversation />);
