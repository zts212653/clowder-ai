import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { createRoot } from 'react-dom/client';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/console-controls.css';
import '@/app/globals.css';
import { HomeActionHost } from '@/components/concierge/HomeActionHost';
import workspaceStyles from '@/components/content-review/review-workspace.module.css';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { F307ExperienceWorkbench } from '@/components/workbench/F307ExperienceWorkbench';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

const fixture = (window as unknown as { __F317_WORK__: { threadId: string } }).__F317_WORK__;
useChatStore.setState({ currentThreadId: fixture.threadId, pendingChatInsert: null });
const router = {
  push: (href: string) => window.history.pushState({}, '', href),
  replace: (href: string) => window.history.replaceState({}, '', href),
  back: () => window.history.back(),
  forward: () => window.history.forward(),
  refresh: () => {},
  prefetch: async () => {},
};
function Hub() {
  const request = useChatStore((state) => state.workspaceOpenRequest);
  const consume = useChatStore((state) => state.consumeWorkspaceOpenRequest);
  const layout = useF307ExperienceWorkbenchStore((state) => state.layout);
  return (
    <AppRouterContext.Provider value={router}>
      <main data-thread-id={fixture.threadId} style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <HomeActionHost />
        <nav>
          <button
            type="button"
            onClick={() =>
              void apiFetch('/fixture/work/open', { method: 'POST', body: '{}' })
                .then((r) => r.json())
                .then((value) => {
                  const node = document.getElementById('outcome');
                  if (node) node.textContent = JSON.stringify(value);
                })
            }
          >
            Open the original work card
          </button>
          <button
            type="button"
            onClick={() => {
              const workspace = document.querySelector<HTMLElement>(`.${workspaceStyles.workspace}`);
              if (workspace) workspace.dataset.comparing = workspace.dataset.comparing === 'true' ? 'false' : 'true';
            }}
          >
            Toggle original comparison
          </button>
          <output id="outcome" />
        </nav>
        <F307ExperienceWorkbench
          threadId={fixture.threadId}
          defaultCatId="codex-astra"
          foregroundSurfaceId={layout.activeSurfaceId}
          worktreeId={null}
          openFilePath={null}
          preview={{ path: '/' }}
          onSelectDevSurface={() => {}}
          onOpenAppRoute={router.push}
          workspaceOpenRequest={request}
          onWorkspaceOpenRequestConsumed={consume}
        />
      </main>
    </AppRouterContext.Provider>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Owned integration root required');
createRoot(root).render(<Hub />);
