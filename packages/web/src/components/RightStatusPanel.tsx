'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import { catColorVar } from '@/lib/cat-slug';
import type { CatInvocationInfo } from '@/stores/chatStore';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { useBubbleDisplayCycle } from './bubble-display-cycle';
import { CatTokenUsage } from './CatTokenUsage';
import { PlanBoardPanel } from './PlanBoardPanel';
import { SessionIdTag } from './SessionChainInputs';
import { SessionChainPanel } from './SessionChainPanel';
import { settingsResourceCardClass } from './SettingsResourceCard';
import { useShellCopy } from './shell/shell-copy';
import {
  type CatStatus,
  collectSnapshotActiveCats,
  deriveActiveCats,
  type IntentMode,
  modeLabel,
  statusLabel,
  statusTone,
} from './status-helpers';
import { CatInvocationTime, InvocationIds } from './status-panel-parts';
import { captureFileCardOrigin } from './workbench/file-card-origin';
import { useFileCardReturn } from './workbench/useFileCardReturn';
import { statusPageCopy } from './workspace-status/status-page.shell-copy';

export interface RightStatusPanelProps {
  intentMode: IntentMode;
  targetCats: string[];
  catStatuses: Record<string, CatStatus>;
  catInvocations: Record<string, CatInvocationInfo>;
  activeInvocations?: Record<string, { catId: string; mode: string; startedAt?: number }>;
  hasActiveInvocation?: boolean;
  threadId: string;
  messageSummary: {
    total: number;
    assistant: number;
    system: number;
    evidence: number;
    followup: number;
  };
  /** Resizable desktop width; responsive hosts pass 100% on narrow viewports. */
  width?: number | string;
  /** Allow tests to render history section expanded (SSR default: collapsed). */
  initialHistoryOpen?: boolean;
}

/* ── Cat invocation card (shared between active/history) ──── */
function CatInvocationCard({ catId, inv, isActive }: { catId: string; inv: CatInvocationInfo; isActive: boolean }) {
  const { getCatById } = useCatData();
  const cat = getCatById(catId);
  const dotColor = catColorVar(cat?.id, 'primary');
  return (
    <div className="text-xs">
      <div className="flex items-center gap-1.5 mb-1 min-w-0">
        <span
          className={`shrink-0 inline-block h-2.5 w-2.5 rounded-full ${isActive ? 'animate-pulse' : ''}`}
          style={{ backgroundColor: dotColor }}
        />
        <span className="truncate min-w-0 font-medium text-cafe-secondary">{cat ? formatCatName(cat) : catId}</span>
        {inv.sessionSeq !== undefined && (
          <span
            className={`shrink-0 text-micro px-1 py-0.5 rounded ${
              inv.sessionSealed
                ? 'bg-conn-amber-bg text-conn-amber-text'
                : 'bg-cafe-surface-elevated text-cafe-secondary'
            }`}
            title={inv.sessionSealed ? `会话 #${inv.sessionSeq} 已封存` : `会话 #${inv.sessionSeq}`}
          >
            S#{inv.sessionSeq}
            {inv.sessionSealed ? ' 已封存' : ''}
          </span>
        )}
        <CatInvocationTime invocation={inv} />
      </div>
      {inv.usage && (
        <div className="ml-3.5">
          <CatTokenUsage catId={catId} usage={inv.usage} contextHealth={inv.contextHealth} />
        </div>
      )}
      {(inv.sessionId || inv.invocationId) && (
        <InvocationIds sessionId={inv.sessionId} invocationId={inv.invocationId} />
      )}
    </div>
  );
}

