import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { ChatVoiceFeatureControls } from './ChatVoiceFeatureControls';
import { ExportButton } from './ExportButton';
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
  onOpenMobileStatus: () => void;
  statusPanelOpen: boolean;
  onToggleStatusPanel: () => void;
  /** F092: Default cat for voice companion */
  defaultCatId: string;
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
  onOpenMobileStatus,
  statusPanelOpen,
  onToggleStatusPanel,
  defaultCatId,
}: ChatContainerHeaderProps) {
  return (
    <header className="safe-area-top">
      <div className="px-5 py-3 flex items-center gap-2">
        <button
          onClick={onToggleSidebar}
          className="p-1 rounded-lg hover:bg-[var(--console-hover-bg)] transition-colors mr-1"
          title={sidebarOpen ? '收起侧栏' : '展开侧栏'}
          aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        >
          <svg className="w-5 h-5 text-cafe-secondary" viewBox="0 0 20 20" fill="currentColor">
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
        <ExportButton threadId={threadId} />
        <ChatVoiceFeatureControls threadId={threadId} defaultCatId={defaultCatId} />
        {authPendingCount > 0 && (
          <span
            className="inline-flex items-center justify-center h-5 min-w-[20px] px-1 rounded-full bg-conn-amber-bg text-conn-amber-text text-micro font-bold animate-pulse-subtle"
            title={`${authPendingCount} 个授权请求等待处理`}
          >
            🔐 {authPendingCount}
          </span>
        )}
        {/* Mobile/tablet: status sheet trigger */}
        <button
          onClick={onOpenMobileStatus}
          className="p-1 rounded-lg hover:bg-[var(--console-hover-bg)] transition-colors ml-1 lg:hidden"
          title="打开状态面板"
          aria-label="打开状态面板"
        >
          <svg className="w-5 h-5 text-cafe-secondary" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
              clipRule="evenodd"
            />
          </svg>
        </button>
        {/* F232 AC-A8: 单一 panel 开关（桌面 lg:block）；mode 切换从底部工具栏图标触发。
            P2-2：右侧 panel desktop-only，小屏走 MobileStatusSheet。 */}
        <PanelToggle onToggleStatusPanel={onToggleStatusPanel} statusPanelOpen={statusPanelOpen} />
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

// ThreadIndicator extracted to ./ThreadIndicator.tsx (inline title editing).
// Brand: INTERNAL_BASENAMES ('cat-cafe', 'cat-cafe-runtime') now live in ThreadIndicator.tsx.
// Re-export for backward compat (tests, other consumers)
export { ThreadIndicator, tailTruncate } from './ThreadIndicator';

/**
 * F232 AC-A8: 单一 panel 开关。原 F099 RightPanelToggle + F232 ArtifactsToggle
 * 收敛成一个 toggle——mode 切换从底部工具栏图标触发。桌面 lg:block，小屏走 MobileStatusSheet。
 */
function PanelToggle({
  onToggleStatusPanel,
  statusPanelOpen,
}: {
  onToggleStatusPanel: () => void;
  statusPanelOpen: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggleStatusPanel}
      className={`p-1 rounded-lg transition-colors ml-1 hidden lg:block ${
        statusPanelOpen ? 'text-cafe-accent' : 'text-cafe-secondary hover:text-cafe-accent'
      }`}
      aria-label={statusPanelOpen ? '收起面板' : '打开面板'}
      title={statusPanelOpen ? '收起面板' : '打开面板'}
    >
      <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
        <path
          fillRule="evenodd"
          d="M3 4a1 1 0 011-1h12a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V4zm2 0v12h10V4H5z"
          clipRule="evenodd"
        />
        {statusPanelOpen && <rect x="12" y="4" width="4" height="12" rx="0.5" opacity="0.3" />}
      </svg>
    </button>
  );
}
