'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import type { CatInvocationInfo } from '@/stores/chatStore';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { AuditExplorerPanel } from './audit/AuditExplorerPanel';
import { CatTokenUsage } from './CatTokenUsage';
import { PlanBoardPanel } from './PlanBoardPanel';
import { SessionChainPanel } from './SessionChainPanel';
import { settingsResourceCardClass } from './SettingsResourceCard';
import {
  type CatStatus,
  collectSnapshotActiveCats,
  deriveActiveCats,
  type IntentMode,
  modeLabel,
  statusLabel,
  statusTone,
  truncateId,
} from './status-helpers';
import { CatInvocationTime, CollapsibleIds } from './status-panel-parts';

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
  /** Panel width in px (clowder-ai#28: drag-to-resize). Falls back to 304. */
  width?: number;
  /** Allow tests to render history section expanded (SSR default: collapsed). */
  initialHistoryOpen?: boolean;
}

/* ── Cat invocation card (shared between active/history) ──── */
function CatInvocationCard({
  catId,
  inv,
  onCopy,
  isActive,
}: {
  catId: string;
  inv: CatInvocationInfo;
  onCopy: (v: string) => void;
  isActive: boolean;
}) {
  const { getCatById } = useCatData();
  const cat = getCatById(catId);
  const dotColor = cat?.color.primary ?? 'var(--console-cat-fallback)';
  return (
    <div className="text-xs">
      <div className="flex items-center gap-1.5 mb-1">
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${isActive ? 'animate-pulse' : ''}`}
          style={{ backgroundColor: dotColor }}
        />
        <span className="font-medium text-cafe-secondary">{cat ? formatCatName(cat) : catId}</span>
        {inv.sessionSeq !== undefined && (
          <span
            className={`text-[10px] px-1 py-0.5 rounded ${
              inv.sessionSealed
                ? 'bg-conn-amber-bg text-conn-amber-text'
                : 'bg-cafe-surface-elevated text-cafe-secondary'
            }`}
            title={inv.sessionSealed ? `会话 #${inv.sessionSeq} 已封存` : `会话 #${inv.sessionSeq}`}
          >
            S#{inv.sessionSeq}
            {inv.sessionSealed ? ' sealed' : ''}
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
        <CollapsibleIds sessionId={inv.sessionId} invocationId={inv.invocationId} onCopy={onCopy} />
      )}
    </div>
  );
}

/** Toggle between play/debug thinking visibility mode for the thread */
function ThinkingModeToggle({ threadId }: { threadId: string }) {
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
    <div className="flex items-center justify-between">
      <span>
        心里话: <span className="font-medium">{isDebug ? '调试' : '游戏'}</span>
      </span>
      <button
        onClick={toggle}
        className="console-pill rounded-full px-3 py-1 text-[11px] transition-colors hover:text-cafe"
        title={isDebug ? '切换到游戏模式（猫猫互相看不到心里话）' : '切换到调试模式（猫猫互相分享心里话）'}
      >
        {isDebug ? '切换游戏' : '切换调试'}
      </button>
    </div>
  );
}

const BUBBLE_LABELS: Record<string, string> = {
  global: '跟随全局',
  expanded: '展开',
  collapsed: '折叠',
};
const BUBBLE_CYCLE: Record<string, 'expanded' | 'collapsed' | 'global'> = {
  global: 'expanded',
  expanded: 'collapsed',
  collapsed: 'global',
};

