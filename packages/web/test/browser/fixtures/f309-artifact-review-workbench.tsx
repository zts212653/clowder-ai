import { createRoot } from 'react-dom/client';
import { ChatInput } from '@/components/ChatInput';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/console-controls.css';
import '@/app/globals.css';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { F307ExperienceWorkbench } from '@/components/workbench/F307ExperienceWorkbench';
import { createWorkspaceModeSurface } from '@/components/workbench/real-surface-adapters';
import { useSocket } from '@/hooks/useSocket';
import { useChatStore } from '@/stores/chatStore';

const fixture = (window as unknown as { __F309_FIXTURE__: { threadId: string; mediaType: string } }).__F309_FIXTURE__;
if (new URLSearchParams(location.search).get('shell') === 'v2') {
  writeShellPresentation('v2');
  document.documentElement.dataset.shell = 'v2';
}
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
  const fullWindow = useF307ExperienceWorkbenchStore(
    (state) => state.artifactWorkPresentation.session?.mode === 'full-window',
  );
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
        onOpenAppRoute={(href) => window.location.assign(href)}
        artifactWorkHostAvailable={fixture.mediaType === 'image/png'}
      />
      {fixture.mediaType === 'image/png' ? (
        <div hidden={fullWindow} className="shrink-0" data-testid="review-host-chat">
          <ChatInput threadId={fixture.threadId} onSend={() => false} />
        </div>
      ) : null}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<ReviewHost />);
