import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from '@/components/AppShell';
import { ChatContainerHeader } from '@/components/ChatContainerHeader';
import { SettingsShell } from '@/components/settings/SettingsShell';
import { MailboxApprovalEntry } from '@/components/shell/mailbox/MailboxApprovalEntry';
import { WorkspaceSurfaceVisibilityProvider } from '@/components/workbench/WorkspaceSurfaceVisibility';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import { useChatStore } from '@/stores/chatStore';
import { useConciergeStore } from '@/stores/conciergeStore';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { useSidebarStore } from '@/stores/sidebarStore';
import { usePathname, useRouter } from './f322-shell-navigation';
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
const participantCount = (window as Window & { __F322_PARTICIPANT_COUNT__?: number }).__F322_PARTICIPANT_COUNT__ ?? 2;
const fixtureParticipants = Array.from({ length: participantCount }, (_, index) => {
  if (index === 0) return 'opus';
  if (index === 1) return 'glm52';
  return `cat-${index + 1}`;
});
useSidebarProjectionStore.setState({
  appliedGeneration: 1,
  hasCanonicalSnapshot: true,
  rows: [
    {
      id: 'thread-return',
      title: '返回原处的对话',
      participants: fixtureParticipants,
      pinned: false,
      favorited: false,
      labels: [],
      preferredCats: [],
      projectPath: '/work/fixture',
      lastActiveAt: 1,
      systemKind: null,
      isHubThread: false,
      unreadCount: 0,
      hasUserMention: false,
      presence: { status: 'idle' },
    },
  ],
});

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
      onOpenMessageSearch={() => undefined}
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

// F307 retains hidden owners and restores them on a route mount. The shell and approval entry below are real;
// this bounded host supplies the same visibility contract without mounting unrelated Workspace domains.
function RetainedApprovalProof({ pathname }: { pathname: string }) {
  const [visible, setVisible] = useState(false);
  const router = useRouter();
  return (
    <>
      <button type="button" onClick={() => router.push('/memory?from=thread-return')}>
        Proof: memory
      </button>
      <button type="button" onClick={() => router.push('/thread/thread-return?proof=other')}>
        Proof: thread
      </button>
      <button type="button" onClick={() => setVisible(true)}>
        Proof: restore visible approval
      </button>
      <div hidden={!visible}>
        <WorkspaceSurfaceVisibilityProvider visible={visible}>
          <MailboxApprovalEntry key={pathname} proposalId={null} />
        </WorkspaceSurfaceVisibilityProvider>
      </div>
    </>
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
        {(window as Window & { __F322_RETAINED_APPROVAL__?: boolean }).__F322_RETAINED_APPROVAL__ ? (
          <RetainedApprovalProof pathname={pathname} />
        ) : null}
      </main>
    </AppShell>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing shell journey fixture root');
createRoot(root).render(<ShellJourney />);
