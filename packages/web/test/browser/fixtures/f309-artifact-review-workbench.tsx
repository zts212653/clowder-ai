import { createRoot } from 'react-dom/client';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/console-controls.css';
import '@/app/globals.css';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { F307ExperienceWorkbench } from '@/components/workbench/F307ExperienceWorkbench';
import { createWorkspaceModeSurface } from '@/components/workbench/real-surface-adapters';
import { useSocket } from '@/hooks/useSocket';
import { useChatStore } from '@/stores/chatStore';

const fixture = (window as unknown as { __F309_FIXTURE__: { threadId: string } }).__F309_FIXTURE__;
useChatStore.setState({ currentThreadId: fixture.threadId });
const workbench = useF307ExperienceWorkbenchStore.getState();
workbench.hydrate();
if (useF307ExperienceWorkbenchStore.getState().layout.surfaces.length === 0)
  workbench.dispatch({
    type: 'open-surface',
    surface: createWorkspaceModeSurface(
      new URLSearchParams(location.search).get('mode') === 'needs-me' ? 'needs-me' : 'product-schedule',
      fixture.threadId,
    ),
    entitlement: { kind: 'user', reason: 'workspace-home-selection' },
  });
function ReviewHost() {
  const { socketConnected } = useSocket({ onMessage: () => undefined });
  return (
    <main style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column' }}>
      <span hidden data-testid="review-host-socket" data-connected={socketConnected} />
      <F307ExperienceWorkbench
        threadId={fixture.threadId}
        defaultCatId="codex-astra"
        worktreeId={null}
        openFilePath={null}
        preview={{ path: '/' }}
        onSelectDevSurface={() => undefined}
      />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<ReviewHost />);