/** Thread-level bubble display override (three-state: global / expanded / collapsed) */
function BubbleDisplayToggle({
  threadId,
  label,
  field,
}: {
  threadId: string;
  label: string;
  field: 'bubbleThinking' | 'bubbleCli';
}) {
  const thread = useChatStore((s) => s.threads.find((t) => t.id === threadId));
  const isLoadingThreads = useChatStore((s) => s.isLoadingThreads);
  const updateLocal = useChatStore((s) => s.updateThreadBubbleDisplay);
  const globalBubbleDefaults = useChatStore((s) => s.globalBubbleDefaults);
  const bubbleRestorePending = isLoadingThreads && !thread;
  const current = thread?.[field] ?? 'global';
  const currentEffective =
    current === 'global'
      ? field === 'bubbleThinking'
        ? globalBubbleDefaults.thinking
        : globalBubbleDefaults.cliOutput
      : current;
  const next = bubbleRestorePending
    ? null
    : current === 'global'
      ? currentEffective === 'expanded'
        ? 'collapsed'
        : 'expanded'
      : BUBBLE_CYCLE[current];
  const currentLabel = bubbleRestorePending
    ? '恢复中'
    : current === 'global'
      ? `${BUBBLE_LABELS.global}（当前${BUBBLE_LABELS[currentEffective]}）`
      : BUBBLE_LABELS[current];
  const pendingRef = useRef(false);

  const cycle = useCallback(async () => {
    if (pendingRef.current || bubbleRestorePending || !next) return;
    pendingRef.current = true;
    updateLocal(threadId, field, next);
    try {
      const res = await apiFetch(`/api/threads/${threadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: next }),
      });
      if (!res.ok) updateLocal(threadId, field, current);
    } catch {
      updateLocal(threadId, field, current);
    } finally {
      pendingRef.current = false;
    }
  }, [threadId, field, next, current, updateLocal, bubbleRestorePending]);

  return (
    <div className="flex items-center justify-between">
      <span>
        {label}: <span className="font-medium">{currentLabel}</span>
      </span>
      <button
        onClick={cycle}
        disabled={bubbleRestorePending}
        className="console-pill rounded-full px-3 py-1 text-[11px] transition-colors hover:text-cafe"
      >
        {bubbleRestorePending ? '恢复中...' : BUBBLE_LABELS[next as keyof typeof BUBBLE_LABELS]}
      </button>
    </div>
  );
}

/** F35: Reveal all whispers in the thread (game-end reveal) */
function RevealWhispersButton({ threadId }: { threadId: string }) {
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
        const data = await res.json();
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
  }, [threadId, status]);

  return (
    <div className="flex items-center justify-between">
      <span>悄悄话:</span>
      {status === 'done' ? (
        <span className="text-[11px] text-conn-emerald-text">已揭秘 {revealedCount} 条</span>
      ) : (
        <button
          onClick={handleReveal}
          disabled={status === 'pending'}
          className="console-pill rounded-full px-3 py-1 text-[11px] text-conn-amber-text transition-colors hover:opacity-90 disabled:opacity-50"
          title="揭晓本线程所有悄悄话"
        >
          {status === 'pending' ? '揭秘中...' : '揭秘全部'}
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

function RuntimeLogsButton() {
  const setRevealPath = useChatStore((s) => s.setWorkspaceRevealPath);
  const setOpenFile = useChatStore((s) => s.setWorkspaceOpenFile);

  const handleClick = useCallback(async () => {
    // Capture the originating thread BEFORE any awaits so that
    // workspace stamps attribute actions to the correct thread
    // even if the user switches threads during the async gap.
    const originThreadId = useChatStore.getState().currentThreadId;
    setRevealPath(LOGS_DIR, originThreadId);

    try {
      const wtRes = await apiFetch('/api/workspace/worktrees');
      if (!wtRes.ok) return;
      if (useChatStore.getState().currentThreadId !== originThreadId) return;
      const wtData = await wtRes.json();
      const wId = (wtData.worktrees ?? [])[0]?.id;
      if (!wId) return;

      const params = new URLSearchParams({ worktreeId: wId, path: LOGS_DIR, depth: '1' });
      const res = await apiFetch(`/api/workspace/tree?${params}`);
      if (!res.ok) return;
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
        setOpenFile(`${LOGS_DIR}/${logFiles[0].name}`, null, wId, originThreadId);
      }
    } catch {
      // Directory revealed; file open is best-effort
    }
  }, [setRevealPath, setOpenFile]);

  return (
    <section className={`${SIDEBAR_CARD} flex items-center justify-between px-3 py-2`}>
      <h3 className="text-[11px] font-bold text-cafe-secondary">运行日志</h3>
      <button
        onClick={handleClick}
        className="text-[11px] font-bold text-cafe-secondary transition-colors hover:text-cafe"
        title="在 Workspace 面板中打开运行日志目录"
      >
        查看日志
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
  const { activeCats, historyCats } = useMemo(() => {
    const snapshotCats = collectSnapshotActiveCats(catInvocations);
    const active = deriveActiveCats({ targetCats, snapshotCats, activeInvocations, hasActiveInvocation });
    const allParticipants = new Set([...active, ...Object.keys(catInvocations)]);
    const history = [...allParticipants].filter((c) => !active.includes(c));
    return { activeCats: active, historyCats: history };
  }, [targetCats, catInvocations, activeInvocations, hasActiveInvocation]);

  const { getCatById } = useCatData();
  const [historyOpen, setHistoryOpen] = useState(initialHistoryOpen);
  const [viewSession, setViewSession] = useState<{ id: string; catId?: string } | null>(null);

  // Clear session viewer when switching threads
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reset on threadId change only
  React.useEffect(() => {
    setViewSession(null);
  }, [threadId]);

  const copyText = useCallback((value: string) => {
    void navigator.clipboard.writeText(value);
  }, []);

  return (
    <aside
      className="hidden lg:flex flex-col gap-3 overflow-y-auto px-4 py-[18px]"
      data-console-panel="status"
      style={{
        width: width ?? 304,
        flexShrink: 0,
        background: 'var(--console-shell-bg)',
      }}
    >
      <div className="px-0.5 pb-1">
        <p className="text-[15px] font-bold text-cafe">状态栏</p>
        <span className="text-[10px] text-cafe-secondary">当前模式：{modeLabel(intentMode)}</span>
      </div>

      <section className={`${SIDEBAR_CARD} p-2.5`}>
        <h3 className="text-[11px] font-bold text-cafe mb-2">猫猫状态</h3>
        <div className="space-y-2">
          {activeCats.length > 0 ? (
            activeCats.map((catId) => {
              const cat = getCatById(catId);
              const dotColor = cat?.color.primary ?? 'var(--console-cat-fallback)';
              const status = catStatuses[catId] ?? 'pending';
              const inv = catInvocations[catId];
              return (
                <div key={catId} className="console-list-card rounded-xl p-2 shadow-[0_4px_16px_rgba(43,33,26,0.06)]">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: dotColor }} />
                      <span className="text-xs text-cafe-secondary">{cat ? formatCatName(cat) : catId}</span>
                    </div>
                    <span className={`text-xs font-medium ${statusTone(status)}`}>{statusLabel(status)}</span>
                  </div>
                  {inv && <CatInvocationCard catId={catId} inv={inv} onCopy={copyText} isActive />}
                </div>
              );
            })
          ) : (
            <div className="text-[11px] text-cafe-secondary">空闲</div>
          )}
        </div>
      </section>

      {historyCats.length > 0 && (
        <section className={`${SIDEBAR_CARD} p-2.5`}>
          <button
            onClick={() => setHistoryOpen((v) => !v)}
            className="flex w-full items-center justify-between text-[11px] font-bold text-cafe hover:text-cafe-secondary"
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
                        style={{ backgroundColor: cat?.color.primary ?? 'var(--console-cat-fallback)' }}
                      />
                      {cat ? formatCatName(cat) : catId}
                    </div>
                  );
                }
                return <CatInvocationCard key={catId} catId={catId} inv={inv} onCopy={copyText} isActive={false} />;
              })}
            </div>
          )}
        </section>
      )}

      <section className={`${SIDEBAR_CARD} p-2.5`}>
        <h3 className="text-[11px] font-bold text-cafe mb-2">消息统计</h3>
        <div className="console-list-card rounded-xl p-2.5 shadow-[0_4px_16px_rgba(43,33,26,0.06)] text-[11px] text-cafe-secondary space-y-1">
          <div>
            总数 {messageSummary.total} 猫猫消息 {messageSummary.assistant}
          </div>
          <div>
            系统消息 {messageSummary.system} Evidence {messageSummary.evidence}
          </div>
          <div>Follow-up {messageSummary.followup}</div>
        </div>
      </section>

      <PlanBoardPanel threadId={threadId} catInvocations={catInvocations} />

      <SessionChainPanel
        threadId={threadId}
        catInvocations={catInvocations}
        onViewSession={(id, catId) => setViewSession({ id, catId })}
      />

      <section className={`${SIDEBAR_CARD} p-2.5`}>
        <h3 className="text-[11px] font-bold text-cafe mb-2">对话信息</h3>
        <div className="console-list-card rounded-xl p-2.5 shadow-[0_4px_16px_rgba(43,33,26,0.06)] text-[11px] text-cafe-secondary space-y-1.5">
          <div>
            Thread:{' '}
            <button
              className="text-cafe-secondary font-mono hover:text-cafe cursor-pointer transition-colors"
              title={`点击复制: ${threadId}`}
              onClick={() => copyText(threadId)}
            >
              {truncateId(threadId, 12)}
            </button>
          </div>
          <BubbleDisplayToggle threadId={threadId} label="Thinking" field="bubbleThinking" />
          <BubbleDisplayToggle threadId={threadId} label="CLI 气泡" field="bubbleCli" />
          <ThinkingModeToggle threadId={threadId} />
          <RevealWhispersButton threadId={threadId} />
        </div>
      </section>

      <AuditExplorerPanel
        key={threadId}
        threadId={threadId}
        externalSessionId={viewSession?.id ?? null}
        externalSessionCatId={viewSession?.catId}
        onCloseSession={() => setViewSession(null)}
      />

      <RuntimeLogsButton />
    </aside>
  );
}
