import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { CatCafeLogo } from './icons/CatCafeLogo';
import { ThreadCatPill } from './ThreadCatPill';
import { ThreadIndicator } from './ThreadIndicator';

interface ChatContainerHeaderProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  threadId: string;
  authPendingCount: number;
  viewMode: 'single' | 'split';
  onToggleViewMode: () => void;
  statusPanelOpen: boolean;
  onToggleStatusPanel: () => void;
  hasWorkspaceActivity?: boolean;
}

export function ChatContainerHeader({
  sidebarOpen,
  onToggleSidebar,
  threadId,
  authPendingCount,
  // F099/OQ-4: viewMode toggle hidden — candidate for removal (KD-7)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  viewMode: _viewMode,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onToggleViewMode: _onToggleViewMode,
  statusPanelOpen,
  onToggleStatusPanel,
  hasWorkspaceActivity = false,
}: ChatContainerHeaderProps) {
  return (
    <header className="safe-area-top">
      <div className="px-5 py-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleSidebar}
          className="p-1 rounded-lg hover:bg-[var(--console-hover-bg)] transition-colors mr-1"
          title={sidebarOpen ? '收起侧栏' : '展开侧栏'}
          aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        >
          <svg aria-hidden="true" className="w-5 h-5 text-cafe-secondary" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z"
              clipRule="evenodd"
            />
          </svg>
        </button>
        <CatCafeLogo className="h-16 w-auto -my-3" />
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold text-cafe-black">Clowder AI</h1>
          <div className="flex items-center gap-2 min-w-0">
            <ThreadIndicator threadId={threadId} />
            {/* F198 Phase C AC-C5: Daemon active indicator */}
            <DaemonActiveIndicator threadId={threadId} />
            {/* F154 Phase B: Preferred cat pill — desktop only (KD-10) */}
            <div className="hidden lg:block flex-shrink-0">
              <ThreadCatPill threadId={threadId} />
            </div>
          </div>
        </div>
        {authPendingCount > 0 && (
          <span
            className="inline-flex items-center justify-center h-5 min-w-[20px] px-1 rounded-full bg-conn-amber-bg text-conn-amber-text text-micro font-bold animate-pulse-subtle"
            title={`${authPendingCount} 个授权请求等待处理`}
          >
            🔐 {authPendingCount}
          </span>
        )}
        {/* F284: one stable recall entry; activity stays a badge, not a second header capability. */}
        <PanelToggle
          onToggleStatusPanel={onToggleStatusPanel}
          statusPanelOpen={statusPanelOpen}
          hasWorkspaceActivity={hasWorkspaceActivity}
        />
      </div>
    </header>
  );
}

/** F198 Phase C AC-C5: shows amber pill when a bg carrier daemon is running for this thread.
 *  Clicking it navigates to the Settings ops tab. */
function DaemonActiveIndicator({ threadId }: { threadId: string }) {
  const [daemonShortId, setDaemonShortId] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await apiFetch(`/api/threads/${threadId}/active-pane`);
        if (cancelled) return;
        if (res.ok) {
          const body = (await res.json()) as { active?: boolean; daemonShortId?: string };
          setDaemonShortId(body.daemonShortId ?? null);
        } else {
          setDaemonShortId(null);
        }
      } catch {
        if (!cancelled) setDaemonShortId(null);
      }
    };
    void check();
    const timer = setInterval(() => void check(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [threadId]);

  if (!daemonShortId) return null;

  return (
    <button
      type="button"
      onClick={() => router.push('/settings?s=ops&ops=agent-sessions')}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-micro font-mono text-conn-amber-text bg-conn-amber-bg hover:opacity-80 transition-colors flex-shrink-0"
      title={`Daemon ${daemonShortId} 运行中 · 点击查看后台会话`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-conn-amber-text animate-pulse" />
      {daemonShortId}
    </button>
  );
}

// Brand Guard: INTERNAL_BASENAMES ('cat-cafe', 'cat-cafe-runtime') now live in ThreadIndicator.tsx.
// Re-export for existing tests and consumers that import from the header module.
export { ThreadIndicator, tailTruncate } from './ThreadIndicator';

/**
 * F284 stable Workspace entry. The Launcher owns capability discovery; this
 * borderless control only recalls the contextual work surface.
 */
export function PanelToggle({
  onToggleStatusPanel,
  statusPanelOpen,
  hasWorkspaceActivity = false,
}: {
  onToggleStatusPanel: () => void;
  statusPanelOpen: boolean;
  hasWorkspaceActivity?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggleStatusPanel}
      className={`relative ml-1 inline-flex h-8 w-8 items-center justify-center rounded-full bg-transparent transition-colors ${
        statusPanelOpen
          ? 'text-cafe-accent'
          : 'text-cafe-secondary hover:bg-[var(--console-hover-bg)] hover:text-cafe-accent'
      }`}
      aria-label={statusPanelOpen ? '收起 Workspace' : '打开 Workspace'}
      title={statusPanelOpen ? '收起 Workspace' : '打开 Workspace'}
      data-testid="workspace-panel-toggle"
    >
      <svg
        aria-hidden="true"
        className="h-4 w-4"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V4A1.5 1.5 0 0 1 4 2.5Z" />
        <path d="M10.5 2.5v11M7.5 6 5.5 8l2 2" />
      </svg>
      {hasWorkspaceActivity && (
        <span
          className="absolute right-1 top-1 h-2 w-2 rounded-full border-2 border-[var(--console-card-bg)] bg-[var(--semantic-success)]"
          aria-hidden="true"
          data-testid="workspace-activity-badge"
        />
      )}
    </button>
  );
}
