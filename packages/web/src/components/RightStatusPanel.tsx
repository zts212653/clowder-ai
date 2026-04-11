'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import type { CatInvocationInfo } from '@/stores/chatStore';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { AuditExplorerPanel } from './audit/AuditExplorerPanel';
import { CatTokenUsage } from './CatTokenUsage';
import { PlanBoardPanel } from './PlanBoardPanel';
import { deriveActiveCats } from './parallel-status-helpers';
import { SessionChainPanel } from './SessionChainPanel';
import { type CatStatus, type IntentMode, modeLabel, statusLabel, statusTone, truncateId } from './status-helpers';
import { CatInvocationTime, CollapsibleIds } from './status-panel-parts';

export interface RightStatusPanelProps {
  intentMode: IntentMode;
  targetCats: string[];
  catStatuses: Record<string, CatStatus>;
  catInvocations: Record<string, CatInvocationInfo>;
  threadId: string;
  messageSummary: {
    total: number;
    assistant: number;
    system: number;
    evidence: number;
    followup: number;
  };
  /** Panel width in px (clowder-ai#28: drag-to-resize). Falls back to 288 (w-72). */
  width?: number;
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
  const dotColor = cat?.color.primary ?? '#9CA3AF';
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
              inv.sessionSealed ? 'bg-amber-100 text-amber-600' : 'bg-cafe-surface-elevated text-cafe-secondary'
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
        心里话: <span className="font-medium">{isDebug ? '🔍 调试' : '🎭 游戏'}</span>
      </span>
      <button
        onClick={toggle}
        className="text-[11px] px-2 py-0.5 rounded-full border border-cafe hover:border-gray-400 hover:bg-cafe-surface-elevated transition-colors"
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
  const updateLocal = useChatStore((s) => s.updateThreadBubbleDisplay);
  const current = thread?.[field] ?? 'global';
  const pendingRef = useRef(false);

  const cycle = useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    const next = BUBBLE_CYCLE[current] ?? 'global';
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
  }, [threadId, field, current, updateLocal]);

  return (
    <div className="flex items-center justify-between">
      <span>
        {label}: <span className="font-medium">{BUBBLE_LABELS[current]}</span>
      </span>
      <button
        onClick={cycle}
        className="text-[11px] px-2 py-0.5 rounded-full border border-cafe hover:border-gray-400 hover:bg-cafe-surface-elevated transition-colors"
      >
        {BUBBLE_LABELS[BUBBLE_CYCLE[current] ?? 'global']}
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
        <span className="text-[11px] text-green-600">已揭秘 {revealedCount} 条</span>
      ) : (
        <button
          onClick={handleReveal}
          disabled={status === 'pending'}
          className="text-[11px] px-2 py-0.5 rounded-full border border-amber-300 text-amber-600 hover:border-amber-400 hover:bg-amber-50 transition-colors disabled:opacity-50"
          title="揭晓本线程所有悄悄话"
        >
          {status === 'pending' ? '揭秘中...' : '揭秘全部'}
        </button>
      )}
    </div>
  );
}

const LOGS_DIR = 'packages/api/data/logs/api';

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
    <section className="rounded-lg border border-cafe bg-cafe-surface-elevated/70 p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-cafe-secondary">运行日志</h3>
        <button
          onClick={handleClick}
          className="text-[11px] px-2 py-0.5 rounded-full border border-cafe hover:border-gray-400 hover:bg-cafe-surface-elevated transition-colors"
          title="在 Workspace 面板中打开运行日志目录"
        >
          查看日志
        </button>
      </div>
    </section>
  );
}

