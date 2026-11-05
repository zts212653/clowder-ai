import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '@/components/ThemeProvider';
import { ThreadChatRuntimeProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { ThreadChatSurface } from '@/components/thread-chat/ThreadChatSurface';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import { useChatStore } from '@/stores/chatStore';
import '@/app/globals.css';

primeCoCreatorConfigCache({ name: 'Test owner', aliases: [], mentionPatterns: [] });
useChatStore.setState({ currentThreadId: 'foreground', currentProjectPath: '/isolated/issue1813' });

function Proof() {
  const [threadId, setThreadId] = useState('foreground');
  return (
    <ThemeProvider>
      <button
        type="button"
        onClick={() => {
          const next = threadId === 'foreground' ? 'background' : 'foreground';
          useChatStore.getState().setCurrentThread(next);
          setThreadId(next);
        }}
      >
        Switch thread
      </button>
      <div style={{ height: 800, display: 'flex', flexDirection: 'column' }}>
        <ThreadChatRuntimeProvider routeThreadId={threadId}>
          <ThreadChatSurface threadId={threadId} density="full" />
        </ThreadChatRuntimeProvider>
      </div>
    </ThemeProvider>
  );
}

Object.assign(window, {
  issue1813State: () => {
    const s = useChatStore.getState();
    return {
      currentThreadId: s.currentThreadId,
      seq: s.lastSeqByThread,
      messages: Object.fromEntries(
        ['foreground', 'background'].map((id) => [
          id,
          s.getThreadState(id).messages.map((m) => ({ id: m.id, content: m.content, isStreaming: m.isStreaming })),
        ]),
      ),
    };
  },
});
const root = document.getElementById('root');
if (root) createRoot(root).render(<Proof />);
