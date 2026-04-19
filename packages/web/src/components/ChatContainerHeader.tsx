import { useChatStore } from '@/stores/chatStore';
import { ExportButton } from './ExportButton';
import { HubButton } from './HubButton';
import { CatCafeLogo } from './icons/CatCafeLogo';
import { ThemeToggle } from './ThemeToggle';
import { ThreadCatPill } from './ThreadCatPill';
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
  const signalInboxHref = `/signals?from=${encodeURIComponent(threadId)}`;

  return (
    <header className="border-b border-cocreator-light bg-cocreator-bg safe-area-top">
      <div className="px-5 py-3 flex items-center gap-2">
        <button
          onClick={onToggleSidebar}
          className="p-1 rounded-lg hover:bg-cocreator-light transition-colors mr-1"
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
            {/* F154 Phase B: Preferred cat pill — desktop only (KD-10) */}
            <div className="hidden lg:block flex-shrink-0">
              <ThreadCatPill threadId={threadId} />
            </div>
          </div>
        </div>
        <ExportButton threadId={threadId} />
        <VoiceCompanionButton threadId={threadId} defaultCatId={defaultCatId} />
        <button
          type="button"
          onClick={() => {
            window.location.assign(signalInboxHref);
          }}
          className="p-1 rounded-lg hover:bg-cocreator-light transition-colors"
          title="Signal Inbox"
          aria-label="Signal Inbox"
        >
          <svg className="w-5 h-5 text-cafe-secondary" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M5.05 3.636a1 1 0 010 1.414 7 7 0 000 9.9 1 1 0 11-1.414 1.414 9 9 0 010-12.728 1 1 0 011.414 0zm9.9 0a9 9 0 010 12.728 1 1 0 01-1.414-1.414 7 7 0 000-9.9 1 1 0 011.414-1.414zM7.879 6.464a1 1 0 010 1.414 3 3 0 000 4.243 1 1 0 11-1.415 1.414 5 5 0 010-7.07 1 1 0 011.415 0zm4.242 0a5 5 0 010 7.072 1 1 0 01-1.415-1.415 3 3 0 000-4.242 1 1 0 011.415-1.415zM10 9a1 1 0 100 2 1 1 0 000-2z"
              clipRule="evenodd"
            />
          </svg>
        </button>
        {authPendingCount > 0 && (
          <span
            className="inline-flex items-center justify-center h-5 min-w-[20px] px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold animate-pulse-subtle"
            title={`${authPendingCount} 个授权请求等待处理`}
          >
            🔐 {authPendingCount}
          </span>
        )}
        {/* F056 Phase D: Theme toggle */}
        <ThemeToggle />
        {/* F099 P1-2: Hub gear in top bar — always reachable even when right panel shows workspace */}
        <HubButton />
        {/* Mobile/tablet: status sheet trigger */}
        <button
          onClick={onOpenMobileStatus}
          className="p-1 rounded-lg hover:bg-cocreator-light transition-colors ml-1 lg:hidden"
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
        {/* F099: Unified right panel toggle (merged workspace + status panel) */}
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
    return <p className="text-xs text-cafe-secondary">大厅 · Your AI team collaboration space</p>;
  }

  const title = currentThread?.title ?? '未命名对话';
  const rawPath = currentThread?.projectPath ?? '';
  // 'default' is a sentinel for threads without a real projectPath — match exact value, not basename
  const rawBasename = rawPath === 'default' ? '' : (rawPath.split(/[/\\]/).pop() ?? '');
  // Map known internal repo basenames to brand name; preserve real project paths for multi-workspace
  const INTERNAL_BASENAMES = ['cat-cafe', 'cat-cafe-runtime', 'clowder-ai'];
  const brandName = process.env.NEXT_PUBLIC_BRAND_NAME ?? '';
  const projectName = INTERNAL_BASENAMES.includes(rawBasename) && brandName ? brandName : rawBasename;

  return (
    <p
      className="text-xs text-cafe-secondary truncate min-w-0"
      title={`${title}${projectName ? ` · ${projectName}` : ''}`}
    >
      <span className="font-medium text-cafe-secondary">{title}</span>
      {projectName && <span className="text-cafe-muted"> · {projectName}</span>}
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
      className={`p-1 rounded-lg hover:bg-cocreator-light transition-colors ml-1 hidden lg:block ${
        statusPanelOpen ? (isWorkspace ? 'bg-blue-50 text-blue-600' : 'bg-cafe-surface-elevated') : ''
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