/** Toggle between play/debug thinking visibility mode for the thread */
export function ThinkingModeToggle({ threadId, v2 = false }: { threadId: string; v2?: boolean }) {
  const t = useShellCopy(statusPageCopy);
  const thread = useChatStore((s) => s.threads.find((t) => t.id === threadId));
  const updateLocal = useChatStore((s) => s.updateThreadThinkingMode);
  const mode = thread?.thinkingMode ?? 'debug';
  const isDebug = mode === 'debug';
  const pendingRef = useRef(false);

  const toggle = useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    const next = isDebug ? 'play' : 'debug';
    updateLocal(threadId, next);
    try {
      const res = await apiFetch(`/api/threads/${threadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thinkingMode: next }),
      });
      if (!res.ok) {
        updateLocal(threadId, mode);
      }
    } catch {
      // Revert on network failure
      updateLocal(threadId, mode);
    } finally {
      pendingRef.current = false;
    }
  }, [threadId, isDebug, mode, updateLocal]);

  return (
    <div className={v2 ? 'status-v2-visibility-row' : 'flex items-center justify-between gap-2 min-w-0'}>
      {v2 ? (
        <>
          <span>{t.thinking}</span>
          <span className="status-v2-visibility-value" title={isDebug ? t.debugMode : t.playMode}>
            {isDebug ? t.debugMode : t.playMode}
          </span>
        </>
      ) : (
        <span className="truncate min-w-0">
          心里话: <span className="font-medium">{isDebug ? '调试' : '游戏'}</span>
        </span>
      )}
      <button
        onClick={toggle}
        className="shrink-0 rounded-full px-3 py-1 text-label transition-colors hover:text-cafe"
        title={
          v2
            ? isDebug
              ? t.toPlayHint
              : t.toDebugHint
            : isDebug
              ? '切换到游戏模式（猫猫互相看不到心里话）'
              : '切换到调试模式（猫猫互相分享心里话）'
        }
      >
        {isDebug ? (v2 ? t.toPlay : '切换游戏') : v2 ? t.toDebug : '切换调试'}
      </button>
    </div>
  );
}

const BUBBLE_LABELS: Record<string, string> = {
  global: '跟随全局',
  expanded: '展开',
  collapsed: '折叠',
};

/** Thread-level bubble display override (three-state: global / expanded / collapsed) */
export function BubbleDisplayToggle({
  threadId,
  label,
  field,
}: {
  threadId: string;
  label: string;
  field: 'bubbleThinking' | 'bubbleCli';
}) {
  const { current, currentEffective, next, restorePending, cycle } = useBubbleDisplayCycle(threadId, field);
  const currentLabel = restorePending
    ? '恢复中'
    : current === 'global'
      ? `${BUBBLE_LABELS.global}（当前${BUBBLE_LABELS[currentEffective]}）`
      : BUBBLE_LABELS[current];

  return (
    <div className="flex items-center justify-between gap-2 min-w-0">
      <span className="truncate min-w-0">
        {label}: <span className="font-medium">{currentLabel}</span>
      </span>
      <button
        onClick={cycle}
        disabled={restorePending}
        className="shrink-0 rounded-full px-3 py-1 text-label transition-colors hover:text-cafe"
      >
        {restorePending ? '恢复中...' : BUBBLE_LABELS[next as keyof typeof BUBBLE_LABELS]}
      </button>
    </div>
  );
}

/** F35: Reveal all whispers in the thread (game-end reveal) */
export function RevealWhispersButton({ threadId, v2 = false }: { threadId: string; v2?: boolean }) {
  const t = useShellCopy(statusPageCopy);
  const [status, setStatus] = useState<'idle' | 'pending' | 'done'>('idle');
  const [revealedCount, setRevealedCount] = useState<number | null>(null);

  // Reset state when switching threads
  useEffect(() => {
    setStatus('idle');
    setRevealedCount(null);
  }, []);

  const handleReveal = useCallback(async () => {
    if (status === 'pending') return;
    setStatus('pending');
    // Capture cutoff before PATCH so whispers arriving mid-flight aren't falsely marked
    const revealCutoff = Date.now();
    try {
      const res = await apiFetch(`/api/threads/${threadId}/reveal`, {
        method: 'PATCH',
      });
      if (res.ok) {
        if (v2 && useChatStore.getState().currentThreadId !== threadId) return;
        const data = await res.json();
        if (v2 && useChatStore.getState().currentThreadId !== threadId) return;
        const count = data.revealed ?? 0;
        setRevealedCount(count);
        setStatus('done');
        // Update local chat store so whisper bubbles re-render as revealed
        if (count > 0) {
          useChatStore.setState((state) => ({
            messages: state.messages.map((m) =>
              m.visibility === 'whisper' && !m.revealedAt && (m.timestamp ?? 0) <= revealCutoff
                ? { ...m, revealedAt: revealCutoff }
                : m,
            ),
          }));
        }
        // Reset to idle after a delay so new whispers can be revealed later
        setTimeout(() => setStatus('idle'), 3000);
      } else {
        setStatus('idle');
      }
    } catch {
      setStatus('idle');
    }
  }, [threadId, status, v2]);

  return (
    <div className={v2 ? 'status-v2-visibility-row' : 'flex items-center justify-between gap-2 min-w-0'}>
      {v2 ? (
        <>
          <span>{t.whispers}</span>
          <span className="status-v2-visibility-value" title={t.whispersHint}>
            {t.whispersHint}
          </span>
        </>
      ) : (
        <span className="shrink-0">悄悄话:</span>
      )}
      {status === 'done' ? (
        <span className="shrink-0 text-label text-conn-emerald-text">
          {v2 ? t.revealed(revealedCount ?? 0) : `已揭秘 ${revealedCount} 条`}
        </span>
      ) : (
        <button
          onClick={handleReveal}
          disabled={status === 'pending'}
          className="shrink-0 rounded-full px-3 py-1 text-label text-conn-amber-text transition-colors hover:opacity-90 disabled:opacity-50"
          title={v2 ? t.revealHint : '揭晓本线程所有悄悄话'}
        >
          {status === 'pending' ? (v2 ? t.revealing : '揭秘中...') : v2 ? t.reveal : '揭秘全部'}
        </button>
      )}
    </div>
  );
}

const LOGS_DIR = 'packages/api/data/logs/api';
const SIDEBAR_CARD = settingsResourceCardClass;

function parseLogFilename(name: string): { date: string; seq: number } | null {
  const m = name.match(/^api\.(\d{4}-\d{2}-\d{2})\.(\d+)\.log$/);
  if (!m) return null;
  return { date: m[1], seq: Number(m[2]) };
}

/** Exported for tests; rendered inside RightStatusPanel. */
export function RuntimeLogsButton({ threadId, compact = false }: { threadId: string; compact?: boolean }) {
  const t = useShellCopy(statusPageCopy);
  const originRef = useFileCardReturn<HTMLElement>('runtime-logs', threadId);
  const setOpenFile = useChatStore((s) => s.setWorkspaceOpenFile);

  const handleClick = useCallback(async () => {
    // Capture the originating thread BEFORE any awaits so that
    // workspace stamps attribute actions to the correct thread
    // even if the user switches threads during the async gap.
    const originThreadId = useChatStore.getState().currentThreadId;
    const navigationOrigin = captureFileCardOrigin(originRef.current, 'runtime-logs', originThreadId, 'status');

    try {
      const wtRes = await apiFetch('/api/workspace/worktrees');
      if (!wtRes.ok) return;
      if (useChatStore.getState().currentThreadId !== originThreadId) return;
      const wtData = await wtRes.json();
      const wId = (wtData.worktrees ?? [])[0]?.id;
      if (!wId) return;
      // Without a log file to open, show the logs directory itself; the file tree says why if it cannot.
      const revealLogsDir = () =>
        useChatStore
          .getState()
          .openWorkspacePath(originThreadId, { kind: 'reveal', worktreeId: wId, path: LOGS_DIR, navigationOrigin });

      if (compact) {
        revealLogsDir();
        return;
      }

      const params = new URLSearchParams({ worktreeId: wId, path: LOGS_DIR, depth: '1' });
      const res = await apiFetch(`/api/workspace/tree?${params}`);
      if (!res.ok) {
        revealLogsDir();
        return;
      }
      const data = await res.json();
      if (useChatStore.getState().currentThreadId !== originThreadId) return;
      const entries: { name: string; type: string }[] = Array.isArray(data.tree)
        ? data.tree
        : (data.tree?.children ?? []);
      const logFiles = entries
        .filter((f: { name: string; type: string }) => f.type === 'file' && f.name.endsWith('.log'))
        .map((f: { name: string }) => ({ name: f.name, parsed: parseLogFilename(f.name) }))
        .filter((f): f is { name: string; parsed: { date: string; seq: number } } => f.parsed !== null)
        .sort((a, b) => {
          const dc = b.parsed.date.localeCompare(a.parsed.date);
          return dc !== 0 ? dc : b.parsed.seq - a.parsed.seq;
        });
      if (logFiles.length > 0) {
        setOpenFile(`${LOGS_DIR}/${logFiles[0].name}`, null, wId, originThreadId, navigationOrigin);
      } else {
        revealLogsDir();
      }
    } catch {
      // Network loss before anything was recorded; the button stays usable for a retry.
    }
  }, [compact, setOpenFile, originRef]);

  return (
    <section
      ref={originRef}
      tabIndex={-1}
      className={compact ? 'status-v2-info-row' : `${SIDEBAR_CARD} flex items-center justify-between px-3 py-2`}
    >
      {compact ? (
        <span className="status-v2-muted">{t.logs}</span>
      ) : (
        <h3 className="text-label font-bold text-cafe">运行日志</h3>
      )}
      <button
        onClick={handleClick}
        className="text-label font-bold text-cafe transition-colors hover:text-cafe"
        title={compact ? t.logsHint : '在 Workspace 面板中打开运行日志目录'}
      >
        {compact ? t.openDirectory : '查看日志'}
      </button>
    </section>
  );
}

export function RightStatusPanel({
  intentMode,
  targetCats,
  catStatuses,
  catInvocations,
  activeInvocations,
  hasActiveInvocation,
  threadId,
  messageSummary,
  width,
  initialHistoryOpen = false,
}: RightStatusPanelProps) {
  // F26: Split into active (working now) vs history (appeared before)
  // review-#784 P2 + AC-Z15: pass intentMode so deriveActiveCats preserves the
  // full targetCats union during ideate rounds. Without this, finished-cat slots get demoted
  // to history while the round is still running).
  const { activeCats, historyCats } = useMemo(() => {
    const snapshotCats = collectSnapshotActiveCats(catInvocations);
    const active = deriveActiveCats({ targetCats, snapshotCats, activeInvocations, hasActiveInvocation, intentMode });
    const allParticipants = new Set([...active, ...Object.keys(catInvocations)]);
    const history = [...allParticipants].filter((c) => !active.includes(c));
    return { activeCats: active, historyCats: history };
  }, [targetCats, catInvocations, activeInvocations, hasActiveInvocation, intentMode]);

  const { getCatById } = useCatData();
  const [historyOpen, setHistoryOpen] = useState(initialHistoryOpen);

  return (
    <aside
      className="flex flex-col gap-3 overflow-y-auto px-4 py-[18px]"
      data-console-panel="status"
      data-file-origin-scroll
      style={{
        width: width ?? 304,
        flexShrink: 0,
        background: 'var(--console-shell-bg)',
      }}
    >
      <div className="px-0.5 pb-1">
        <span className="text-micro text-cafe-secondary">当前模式：{modeLabel(intentMode)}</span>
      </div>

      <section className={`${SIDEBAR_CARD} p-2.5`}>
        <h3 className="text-label font-bold text-cafe mb-2">猫猫状态</h3>
        <div className="space-y-2">
          {activeCats.length > 0 ? (
            activeCats.map((catId) => {
              const cat = getCatById(catId);
              const dotColor = catColorVar(cat?.id, 'primary');
              const status = catStatuses[catId] ?? 'pending';
              const inv = catInvocations[catId];
              return (
                <div key={catId} className="console-list-card rounded-xl p-2">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: dotColor }} />
                      <span className="text-xs text-cafe-secondary">{cat ? formatCatName(cat) : catId}</span>
                    </div>
                    <span className={`text-xs font-medium ${statusTone(status)}`}>{statusLabel(status)}</span>
                  </div>
                  {inv && <CatInvocationCard catId={catId} inv={inv} isActive />}
                </div>
              );
            })
          ) : (
            <div className="text-label text-cafe-muted">空闲</div>
          )}
        </div>
      </section>

      {historyCats.length > 0 && (
        <section className={`${SIDEBAR_CARD} p-2.5`}>
          <button
            onClick={() => setHistoryOpen((v) => !v)}
            className="w-full flex items-center justify-between text-label font-bold text-cafe hover:text-cafe"
          >
            <span>历史参与 ({historyCats.length})</span>
            <svg
              className={`w-3 h-3 transition-transform ${historyOpen ? 'rotate-180' : ''}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          {historyOpen && (
            <div className="p-2.5 space-y-2">
              {historyCats.map((catId) => {
                const inv = catInvocations[catId];
                if (!inv) {
                  const cat = getCatById(catId);
                  return (
                    <div key={catId} className="flex items-center gap-2 text-xs text-cafe-muted">
                      <span
                        className="inline-block h-2 w-2 rounded-full opacity-50"
                        style={{ backgroundColor: catColorVar(cat?.id, 'primary') }}
                      />
                      {cat ? formatCatName(cat) : catId}
                    </div>
                  );
                }
                return <CatInvocationCard key={catId} catId={catId} inv={inv} isActive={false} />;
              })}
            </div>
          )}
        </section>
      )}

      <section className={`${SIDEBAR_CARD} p-2.5`}>
        <h3 className="text-label font-bold text-cafe mb-2">消息统计</h3>
        <div className="console-list-card rounded-xl p-2.5 text-label text-cafe-secondary space-y-1">
          <div>
            总数 {messageSummary.total} 猫猫消息 {messageSummary.assistant}
          </div>
          <div>
            系统消息 {messageSummary.system} 证据 {messageSummary.evidence}
          </div>
          <div>跟进 {messageSummary.followup}</div>
        </div>
      </section>

      <PlanBoardPanel threadId={threadId} catInvocations={catInvocations} />

      <SessionChainPanel threadId={threadId} catInvocations={catInvocations} activeInvocations={activeInvocations} />

      <section className={`${SIDEBAR_CARD} p-2.5`}>
        <h3 className="text-label font-bold text-cafe mb-2">对话信息</h3>
        <div className="console-list-card rounded-xl p-2.5 text-label text-cafe-secondary space-y-1.5">
          <div className="flex items-baseline gap-1 min-w-0">
            <span className="shrink-0">对话 ID：</span>
            <SessionIdTag id={threadId} label="对话 ID" />
          </div>
          <BubbleDisplayToggle threadId={threadId} label="思考过程" field="bubbleThinking" />
          <BubbleDisplayToggle threadId={threadId} label="命令行气泡" field="bubbleCli" />
          <ThinkingModeToggle threadId={threadId} />
          <RevealWhispersButton threadId={threadId} />
        </div>
      </section>

      <RuntimeLogsButton threadId={threadId} />
    </aside>
  );
}
