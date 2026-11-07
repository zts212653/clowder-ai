import { createRoot } from 'react-dom/client';
import { NewConversationPage } from '@/components/new-conversation/NewConversationPage';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { F307ExperienceWorkbench } from '@/components/workbench/F307ExperienceWorkbench';
import { useChatStore } from '@/stores/chatStore';
import { observeApiSessionOwner } from '@/utils/api-session-identity';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/shell-v2.css';

const mode = new URLSearchParams(location.search).get('mode');
writeShellPresentation('v2');
writeShellLanguage('zh');
document.documentElement.dataset.shell = 'v2';
observeApiSessionOwner('issue1864-owner');
useChatStore.getState().setCurrentThread('default');
if (mode === 'works') useChatStore.getState().setWorkspaceMode('artifacts');
const noop = () => {};
function Host() {
  const foreground = useChatStore((state) => state.workspaceForegroundSurfaceId);
  const request = useChatStore((state) => state.workspaceOpenRequest);
  const open = useChatStore((state) => state.rightPanelOpen);
  return (
    <div style={{ display: 'flex', height: '100dvh', width: '100vw' }}>
      {mode === 'home' && (
        <div style={{ flex: 1, overflow: 'auto', minWidth: 0 }}>
          <NewConversationPage
            sidebarOpen
            statusPanelOpen={Boolean(foreground)}
            hasWorkspaceActivity={false}
            onToggleSidebar={noop}
            onToggleStatusPanel={noop}
            onNavigate={noop}
          />
        </div>
      )}
      <div style={{ width: mode === 'home' ? (open ? '50%' : 0) : '100%', minHeight: 0 }}>
        <F307ExperienceWorkbench
          foregroundSurfaceId={foreground}
          threadId="default"
          visible={open}
          workspaceOpenRequest={request}
          onWorkspaceOpenRequestConsumed={useChatStore.getState().consumeWorkspaceOpenRequest}
          onSelectDevSurface={noop}
          onOpenAppRoute={noop}
          worktreeId={null}
          openFilePath={null}
          preview={{ path: '/' }}
        />
      </div>
    </div>
  );
}
function incoming(material: boolean) {
  useChatStore.getState().addMessageToThread('default', {
    id: material ? 'material' : 'plain',
    from: { kind: 'agent', catId: 'codex61-sol' },
    type: 'assistant',
    catId: 'codex61-sol',
    content: 'fixture chat',
    timestamp: Date.now(),
    ...(material
      ? {
          extra: {
            rich: {
              v: 1,
              blocks: [{ kind: 'file', v: 1, id: 'material', url: '/uploads/new.pdf', fileName: 'New work.pdf' }],
            },
          },
        }
      : {}),
  });
}
Object.assign(window, {
  probe: {
    plain: () => incoming(false),
    hide: () => useChatStore.getState().closeRightPanel(),
    show: () => useChatStore.getState().setWorkspaceMode('artifacts'),
    revoke: () =>
      window.dispatchEvent(
        new CustomEvent('cat-cafe:entrusted-work-projection-invalidated', { detail: { reason: 'access_revoked' } }),
      ),
    material: () => incoming(true),
    invalidate: () => window.dispatchEvent(new CustomEvent('cat-cafe:entrusted-work-projection-invalidated')),
  },
});
createRoot(document.getElementById('root')!).render(<Host />);
