import { useChatStore } from '@/stores/chatStore';
import { ExportButton } from './ExportButton';
import { ThemeToggle } from './ThemeToggle';
import { VoiceCompanionButton } from './VoiceCompanionButton';

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
      <div className="h-[54px] px-6 flex items-center gap-2.5">
        <button
          onClick={onToggleSidebar}
          className="p-1 rounded-md hover:bg-[var(--console-hover-bg)] transition-colors md:hidden"
          title={sidebarOpen ? '收起侧栏' : '展开侧栏'}
          aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        >
          <svg className="w-4 h-4 text-cafe-secondary" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z"
              clipRule="evenodd"
            />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <ThreadIndicator threadId={threadId} />
        </div>
        <ExportButton threadId={threadId} />
        <VoiceCompanionButton threadId={threadId} defaultCatId={defaultCatId} />
        {authPendingCount > 0 && (
          <span
            className="inline-flex items-center justify-center h-5 min-w-[20px] px-1 rounded-full bg-conn-amber-bg text-conn-amber-text text-[10px] font-bold animate-pulse-subtle"
            title={`${authPendingCount} 个授权请求等待处理`}
          >
            🔐 {authPendingCount}
          </span>
        )}
        {/* F056 Phase D: Theme toggle */}
        <ThemeToggle />
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
        <RightPanelToggle onToggleStatusPanel={onToggleStatusPanel} statusPanelOpen={statusPanelOpen} />
      </div>
    </header>
  );
}

/** Thread indicator: shows which thread you're currently chatting in */
function ThreadIndicator({ threadId }: { threadId: string }) {
  const threads = useChatStore((s) => s.threads);
  const currentThread = threads.find((t) => t.id === threadId);

  if (threadId === 'default') {
    return <p className="text-base font-bold text-cafe truncate min-w-0">大厅</p>;
  }

  const title = currentThread?.title ?? '未命名对话';

  return (
    <p className="text-base font-bold text-cafe truncate min-w-0" title={title}>
      {title}
    </p>
  );
}

/**
 * F099: Pure state-transition logic for the right panel toggle.
 * Exported for testability — the component delegates to this function.
 */
export function rightPanelToggleTransition(
  statusPanelOpen: boolean,
  rightPanelMode: 'status' | 'workspace',
  callbacks: {
    onToggleStatusPanel: () => void;
    setRightPanelMode: (mode: 'status' | 'workspace') => void;
  },
) {
  if (!statusPanelOpen) {
    callbacks.onToggleStatusPanel();
    callbacks.setRightPanelMode('status');
  } else if (rightPanelMode !== 'workspace') {
    callbacks.setRightPanelMode('workspace');
  } else {
    callbacks.onToggleStatusPanel();
    callbacks.setRightPanelMode('status');
  }
}

/** F099: Unified right panel toggle — cycles closed → status → workspace → closed */
function RightPanelToggle({
  onToggleStatusPanel,
  statusPanelOpen,
}: {
  onToggleStatusPanel: () => void;
  statusPanelOpen: boolean;
}) {
  const rightPanelMode = useChatStore((s) => s.rightPanelMode);
  const setRightPanelMode = useChatStore((s) => s.setRightPanelMode);

  const handleClick = () => {
    rightPanelToggleTransition(statusPanelOpen, rightPanelMode, {
      onToggleStatusPanel,
      setRightPanelMode,
    });
  };

  const isWorkspace = rightPanelMode === 'workspace';
  const label = !statusPanelOpen ? '打开面板' : isWorkspace ? '关闭面板' : '工作区';

  return (
    <button
      onClick={handleClick}
      className={`p-1 rounded-lg hover:bg-[var(--console-hover-bg)] transition-colors ml-1 hidden lg:block ${
        statusPanelOpen
          ? isWorkspace
            ? 'bg-[var(--color-cafe-accent)]/5 text-[var(--color-cafe-accent)]'
            : 'bg-cafe-surface-elevated'
          : ''
      }`}
      aria-label={label}
      title={label}
    >
      <svg className="w-5 h-5 text-cafe-secondary" viewBox="0 0 20 20" fill="currentColor">
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
