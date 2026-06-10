'use client';

/**
 * F222: Frustration Auto-Issue Card — specialized renderer for auto-detected issues.
 *
 * Renders the issue context (error details, recent messages) with confirm/skip actions.
 * Follows the F128 ProposalCard pattern: useState for status, apiFetch for API calls.
 */

import { useEffect, useRef, useState } from 'react';
import type { RichCardBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';

interface FrustrationIssueCardProps {
  block: RichCardBlock;
  messageId?: string;
}

type IssueStatus =
  | 'draft'
  | 'confirming'
  | 'confirmed'
  | 'skipping'
  | 'skipped'
  | 'reporting_false_positive'
  | 'false_positive'
  | 'error';

interface FrustrationIssueStatusResponse {
  issue?: {
    status?: 'draft' | 'confirmed' | 'skipped' | 'false_positive';
    userDescription?: string;
  };
}

function isResolvedIssueStatus(status: IssueStatus): status is 'confirmed' | 'skipped' | 'false_positive' {
  return status === 'confirmed' || status === 'skipped' || status === 'false_positive';
}

/**
 * Detect if a card block is a frustration auto-issue card.
 * Checks meta.kind = 'frustration_auto_issue' from trusted source.
 */
export function isFrustrationIssueCardBlock(block: RichCardBlock, messageSource?: { connector?: string }): boolean {
  const metaKind = (block.meta as { kind?: string } | undefined)?.kind;
  return metaKind === 'frustration_auto_issue' && messageSource?.connector === 'frustration-auto-issue';
}

function extractIssueId(block: RichCardBlock): string | null {
  return (block.meta as { issueId?: string } | undefined)?.issueId ?? null;
}

/** Status badge label for resolved states. */
function resolvedLabel(status: IssueStatus): string {
  if (status === 'confirmed') return '已提交';
  if (status === 'false_positive') return '误报';
  return '已跳过';
}

/** Status badge color class for resolved states. */
function resolvedBadgeClass(status: IssueStatus): string {
  if (status === 'confirmed') return 'bg-green-100 text-green-700';
  if (status === 'false_positive') return 'bg-orange-100 text-orange-700';
  return 'bg-cafe-muted/20 text-cafe-muted';
}

export function FrustrationIssueCard({ block }: FrustrationIssueCardProps) {
  const issueId = extractIssueId(block);
  const [status, setStatus] = useState<IssueStatus>('draft');
  const [error, setError] = useState<string | null>(null);
  const [userDescription, setUserDescription] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const actionEpochRef = useRef(0);

  const isResolved = isResolvedIssueStatus(status);

  useEffect(() => {
    if (!issueId) return;
    let cancelled = false;
    const hydrationEpoch = actionEpochRef.current;

    const hydrateStatus = async () => {
      try {
        const res = await apiFetch(`/api/frustration-issues/${issueId}/status`);
        if (!res.ok) return;
        const data = (await res.json()) as FrustrationIssueStatusResponse;
        const nextStatus = data.issue?.status;
        if (cancelled) return;
        if (!nextStatus) return;
        if (actionEpochRef.current !== hydrationEpoch && nextStatus === 'draft') return;
        setStatus(nextStatus);
        if (nextStatus === 'confirmed' || nextStatus === 'skipped' || nextStatus === 'false_positive') {
          setError(null);
          setCollapsed(true);
        }
        if (typeof data.issue?.userDescription === 'string') {
          setUserDescription(data.issue.userDescription);
        }
      } catch {
        // Status hydration is best-effort; keep the original draft UI if unavailable.
      }
    };

    void hydrateStatus();

    return () => {
      cancelled = true;
    };
  }, [issueId]);

  const isActionInProgress = status === 'confirming' || status === 'skipping' || status === 'reporting_false_positive';

  const handleConfirm = async () => {
    if (!issueId) return;
    actionEpochRef.current += 1;
    setStatus('confirming');
    setError(null);
    try {
      const res = await apiFetch(`/api/frustration-issues/${issueId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(userDescription ? { userDescription } : {}),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setStatus('confirmed');
      setCollapsed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
      setStatus((currentStatus) => (isResolvedIssueStatus(currentStatus) ? currentStatus : 'draft'));
    }
  };

  const handleSkip = async () => {
    if (!issueId) return;
    actionEpochRef.current += 1;
    setStatus('skipping');
    setError(null);
    try {
      const res = await apiFetch(`/api/frustration-issues/${issueId}/skip`, {
        method: 'POST',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setStatus('skipped');
      setCollapsed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
      setStatus((currentStatus) => (isResolvedIssueStatus(currentStatus) ? currentStatus : 'draft'));
    }
  };

  const handleFalsePositive = async () => {
    if (!issueId) return;
    actionEpochRef.current += 1;
    setStatus('reporting_false_positive');
    setError(null);
    try {
      const res = await apiFetch(`/api/frustration-issues/${issueId}/false-positive`, {
        method: 'POST',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setStatus('false_positive');
      setCollapsed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
      setStatus((currentStatus) => (isResolvedIssueStatus(currentStatus) ? currentStatus : 'draft'));
    }
  };

  // ── UX-2: Collapsed view for resolved cards ──────────────────
  if (isResolved && collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="flex w-full items-center gap-2 rounded-lg border border-cafe/20 bg-cafe-surface/30 px-3 py-2 text-left text-sm transition hover:bg-cafe-surface/50"
      >
        <span className="text-base">🔍</span>
        <span className="flex-1 truncate text-cafe-muted">{block.title}</span>
        <span className={`rounded px-2 py-0.5 text-xs ${resolvedBadgeClass(status)}`}>{resolvedLabel(status)}</span>
        <span className="text-xs text-cafe-muted/50">▸</span>
      </button>
    );
  }

  return (
    <div
      className={`rounded-lg border ${isResolved ? 'border-cafe/30 bg-cafe-surface/50' : 'border-amber-500/40 bg-amber-50/10'} p-3 text-sm`}
    >
      {/* Header */}
      <div className="mb-2 flex items-center gap-2">
        <span className="text-lg">🔍</span>
        <span className="font-medium text-cafe-text">{block.title}</span>
        {isResolved && (
          <>
            <span className={`ml-auto rounded px-2 py-0.5 text-xs ${resolvedBadgeClass(status)}`}>
              {resolvedLabel(status)}
            </span>
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              className="text-xs text-cafe-muted/50 transition hover:text-cafe-muted"
              title="收起"
            >
              ▾
            </button>
          </>
        )}
      </div>

      {/* Body */}
      {block.bodyMarkdown && (
        <div className="mb-2 whitespace-pre-wrap text-xs text-cafe-text/80">{block.bodyMarkdown}</div>
      )}

      {/* Fields */}
      {block.fields && block.fields.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1">
          {block.fields.map((f) => (
            <span key={f.label} className="text-xs">
              <span className="text-cafe-muted">{f.label}:</span> <span className="text-cafe-text">{f.value}</span>
            </span>
          ))}
        </div>
      )}

      {/* Actions — only when draft */}
      {!isResolved && (
        <div className="mt-3 space-y-2">
          {/* Description input */}
          <input
            type="text"
            placeholder={'补充描述（可选，比如"每次打开都这样"）'}
            value={userDescription}
            onChange={(e) => setUserDescription(e.target.value)}
            className="w-full rounded border border-cafe/30 bg-cafe-surface px-2 py-1.5 text-xs text-cafe-text placeholder:text-cafe-muted/50 focus:border-cafe focus:outline-none"
            disabled={isActionInProgress}
          />

          {/* Buttons — 3-way: confirm / skip / false positive (UX-1) */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleConfirm}
              disabled={isActionInProgress}
              className="rounded bg-cafe-accent px-3 py-1.5 text-xs font-medium text-white transition hover:bg-cafe-accent/80 disabled:opacity-50"
            >
              {status === 'confirming' ? '提交中...' : '确认提交'}
            </button>
            <button
              type="button"
              onClick={handleSkip}
              disabled={isActionInProgress}
              className="rounded border border-cafe/30 px-3 py-1.5 text-xs text-cafe-muted transition hover:bg-cafe-surface disabled:opacity-50"
            >
              {status === 'skipping' ? '跳过中...' : '跳过'}
            </button>
            <button
              type="button"
              onClick={handleFalsePositive}
              disabled={isActionInProgress}
              className="rounded border border-orange-300/50 px-3 py-1.5 text-xs text-orange-600 transition hover:bg-orange-50/30 disabled:opacity-50"
            >
              {status === 'reporting_false_positive' ? '标记中...' : '误报'}
            </button>
          </div>

          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>
      )}
    </div>
  );
}