export function RightStatusPanel({
  intentMode,
  targetCats,
  catStatuses,
  catInvocations,
  threadId,
  messageSummary,
  width,
}: RightStatusPanelProps) {
  const activeInvocations = useChatStore((s) => s.activeInvocations);
  // F26: Split into active (working now) vs history (appeared before)
  const { activeCats, historyCats } = useMemo(() => {
    const snapshotCats = Object.entries(catInvocations)
      .filter(([, inv]) => {
        const taskProgress = inv.taskProgress;
        if (!taskProgress || taskProgress.tasks.length === 0) return false;
        return taskProgress.snapshotStatus !== 'completed';
      })
      .map(([catId]) => catId);
    const slotCats = deriveActiveCats(targetCats, activeInvocations);
    const active = Array.from(new Set([...slotCats, ...snapshotCats]));
    const allParticipants = new Set([...active, ...Object.keys(catInvocations)]);
    const history = [...allParticipants].filter((c) => !active.includes(c));
    return { activeCats: active, historyCats: history };
  }, [targetCats, catInvocations, activeInvocations]);

  const { getCatById } = useCatData();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [viewSession, setViewSession] = useState<{ id: string; catId?: string } | null>(null);

  // Clear session viewer when switching threads
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reset on threadId change only
  React.useEffect(() => {
    setViewSession(null);
  }, [threadId]);

  const openHub = useChatStore((s) => s.openHub);

  const copyText = useCallback((value: string) => {
    void navigator.clipboard.writeText(value);
  }, []);

  return (
    <aside
      className="hidden lg:flex border-l border-cocreator-light bg-cafe-surface/90 px-4 py-4 flex-col gap-4 overflow-y-auto"
      style={{ width: width ?? 288, flexShrink: 0 }}
    >
      <div>
        <h2 className="text-sm font-bold text-cafe-black">状态栏</h2>
        <p className="text-xs text-cafe-secondary mt-1">
          当前模式: <span className="font-medium">{modeLabel(intentMode)}</span>
        </p>
      </div>

      {/* ── Active cats: currently working ──────────────── */}
      <section className="rounded-lg border border-cafe bg-cafe-surface-elevated/70 p-3">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-cafe-secondary">
            {activeCats.length > 0 ? '当前调用' : '猫猫状态'}
          </h3>
          <button
            onClick={() => openHub()}
            className="text-base text-cafe-muted hover:text-blue-600 hover:rotate-45 transition-all duration-200"
            title="Clowder AI Hub"
          >
            &#9881;
          </button>
        </div>
        {activeCats.length > 0 ? (
          <div className="space-y-3">
            {activeCats.map((catId) => {
              const cat = getCatById(catId);
              const dotColor = cat?.color.primary ?? '#9CA3AF';
              const status = catStatuses[catId] ?? 'pending';
              const inv = catInvocations[catId];
              return (
                <div key={catId}>
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
            })}
          </div>
        ) : (
          <div className="text-xs text-cafe-muted">空闲</div>
        )}
      </section>

      {/* ── History cats: appeared before but not in current round ── */}
      {historyCats.length > 0 && (
        <section className="rounded-lg border border-cafe bg-cafe-surface-elevated/70 p-3">
          <button
            onClick={() => setHistoryOpen((v) => !v)}
            className="w-full flex items-center justify-between text-xs font-semibold text-cafe-secondary hover:text-cafe-secondary"
          >
            <span>历史参与 ({historyCats.length})</span>
            <span className="text-[10px]">{historyOpen ? '▲' : '▼'}</span>
          </button>
          {historyOpen && (
            <div className="mt-2 space-y-2">
              {historyCats.map((catId) => {
                const inv = catInvocations[catId];
                if (!inv) {
                  const cat = getCatById(catId);
                  return (
                    <div key={catId} className="flex items-center gap-2 text-xs text-cafe-muted">
                      <span
                        className="inline-block h-2 w-2 rounded-full opacity-50"
                        style={{ backgroundColor: cat?.color.primary ?? '#9CA3AF' }}
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

      {/* ── Message stats (collapsible) ───────────────── */}
      <section className="rounded-lg border border-cafe bg-cafe-surface-elevated/70 p-3">
        <h3 className="text-xs font-semibold text-cafe-secondary mb-2">消息统计</h3>
        <div className="grid grid-cols-2 gap-2 text-xs text-cafe-secondary">
          <div>总数</div>
          <div className="text-right font-medium">{messageSummary.total}</div>
          <div>猫猫消息</div>
          <div className="text-right font-medium">{messageSummary.assistant}</div>
          <div>系统消息</div>
          <div className="text-right font-medium">{messageSummary.system}</div>
          <div>Evidence</div>
          <div className="text-right font-medium">{messageSummary.evidence}</div>
          <div>Follow-up</div>
          <div className="text-right font-medium">{messageSummary.followup}</div>
        </div>
      </section>

      <PlanBoardPanel threadId={threadId} catInvocations={catInvocations} />

      <SessionChainPanel
        threadId={threadId}
        catInvocations={catInvocations}
        onViewSession={(id, catId) => setViewSession({ id, catId })}
      />

      <section className="rounded-lg border border-cafe bg-cafe-surface-elevated/70 p-3">
        <h3 className="text-xs font-semibold text-cafe-secondary mb-2">对话信息</h3>
        <div className="text-xs text-cafe-secondary space-y-2">
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

      {/* ── F130: Runtime logs quick-access ────────────── */}
      <RuntimeLogsButton />
    </aside>
  );
}
