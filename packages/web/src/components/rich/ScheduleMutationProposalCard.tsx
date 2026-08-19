'use client';

import type { ApprovalPublication, ScheduleMutationProposalStatus } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import type { RichCardBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';

type Decision = 'approve' | 'reject';

interface ScheduleProposalSnapshot {
  proposalId: string;
  status: ScheduleMutationProposalStatus;
  publication?: ApprovalPublication;
}

const isSettled = (status: ScheduleMutationProposalStatus): boolean => status === 'approved' || status === 'rejected';

function isServerAnchoredCard(proposal: ScheduleProposalSnapshot, messageId: string | undefined): boolean {
  return (
    typeof messageId === 'string' &&
    proposal.publication?.state === 'anchored' &&
    proposal.publication.envelope.approvalCardRef.messageId === messageId
  );
}

export function isScheduleMutationProposalCardBlock(block: RichCardBlock): boolean {
  return block.actions?.some((action) => action.action === 'schedule:approve') ?? false;
}

function extractProposalId(block: RichCardBlock): string | null {
  const action = block.actions?.find((candidate) => candidate.action === 'schedule:approve');
  const proposalId = action?.payload?.proposalId;
  return typeof proposalId === 'string' ? proposalId : null;
}

function actionLabel(block: RichCardBlock, action: `schedule:${Decision}`, fallback: string): string {
  return block.actions?.find((candidate) => candidate.action === action)?.label ?? fallback;
}

function statusLabel(status: ScheduleMutationProposalStatus): string | null {
  if (status === 'approved') return '已批准';
  if (status === 'rejected') return '已驳回';
  if (status === 'applying') return '正在执行';
  return null;
}

const approveButton =
  'rounded-lg bg-[var(--semantic-info)] px-4 py-1.5 text-xs font-semibold text-[var(--cafe-surface)] shadow-[var(--console-shadow-soft)] transition-opacity hover:opacity-90 disabled:opacity-50';
const rejectButton =
  'rounded-lg border border-[var(--semantic-critical)] bg-[var(--semantic-critical-surface)] px-4 py-1.5 text-xs font-medium text-conn-red-text transition-opacity hover:opacity-90 disabled:opacity-50';

/**
 * F139 Approval Hub card.
 *
 * Schedule cards must not fall through to CardBlock: their actions are owner-session
 * decisions against the persistent schedule proposal, not generic client callbacks.
 */
export function ScheduleMutationProposalCard({ block, messageId }: { block: RichCardBlock; messageId?: string }) {
  const proposalId = useMemo(() => extractProposalId(block), [block]);
  const [status, setStatus] = useState<ScheduleMutationProposalStatus>('pending');
  const [hydrated, setHydrated] = useState(false);
  const [hydrationError, setHydrationError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!proposalId || typeof window === 'undefined') return;
    let cancelled = false;
    let receivedLiveUpdate = false;
    setHydrated(false);
    setHydrationError(null);

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<ScheduleProposalSnapshot>).detail;
      if (!detail || detail.proposalId !== proposalId) return;
      if (!isServerAnchoredCard(detail, messageId)) return;
      receivedLiveUpdate = true;
      setStatus(detail.status);
      setHydrationError(null);
      setHydrated(true);
    };
    window.addEventListener('cat-cafe:proposal-updated', handler);

    (async () => {
      try {
        const response = await apiFetch(`/api/schedule-proposals/${proposalId}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (cancelled) return;
        const result = (await response.json()) as { proposal?: ScheduleProposalSnapshot };
        const proposal = result.proposal;
        if (!receivedLiveUpdate && proposal?.proposalId === proposalId) {
          if (!isServerAnchoredCard(proposal, messageId)) {
            setHydrationError('审批卡来源验证失败');
            return;
          }
          setStatus(proposal.status);
        }
      } catch {
        if (!cancelled && !receivedLiveUpdate) {
          setHydrationError('提案状态同步失败，请刷新后重试');
        }
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();

    return () => {
      cancelled = true;
      window.removeEventListener('cat-cafe:proposal-updated', handler);
    };
  }, [messageId, proposalId]);

  const decide = useCallback(
    async (decision: Decision) => {
      if (!proposalId) return;
      setLoading(true);
      setError(null);
      try {
        const response = await apiFetch(`/api/schedule-proposals/${proposalId}/${decision}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const result = (await response.json().catch(() => ({}))) as {
          status?: ScheduleMutationProposalStatus;
          error?: string;
        };
        if (result.status && isSettled(result.status)) {
          setStatus(result.status);
          return;
        }
        if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
        setStatus(decision === 'approve' ? 'approved' : 'rejected');
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : decision === 'approve' ? '批准失败' : '驳回失败');
      } finally {
        setLoading(false);
      }
    },
    [proposalId],
  );

  if (!proposalId) {
    return (
      <div className="rounded-lg border border-conn-red-ring bg-[var(--semantic-critical-surface)] p-3 text-xs text-conn-red-text">
        Schedule proposal card missing proposalId
      </div>
    );
  }

  const label = statusLabel(status);
  const settled = isSettled(status);

  return (
    <div className="rounded-xl border border-conn-blue-ring bg-[var(--cafe-surface-elevated)]/80 p-4 shadow-[var(--console-shadow-soft)] backdrop-blur-md">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold leading-snug text-[var(--cafe-text)]">{block.title}</div>
          {block.bodyMarkdown && (
            <div className="mt-1 text-xs leading-relaxed text-cafe-secondary [&_p]:mb-1 [&_p:last-child]:mb-0">
              <MarkdownContent content={block.bodyMarkdown} className="!text-xs" disableCommandPrefix />
            </div>
          )}
        </div>
        <span className="shrink-0 rounded-full border border-conn-blue-ring bg-conn-blue-bg px-2 py-0.5 text-xs font-medium text-conn-blue-text">
          F139
        </span>
      </div>

      {(block.fields?.length ?? 0) > 0 && (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {block.fields?.map((field) => (
            <div
              key={field.label}
              className="rounded-lg border border-[var(--console-border-soft)] bg-cafe-surface px-3 py-2 text-xs"
            >
              <div className="font-semibold text-cafe-muted">{field.label}</div>
              <div className="mt-0.5 break-all font-mono text-cafe-secondary">{field.value}</div>
            </div>
          ))}
        </div>
      )}

      {!hydrated ? (
        <div className="mt-4 border-t border-[var(--console-border-soft)] pt-3 text-xs text-cafe-muted">
          正在同步提案状态…
        </div>
      ) : hydrationError ? (
        <div className="mt-4 border-t border-[var(--console-border-soft)] pt-3 text-xs text-conn-red-text">
          {hydrationError}
        </div>
      ) : label ? (
        <div className="mt-4 flex flex-wrap items-center gap-2.5 border-t border-[var(--console-border-soft)] pt-3">
          <span
            className={`inline-flex rounded-full border px-2.5 py-1 text-xs ${
              status === 'approved'
                ? 'border-conn-green-ring bg-conn-green-bg text-conn-emerald-text'
                : status === 'rejected'
                  ? 'border-conn-red-ring bg-conn-red-bg text-conn-red-text'
                  : 'border-conn-blue-ring bg-conn-blue-bg text-conn-blue-text'
            }`}
          >
            {label}
          </span>
          {status === 'applying' && (
            <button type="button" disabled={loading} onClick={() => decide('approve')} className={approveButton}>
              {loading ? '处理中...' : '重试执行'}
            </button>
          )}
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2.5 border-t border-[var(--console-border-soft)] pt-3">
          <button
            type="button"
            disabled={loading || settled}
            onClick={() => decide('approve')}
            className={approveButton}
          >
            {loading ? '处理中...' : actionLabel(block, 'schedule:approve', '批准')}
          </button>
          <button type="button" disabled={loading || settled} onClick={() => decide('reject')} className={rejectButton}>
            {actionLabel(block, 'schedule:reject', '驳回')}
          </button>
        </div>
      )}

      {error && <div className="mt-2 text-xs text-conn-red-text">{error}</div>}
    </div>
  );
}
