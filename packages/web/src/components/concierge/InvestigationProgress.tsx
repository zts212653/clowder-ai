'use client';

/**
 * F229 AC-B2: InvestigationProgress — poll investigation job + render report
 *
 * State machine (mirrors backend InvestigationJobStatus):
 *   queued → running → done(report) | failed | cancelled
 *
 * Polling: 2s interval while queued/running. Stops on terminal state.
 * Cancel: POST /api/concierge/investigation/:jobId/cancel
 *
 * Report rendering: summary + clickable anchor list.
 *   thread anchor → planTeleport for message-level precision (P1-2 fix)
 *   doc/feature → display path
 *   github → external link
 */

import type { InvestigationAnchor, InvestigationJobStatus, InvestigationReport } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import { useChatStore } from '@/stores/chatStore';
import { useConciergeStore } from '@/stores/conciergeStore';
import { apiFetch } from '@/utils/api-client';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { kickTeleportResolve, planTeleport } from '@/utils/teleport';

const POLL_INTERVAL_MS = 2000;
const TERMINAL_STATES: ReadonlySet<InvestigationJobStatus> = new Set(['done', 'failed', 'cancelled']);

interface JobState {
  status: InvestigationJobStatus;
  report?: InvestigationReport;
}

/** Fetch current job state from backend. Returns null on network/HTTP error. */
async function fetchJobState(jobId: string): Promise<JobState | null> {
  const res = await apiFetch(`/api/concierge/investigation/${jobId}`);
  if (!res.ok) return null;
  const data = (await res.json()) as { job: JobState };
  return data.job;
}

interface InvestigationProgressProps {
  jobId: string;
}

