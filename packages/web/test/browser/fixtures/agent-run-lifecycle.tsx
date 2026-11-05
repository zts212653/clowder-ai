import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { useF307ExperienceWorkbenchStore as store } from '@/components/workbench/experience-workbench-store';
import { F307ExperienceWorkbench } from '@/components/workbench/F307ExperienceWorkbench';
import { createAgentRunSurface } from '@/components/workbench/real-surface-adapters';
import { useChatStore } from '@/stores/chatStore';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/console-controls.css';
import '@/app/globals.css';

writeShellPresentation('classic');
useChatStore.setState({ currentThreadId: 'lifecycle-thread' });
store.getState().hydrate();
if (!localStorage.getItem('lifecycle-seeded')) {
  store.getState().dispatch({
    type: 'open-surface',
    surface: createAgentRunSurface({ invocationId: 'lifecycle-invocation', threadId: 'lifecycle-thread' }),
    entitlement: { kind: 'user', reason: 'workspace-home-selection' },
  });
  localStorage.setItem('lifecycle-seeded', 'true');
}

function Host() {
  const [pulse, setPulse] = useState(0);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = setInterval(() => setPulse((n) => n + 1), 200);
    return () => clearInterval(timer);
  }, []);
  return (
    <main style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <button type="button" data-testid="fixture-visibility" onClick={() => setVisible((value) => !value)}>
        Toggle host
      </button>
      <output data-testid="fixture-pulse">{pulse}</output>
      <F307ExperienceWorkbench
        threadId="lifecycle-thread"
        onSelectDevSurface={() => undefined}
        onOpenAppRoute={(href) => window.location.assign(href)}
        visible={visible}
        worktreeId="lifecycle-worktree"
        openFilePath={null}
        preview={{ path: '/' }}
        statusSurface={<span>{pulse}</span>}
      />
    </main>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Fixture root is missing');
createRoot(root).render(<Host />);
