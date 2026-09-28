import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SchedulePanel } from '@/components/workspace/SchedulePanel';
import { WorkspaceNowSurface } from '@/components/workspace/WorkspaceNowSurface';
import { useActiveExecutionProjection } from '@/hooks/useActiveExecutionProjection';
import { useChatStore } from '@/stores/chatStore';

const threads = ['thread-a', 'thread-b', 'thread-other'].map((id) => ({
  id,
  title: id,
  projectPath: id === 'thread-other' ? '/other' : '/fixture',
  createdAt: 1,
  createdBy: 'fixture-owner',
  participants: [],
  lastActiveAt: 1,
}));
useChatStore.setState({ threads, currentThreadId: 'thread-a' });

function NavigationProof() {
  const [threadId, setThreadId] = useState('thread-a');
  useActiveExecutionProjection(threadId, false);
  return (
    <main data-thread={threadId}>
      <nav>
        {threads.map(({ id }) => (
          <button
            type="button"
            key={id}
            onClick={() => {
              useChatStore.setState({ currentThreadId: id });
              setThreadId(id);
            }}
          >
            {id}
          </button>
        ))}
      </nav>
      <WorkspaceNowSurface />
      <SchedulePanel />
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing browser fixture root');
createRoot(root).render(<NavigationProof />);
