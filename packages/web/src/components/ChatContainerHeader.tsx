import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useVoiceServicesAvailable } from '@/hooks/useVoiceServicesAvailable';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { ExportButton } from './ExportButton';
import { CatCafeLogo } from './icons/CatCafeLogo';
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
  const voiceAvailable = useVoiceServicesAvailable();

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
        {voiceAvailable && (
          <>
            <VoiceCompanionButton threadId={threadId} defaultCatId={defaultCatId} />
            <LiveAudioToggle />
          </>
        )}
        {authPendingCount > 0 && (
          <span
            className="inline-flex items-center justify-center h-5 min-w-[20px] px-1 rounded-full bg-conn-amber-bg text-conn-amber-text text-[10px] font-bold animate-pulse-subtle"
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
        {/* F099: Unified right panel toggle (merged workspace + status panel) */}
        <RightPanelToggle onToggleStatusPanel={onToggleStatusPanel} statusPanelOpen={statusPanelOpen} />
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
          const body = (await res.json()) as { daemonShortId?: string };
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
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono text-conn-amber-text bg-conn-amber-bg hover:opacity-80 transition-colors flex-shrink-0"
      title={`Daemon ${daemonShortId} 运行中 · 点击查看后台会话`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-conn-amber-text animate-pulse" />
      {daemonShortId}
    </button>
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
  rightPanelMode: 'status' | 'workspace' | 'transcript',
  callbacks: {
    onToggleStatusPanel: () => void;
    setRightPanelMode: (mode: 'status' | 'workspace' | 'transcript') => void;
  },
) {
  if (!statusPanelOpen) {
    callbacks.onToggleStatusPanel();
    callbacks.setRightPanelMode('status');
  } else if (rightPanelMode === 'status') {
    callbacks.setRightPanelMode('workspace');
  } else {
    callbacks.onToggleStatusPanel();
    callbacks.setRightPanelMode('status');
  }
}

/** F099: Unified right panel toggle — cycles closed → status → workspace → closed */
function LiveAudioToggle() {
  const rightPanelMode = useChatStore((s) => s.rightPanelMode);
  const setRightPanelMode = useChatStore((s) => s.setRightPanelMode);
  const isActive = rightPanelMode === 'transcript';

  return (
    <button
      type="button"
      onClick={() => setRightPanelMode(isActive ? 'status' : 'transcript')}
      className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors hidden lg:flex ${
        isActive
          ? 'bg-conn-emerald-bg text-conn-emerald-text'
          : 'bg-[var(--console-pill-bg)] text-cafe-secondary hover:opacity-80'
      }`}
      title={isActive ? 'Close transcript' : 'Live audio transcript'}
      aria-label={isActive ? 'Close transcript' : 'Live audio transcript'}
    >
      <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
        <path
          fillRule="evenodd"
          d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z"
          clipRule="evenodd"
        />
      </svg>
    </button>
  );
}

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
      className={`p-1 rounded-lg text-cafe-secondary hover:bg-[var(--console-hover-bg)] transition-colors ml-1 hidden lg:block ${
        statusPanelOpen
          ? isWorkspace
            ? 'bg-[var(--cafe-accent)]/5 text-[var(--cafe-accent)]'
            : 'bg-[var(--console-hover-bg)]'
          : ''
      }`}
      aria-label={label}
      title={label}
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
