'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { MarkdownContent } from '@/components/MarkdownContent';
import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import type { RichCardBlock } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { CafeIcon } from './CafeIcons';
import {
  displayProposalTitle,
  EditField,
  formatReportingMode,
  ProjectPathEdit,
  ProposalCardIcon,
  ReportingModeEdit,
  type ReportingModeEditValue,
} from './ProposalCardFields';
import {
  extractProposalId,
  isDefaultProjectOwnership,
  type ProposalCardStatus,
  type ProposalFieldEdits,
  type ProposalSnapshot,
  parsePreferredCats,
  readField,
  readProjectPathEdit,
  readReportingModeEdit,
} from './ProposalCardUtils';

interface ProposalCardProps {
  block: RichCardBlock;
  messageId?: string;
}

function selectExistingProjectPaths(state: ReturnType<typeof useChatStore.getState>): string[] {
  const threads = state.threads ?? [];
  return [...new Set(threads.map((t) => t.projectPath).filter((p): p is string => !!p && p !== 'default'))].sort();
}

export function ProposalCard({ block }: ProposalCardProps) {
  const proposalId = useMemo(() => extractProposalId(block), [block]);
  const [status, setStatus] = useState<ProposalCardStatus>('pending');
  const [resultThreadId, setResultThreadId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pinOnApprove, setPinOnApprove] = useState(false);
  const [effectiveReportingMode, setEffectiveReportingMode] = useState<ReportingModeEditValue>(() =>
    readReportingModeEdit(block),
  );
  const [edits, setEdits] = useState<ProposalFieldEdits>(() => ({
    title: block.title.replace(/^(?:📥 )?提议新建 thread：/, ''),
    parentThreadId: readField(block, '父 Thread'),
    preferredCats: readField(block, '建议成员'),
    initialMessage: readField(block, '首条消息'),
    projectPath: readProjectPathEdit(block),
    reportingMode: readReportingModeEdit(block),
  }));
  const projectOwnership = readField(block, '项目归属');
  const reportingMode = formatReportingMode(effectiveReportingMode);
  const needsProjectChoice = isDefaultProjectOwnership(projectOwnership);
  const existingProjects = useChatStore(useShallow(selectExistingProjectPaths));

  // Mount: fetch real status so reload / multi-tab views don't drift to stale "pending".
  useEffect(() => {
    if (!proposalId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/proposals/${proposalId}`);
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { proposal: ProposalSnapshot };
        if (data.proposal && !cancelled) {
          setStatus(data.proposal.status);
          if (data.proposal.createdThreadId) setResultThreadId(data.proposal.createdThreadId);
          if (data.proposal.reportingMode) {
            setEffectiveReportingMode(data.proposal.reportingMode);
            setEdits((prev) => ({ ...prev, reportingMode: data.proposal.reportingMode ?? prev.reportingMode }));
          }
        }
      } catch {
        // best-effort sync; keep the optimistic 'pending' if fetch fails
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [proposalId]);

  // Subscribe to socket-driven updates so other tabs / async approves reflect immediately.
  useEffect(() => {
    if (!proposalId || typeof window === 'undefined') return;
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<ProposalSnapshot>).detail;
      if (!detail || detail.proposalId !== proposalId) return;
      setStatus(detail.status);
      if (detail.createdThreadId) setResultThreadId(detail.createdThreadId);
      if (detail.reportingMode) {
        setEffectiveReportingMode(detail.reportingMode);
        setEdits((prev) => ({ ...prev, reportingMode: detail.reportingMode ?? prev.reportingMode }));
      }
    };
    window.addEventListener('cat-cafe:proposal-updated', handler);
    return () => {
      window.removeEventListener('cat-cafe:proposal-updated', handler);
    };
  }, [proposalId]);

  const approve = useCallback(async () => {
    if (!proposalId) return;
    setLoading(true);
    setError(null);
    const body: Record<string, unknown> = editing
      ? {
          title: edits.title.trim() || undefined,
          parentThreadId: edits.parentThreadId.trim() || undefined,
          preferredCats: parsePreferredCats(edits.preferredCats),
          initialMessage: edits.initialMessage.trim() ? edits.initialMessage.trim() : null,
          // F128: empty box = no override (keep the proposal's projectPath); a path re-homes the
          // child thread. Backend validates + fail-loud rejects an invalid path (400).
          projectPath: edits.projectPath.trim() || undefined,
          reportingMode: edits.reportingMode,
        }
      : {};
    try {
      const res = await apiFetch(`/api/proposals/${proposalId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { threadId?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const newThreadId = data.threadId ?? null;
      setEffectiveReportingMode(editing ? edits.reportingMode : effectiveReportingMode);
      setResultThreadId(newThreadId);
      setStatus('approved');
      setEditing(false);
      // AC-F7: persist pin via PATCH /api/threads/:id (server-side) + sync local store for immediate sidebar UX
      if (pinOnApprove && newThreadId) {
        try {
          const pinRes = await apiFetch(`/api/threads/${newThreadId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pinned: true }),
          });
          // Only sync local store if server actually persisted the pin
          if (pinRes.ok) {
            useChatStore.getState().updateThreadPin(newThreadId, true);
          }
        } catch {
          // best-effort: pin failure should not block the approve success UX
        }
      }
      if (newThreadId) {
        pushThreadRouteWithHistory(newThreadId, typeof window !== 'undefined' ? window : undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '批准失败');
    } finally {
      setLoading(false);
    }
  }, [proposalId, editing, edits, effectiveReportingMode, pinOnApprove]);

  const reject = useCallback(async () => {
    if (!proposalId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/proposals/${proposalId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setStatus('rejected');
    } catch (err) {
      setError(err instanceof Error ? err.message : '驳回失败');
    } finally {
      setLoading(false);
    }
  }, [proposalId]);

  if (!proposalId) {
    return (
      <div className="border-l-4 border-l-red-400 bg-[var(--semantic-critical-surface)] rounded-r-lg p-3 text-xs text-conn-red-text">
        Proposal card missing proposalId
      </div>
    );
  }

  return (
    <div className="border-l-4 border-l-blue-400 bg-[var(--semantic-info-surface)] rounded-r-lg p-3">
      <div className="flex items-start gap-2">
        <ProposalCardIcon />
        <div className="font-medium text-sm">{displayProposalTitle(block.title)}</div>
      </div>
      {block.bodyMarkdown && (
        <div className="mt-1 text-xs text-cafe-secondary [&_p]:mb-1 [&_p:last-child]:mb-0">
          <MarkdownContent content={block.bodyMarkdown} className="!text-xs" disableCommandPrefix />
        </div>
      )}
      {!editing && (
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1 text-xs">
          <div>
            <span className="text-cafe-muted">父 Thread:</span>{' '}
            <span className="font-mono break-all">{edits.parentThreadId}</span>
          </div>
          <div>
            <span className="text-cafe-muted">建议成员:</span>{' '}
            <span className="font-mono break-all">{edits.preferredCats || '（未指定）'}</span>
          </div>
          <div className="sm:col-span-2">
            <span className="text-cafe-muted">回报模式:</span> <span>{reportingMode}</span>
          </div>
          {projectOwnership && (
            <div className="sm:col-span-2">
              <span className="text-cafe-muted">项目归属:</span>{' '}
              <span className="font-mono break-all">{projectOwnership}</span>
            </div>
          )}
          {edits.initialMessage && (
            <div className="sm:col-span-2">
              <span className="text-cafe-muted">首条消息:</span> <span>{edits.initialMessage}</span>
            </div>
          )}
        </div>
      )}
      {needsProjectChoice && !editing && (
        <div className="mt-2 rounded border border-[var(--semantic-warning)] bg-[var(--semantic-warning-surface)] px-2 py-1 text-xs text-cafe-secondary">
          这个子 thread 会进入未分类。点“编辑”选择项目，或直接批准表示保留未分类。
        </div>
      )}
      {editing && (
        <div className="mt-2 space-y-1 text-xs">
          <EditField label="标题" value={edits.title} onChange={(v) => setEdits((p) => ({ ...p, title: v }))} />
          <EditField
            label="父 Thread"
            value={edits.parentThreadId}
            onChange={(v) => setEdits((p) => ({ ...p, parentThreadId: v }))}
          />
          <ProjectPathEdit
            value={edits.projectPath}
            onChange={(v) => setEdits((p) => ({ ...p, projectPath: v }))}
            existingProjects={existingProjects}
            defaultParent={needsProjectChoice}
          />
          <ReportingModeEdit
            value={edits.reportingMode}
            onChange={(v) => setEdits((p) => ({ ...p, reportingMode: v }))}
          />
          <EditField
            label="建议成员 (逗号分隔)"
            value={edits.preferredCats}
            onChange={(v) => setEdits((p) => ({ ...p, preferredCats: v }))}
          />
          <EditField
            label="首条消息"
            value={edits.initialMessage}
            onChange={(v) => setEdits((p) => ({ ...p, initialMessage: v }))}
            multiline
          />
        </div>
      )}
      {status === 'pending' && (
        <div className="mt-2 space-y-2">
          <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300 cursor-pointer">
            <input
              type="checkbox"
              checked={pinOnApprove}
              onChange={(e) => setPinOnApprove(e.target.checked)}
              className="rounded border-gray-300 dark:border-gray-600"
            />
            <CafeIcon name="pin" className="h-3.5 w-3.5 text-cafe-muted" />
            置顶新 thread
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={loading} onClick={approve} className={btnPrimary}>
              {loading
                ? '处理中...'
                : editing
                  ? '批准（含编辑）'
                  : needsProjectChoice
                    ? '批准并创建（保留未分类）'
                    : '批准并创建'}
            </button>
            <button type="button" disabled={loading} onClick={() => setEditing((v) => !v)} className={btnSecondary}>
              {editing ? '取消编辑' : '编辑'}
            </button>
            <button type="button" disabled={loading} onClick={reject} className={btnDanger}>
              驳回
            </button>
          </div>
        </div>
      )}
      {status === 'approving' && <div className="mt-2 text-xs text-[var(--semantic-info)] ">批准中…</div>}
      {status === 'approved' && (
        <div className="mt-2 flex items-center gap-1 text-xs text-conn-emerald-text">
          <CafeIcon name="check" className="h-3.5 w-3.5 shrink-0" />
          已批准，thread 已创建{' '}
          {resultThreadId ? (
            <button
              type="button"
              data-testid="thread-link"
              onClick={() =>
                pushThreadRouteWithHistory(resultThreadId, typeof window !== 'undefined' ? window : undefined)
              }
              className="font-mono underline text-conn-emerald-text hover:opacity-80 cursor-pointer"
            >
              {resultThreadId}
            </button>
          ) : null}
        </div>
      )}
      {status === 'rejected' && (
        <div className="mt-2 flex items-center gap-1 text-xs text-conn-red-text">
          <CafeIcon name="cross" className="h-3.5 w-3.5 shrink-0" />
          已驳回
        </div>
      )}
      {error && <div className="mt-1 text-xs text-conn-red-text">{error}</div>}
    </div>
  );
}

const btnPrimary =
  'text-xs px-3 py-1 rounded bg-[var(--semantic-info)] hover:opacity-90 text-[var(--cafe-surface)] disabled:opacity-50 transition-colors';
const btnSecondary =
  'text-xs px-3 py-1 rounded bg-cafe-surface-elevated hover:bg-[var(--console-hover-bg)] dark:hover:bg-gray-700 text-cafe-secondary border border-[var(--console-border-soft)] disabled:opacity-50 transition-colors';
const btnDanger =
  'text-xs px-3 py-1 rounded bg-[var(--semantic-critical-surface)] hover:bg-red-200 dark:hover:bg-red-800/50 text-conn-red-text border border-[var(--semantic-critical)] disabled:opacity-50 transition-colors';

export function isProposalCardBlock(block: RichCardBlock): boolean {
  return block.actions?.some((a) => a.action === 'propose:approve') ?? false;
}
