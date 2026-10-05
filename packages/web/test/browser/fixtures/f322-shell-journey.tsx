import { createRoot } from 'react-dom/client';
import { AppShell } from '@/components/AppShell';
import { ChatContainerHeader } from '@/components/ChatContainerHeader';
import { SettingsShell } from '@/components/settings/SettingsShell';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import { useChatStore } from '@/stores/chatStore';
import { useConciergeStore } from '@/stores/conciergeStore';
import { useSidebarStore } from '@/stores/sidebarStore';
import { usePathname } from './f322-shell-navigation';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/shell-v2.css';

primeCoCreatorConfigCache({
  name: 'Fixture Owner',
  aliases: [],
  mentionPatterns: ['@fixture-owner'],
  color: { primary: '#555555', secondary: '#eeeeee' },
});
useChatStore.setState({ currentThreadId: 'thread-return' });
useConciergeStore.setState({ configLoaded: true, enabled: true, muted: false, surfaceState: 'collapsed' });

/**
 * The real v2 conversation header with the same store wiring ChatContainer gives it (ChatContainer itself is not mounted:
 * its chat surface is another owner's). The Workspace toggle mirrors ChatContainer's inline handler: close = exit the
 * panel through the store's `closeRightPanel`, open = workspace mode + visible.
 */
function JourneyHeader({ threadId }: { threadId: string }) {
  const sidebarOpen = useSidebarStore((state) => state.isOpen);
  const toggleSidebar = useSidebarStore((state) => state.toggle);
  const rightPanelOpen = useChatStore((state) => state.rightPanelOpen);
  const rightPanelMode = useChatStore((state) => state.rightPanelMode);
  const setRightPanelMode = useChatStore((state) => state.setRightPanelMode);
  const setRightPanelOpen = useChatStore((state) => state.setRightPanelOpen);
  const closeRightPanel = useChatStore((state) => state.closeRightPanel);
  const workspaceOpen = rightPanelOpen && rightPanelMode === 'workspace';
  return (
    <ChatContainerHeader
      sidebarOpen={sidebarOpen}
      onToggleSidebar={toggleSidebar}
      threadId={threadId}
      viewMode="single"
      onToggleViewMode={() => undefined}
      statusPanelOpen={workspaceOpen}
      onToggleStatusPanel={() => {
        if (workspaceOpen) {
          closeRightPanel();
        } else {
          setRightPanelMode('workspace');
          setRightPanelOpen(true);
        }
      }}
    />
  );
}

function ShellJourney() {
  const pathname = usePathname();
  const mode = useChatStore((state) => state.workspaceMode);
  return (
    <AppShell>
      <main style={{ flex: 1, minWidth: 0 }}>
        {pathname === '/settings' ? (
          <SettingsShell />
        ) : (
          <>
            {pathname.startsWith('/thread/') ? <JourneyHeader threadId={pathname.slice('/thread/'.length)} /> : null}
            <div data-testid="conversation" data-path={pathname}>
              原对话
            </div>
          </>
        )}
        <output data-testid="workspace-mode">{mode}</output>
      </main>
    </AppShell>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing shell journey fixture root');
createRoot(root).render(<ShellJourney />);