export function InvestigationProgress({ jobId }: InvestigationProgressProps) {
  const [status, setStatus] = useState<InvestigationJobStatus>('queued');
  const [report, setReport] = useState<InvestigationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unmountedRef = useRef(false);
  // Stable ref so the interval callback always reads fresh jobId without restarting the effect
  const jobIdRef = useRef(jobId);
  jobIdRef.current = jobId;
  // Cloud P2-1: Guard against stale in-flight poll responses overwriting terminal state.
  // When setInterval fires faster than a poll round-trip, an older request can resolve
  // after a newer one has already reached a terminal state, regressing the UI to a spinner.
  const terminalReachedRef = useRef(false);

  /** Stop the polling interval. Safe to call multiple times. */
  const stopPolling = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /** Apply a fetched job state to component state. Stops polling on terminal states. */
  const applyJobState = useCallback(
    (job: JobState) => {
      // Cloud P2-1: Once a terminal state is reached, ignore stale non-terminal responses
      if (terminalReachedRef.current && !TERMINAL_STATES.has(job.status)) {
        return;
      }
      setStatus(job.status);
      if (job.status === 'done' && job.report) {
        setReport(job.report);
      }
      if (TERMINAL_STATES.has(job.status)) {
        terminalReachedRef.current = true;
        stopPolling();
      }
    },
    [stopPolling],
  );

  useEffect(() => {
    unmountedRef.current = false;
    terminalReachedRef.current = false;

    async function poll(): Promise<void> {
      if (unmountedRef.current) return;
      const job = await fetchJobState(jobIdRef.current).catch(() => null);
      if (unmountedRef.current) return;
      if (job) {
        setError(null);
        applyJobState(job);
      } else {
        // Transient error: show message but keep polling — next tick retries.
        // Only terminal states (in applyJobState) should stop the interval.
        setError('查询失败');
      }
    }

    // Initial poll + start interval
    poll();
    timerRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      unmountedRef.current = true;
      stopPolling();
    };
  }, [jobId, applyJobState, stopPolling]);

  const handleCancel = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/concierge/investigation/${jobIdRef.current}/cancel`, {
        method: 'POST',
      });
      if (res.ok) {
        terminalReachedRef.current = true;
        setStatus('cancelled');
        stopPolling();
        return;
      }
      // P1-3 fix: 409 = job already in terminal state (done/failed/cancelled).
      // Re-poll once to reveal the actual terminal state instead of hiding a completed report.
      const job = await fetchJobState(jobIdRef.current);
      if (job) applyJobState(job);
      // Cloud P2-2: Do NOT unconditionally stopPolling() here.
      // If the re-polled job is still non-terminal (e.g. cancel 500 + job still running),
      // applyJobState won't stop the interval, so it continues polling until terminal.
    } catch {
      setError('取消失败');
    }
  }, [applyJobState, stopPolling]);

  // --- Render ---

  if (status === 'done' && report) {
    return <InvestigationReportCard report={report} />;
  }

  if (status === 'failed') {
    return (
      <div data-testid="investigation-failed" className="mt-2 text-xs text-conn-red-text">
        调查失败，请重试
      </div>
    );
  }

  if (status === 'cancelled') {
    return (
      <div data-testid="investigation-cancelled" className="mt-2 text-xs text-cafe-secondary">
        调查已取消
      </div>
    );
  }

  // queued / running → progress indicator
  return (
    <div data-testid="investigation-progress" className="mt-2 flex items-center gap-2 text-xs text-cafe-secondary">
      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
      <span>{status === 'running' ? '正在调查...' : '排队中...'}</span>
      <button
        type="button"
        data-testid="investigation-cancel"
        onClick={handleCancel}
        className="ml-auto text-xs text-conn-red-text hover:underline"
      >
        取消
      </button>
      {error && <span className="text-conn-red-text">{error}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// InvestigationReportCard — render report summary + clickable anchors
// ---------------------------------------------------------------------------

/**
 * Strip anchor marker syntax from summary text.
 * Backend buildReport() embeds markers like [跳过去 R1], [查看 R2], [链接 R3], [R4]
 * intended for text-only rendering. Since anchors render as clickable items below,
 * strip these prefixes so users don't see raw bracket syntax.
 */
const ANCHOR_MARKER_RE = /^\[(?:跳过去|查看|链接)?\s*R\d+\]\s*/gm;

function InvestigationReportCard({ report }: { report: InvestigationReport }) {
  const cleanSummary = report.summary.replace(ANCHOR_MARKER_RE, '');
  return (
    <div data-testid="investigation-report" className="mt-2 space-y-2">
      <div className="text-xs text-cafe-primary">{cleanSummary}</div>
      {report.anchors.length > 0 && (
        <div className="space-y-1">
          {report.anchors.map((anchor) => (
            <AnchorItem key={anchor.handle} anchor={anchor} />
          ))}
        </div>
      )}
    </div>
  );
}

function AnchorItem({ anchor }: { anchor: InvestigationAnchor }) {
  const handleThreadClick = useCallback(() => {
    if (anchor.kind !== 'thread' || !anchor.threadId) return;

    useConciergeStore.getState().onNavigationAction();

    if (anchor.messageId) {
      // P1-2 fix: message-level navigation via planTeleport (same pattern as CardBlock handleConciergeTeleport)
      const currentThreadId = useChatStore.getState().currentThreadId;
      const plan = planTeleport({ threadId: anchor.threadId, messageId: anchor.messageId, currentThreadId });
      if (plan.scrollNow) {
        scrollToMessage(plan.scrollNow);
        kickTeleportResolve();
      } else if (plan.navigateTo) {
        pushThreadRouteWithHistory(plan.navigateTo, window);
      }
    } else {
      pushThreadRouteWithHistory(anchor.threadId, window);
    }
  }, [anchor]);

  if (anchor.kind === 'thread' && anchor.threadId) {
    return (
      <button
        type="button"
        data-testid="anchor-link-thread"
        onClick={handleThreadClick}
        className="flex items-start gap-1.5 w-full text-left text-xs group hover:bg-cafe-hover rounded px-1 py-0.5"
      >
        <span className="font-mono text-conn-blue-text shrink-0">{anchor.handle}</span>
        <span className="group-hover:underline text-conn-blue-text">{anchor.title}</span>
        <span className="text-cafe-tertiary ml-auto shrink-0 hidden sm:inline">{anchor.relevance}</span>
      </button>
    );
  }

  if (anchor.kind === 'github' && anchor.path) {
    return (
      <a
        href={anchor.path}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="anchor-link-github"
        className="flex items-start gap-1.5 text-xs group hover:bg-cafe-hover rounded px-1 py-0.5"
      >
        <span className="font-mono text-conn-blue-text shrink-0">{anchor.handle}</span>
        <span className="group-hover:underline text-conn-blue-text">{anchor.title}</span>
        <span className="text-cafe-tertiary ml-auto shrink-0 hidden sm:inline">{anchor.relevance}</span>
      </a>
    );
  }

  // doc / feature / unknown — display path inline, not clickable
  return (
    <div
      data-testid={`anchor-link-${anchor.kind}`}
      className="flex items-start gap-1.5 text-xs hover:bg-cafe-hover rounded px-1 py-0.5"
    >
      <span className="font-mono text-conn-blue-text shrink-0">{anchor.handle}</span>
      <span className="text-cafe-primary">{anchor.title}</span>
      {anchor.path && <span className="font-mono text-cafe-tertiary ml-1 truncate">{anchor.path}</span>}
      <span className="text-cafe-tertiary ml-auto shrink-0 hidden sm:inline">{anchor.relevance}</span>
    </div>
  );
}
