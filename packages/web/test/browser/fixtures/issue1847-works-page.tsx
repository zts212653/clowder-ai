import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app/globals.css';
import { ThreadWorksPanelV2 } from '@/components/artifacts/ThreadWorksPanelV2';
import { ThreadWorksButton } from '@/components/shell/HeaderCounts';
import { HomeWorksSummary } from '@/components/workspace-home/HomeWorksSummary';
import { useChatStore } from '@/stores/chatStore';
import { observeApiSessionOwner } from '@/utils/api-session-identity';

observeApiSessionOwner('owner');
useChatStore.setState({ currentThreadId: 'works-a', messages: [], threadStates: {}, hasActiveInvocation: false });
function Proof() {
  const [thread, setThread] = useState('works-a');
  return (
    <main>
      <button
        type="button"
        onClick={() => {
          useChatStore.getState().setThreadHasActiveInvocation(thread, true);
          useChatStore.getState().addMessageToThread(thread, {
            id: 'stream',
            type: 'assistant',
            catId: 'codex',
            content: '',
            isStreaming: true,
            timestamp: 1,
          });
          Array.from({ length: 20 }, (_, i) =>
            useChatStore.getState().patchThreadMessage(thread, 'stream', { content: `token ${i}`, timestamp: i + 2 }),
          );
        }}
      >
        Stream text
      </button>
      <button type="button" onClick={() => useChatStore.getState().setThreadMessageStreaming(thread, 'stream', false)}>
        Finish message
      </button>
      <button type="button" onClick={() => useChatStore.getState().setThreadHasActiveInvocation(thread, false)}>
        Finish invocation
      </button>
      <button
        type="button"
        onClick={() =>
          window.dispatchEvent(
            new CustomEvent('cat-cafe:artifact-review-changed', {
              detail: { reviewId: 'another-review' },
            }),
          )
        }
      >
        Review elsewhere
      </button>
      <button
        type="button"
        onClick={() =>
          useChatStore.getState().appendRichBlockToThread(thread, 'stream', {
            id: 'new-work',
            kind: 'file',
            v: 1,
            fileName: 'New work.md',
            url: '/uploads/new.md',
          })
        }
      >
        Publish work
      </button>
      <button
        type="button"
        onClick={() => {
          useChatStore.setState({ currentThreadId: 'works-b', messages: [], threadStates: {} });
          setThread('works-b');
        }}
      >
        Switch thread
      </button>
      <button
        type="button"
        onClick={() =>
          window.dispatchEvent(
            new CustomEvent('cat-cafe:entrusted-work-projection-invalidated', { detail: { threadId: 'works-a' } }),
          )
        }
      >
        Old thread changed
      </button>
      <ThreadWorksButton threadId={thread} />
      <ThreadWorksPanelV2 threadId={thread} />
      <HomeWorksSummary threadId={thread} worktreeId={null} onSelectDestination={() => undefined} />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Proof />);
