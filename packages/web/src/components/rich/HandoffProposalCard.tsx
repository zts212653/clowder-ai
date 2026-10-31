'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApprovalHost, useGuardedWrite, useWriteBlocked } from '@/components/ApprovalHost';
import { MarkdownContent } from '@/components/MarkdownContent';
import { approvalResultRead } from '@/lib/approval-result-read';
import type { RichCardBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { originalApprovalCopy } from '../shell/mailbox/original-approval.shell-copy';
import { useShellCopy } from '../shell/shell-copy';
import { useShellPresentation } from '../shell/shell-presentation';
import { HandoffCardContent } from './HandoffCardContent';
import { HandoffResultRow } from './HandoffResultRow';
import { useApprovalStatus } from './use-approval-status';

type Status = 'pending' | 'approving' | 'approved' | 'rejected' | 'expired';

const isSettled = (s: Status): boolean => s === 'approved' || s === 'rejected' || s === 'expired';

interface HandoffSnapshot {
  proposalId: string;
  status: Status;
}

/** F225: a handoff proposal card carries a `handoff:approve` action (vs F128 `propose:approve`). */
export function isHandoffProposalCardBlock(block: RichCardBlock): boolean {
  return block.actions?.some((a) => a.action === 'handoff:approve') ?? false;
}

function extractProposalId(block: RichCardBlock): string | null {
  const action = block.actions?.find((a) => a.action === 'handoff:approve');
  const id = action?.payload?.proposalId;
  return typeof id === 'string' ? id : null;
}

const METADATA_LABELS = new Set(['封印 session']);
const LEGACY_HANDOFF_TITLE_PREFIX = String.fromCodePoint(0x1f504);

function displayHandoffTitle(title: string): string {
  return title.startsWith(LEGACY_HANDOFF_TITLE_PREFIX)
    ? title.slice(LEGACY_HANDOFF_TITLE_PREFIX.length).trimStart()
    : title;
}

function HandoffCardIcon() {
  return (
    <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-conn-blue-ring bg-conn-blue-bg text-conn-blue-text">
      <svg
        aria-hidden="true"
        data-testid="handoff-card-icon"
        viewBox="0 0 24 24"
        className="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      >
        <path d="M7 7h9.5a3.5 3.5 0 0 1 0 7H14" />
        <path d="m15 4 3 3-3 3" />
        <path d="M17 17H7.5a3.5 3.5 0 0 1 0-7H10" />
        <path d="m9 20-3-3 3-3" />
      </svg>
    </span>
  );
}

function isMetadataField(field: { label: string }): boolean {
  const lower = field.label.toLowerCase();
  return METADATA_LABELS.has(field.label) || lower.includes('worktree') || lower.includes('commit');
}

function statusPresentation(status: Status): { card: string; label: string; badge: string } {
  if (status === 'approved') {
    return {
      card: 'border-conn-green-ring shadow-[var(--console-shadow-soft)]',
      label: '已批准，session 接力已发起',
      badge: 'bg-conn-green-bg text-conn-emerald-text border-conn-green-ring',
    };
  }
  if (status === 'rejected') {
    return {
      card: 'border-conn-red-ring shadow-[var(--console-shadow-soft)]',
      label: '已驳回，当前 session 继续',
      badge: 'bg-conn-red-bg text-conn-red-text border-conn-red-ring',
    };
  }
  if (status === 'expired') {
    return {
      card: 'border-[var(--console-border-soft)] opacity-80',
      label: '提案已过期',
      badge: 'bg-cafe-surface-elevated text-cafe-muted border-[var(--console-border-soft)]',
    };
  }
  return {
    card: 'border-conn-blue-ring shadow-[var(--console-shadow-soft)]',
    label: '',
    badge: 'bg-conn-blue-bg text-conn-blue-text border-conn-blue-ring',
  };
}

const btnPrimary =
  'text-xs font-semibold px-4 py-1.5 rounded-lg bg-[var(--semantic-info)] hover:opacity-90 text-[var(--cafe-surface)] shadow-[var(--console-shadow-soft)] disabled:opacity-50 transition-all transform hover:-translate-y-[0.5px] active:translate-y-0';
const btnDanger =
  'text-xs font-medium px-4 py-1.5 rounded-lg bg-[var(--semantic-critical-surface)] hover:opacity-90 text-conn-red-text border border-[var(--semantic-critical)] disabled:opacity-50 transition-colors';

/** Optimistic per-verb defaults (the server result, when present, still wins — see act()). */
const VERB_OUTCOME = {
  approve: { settled: 'approved' as Status, failMsg: '批准失败' },
  reject: { settled: 'rejected' as Status, failMsg: '驳回失败' },
};

/**
 * F225 confirmation card for cat-initiated session handoff. Unlike F128 ProposalCard it does NOT
 * create a thread — approve seals the CURRENT session + enqueues a same-cat continuation, reject
 * leaves the session running. Wires the buttons to POST /api/session-handoff/:id/approve|reject;
 * without this the card renders but the buttons are inert (fell through to generic CardBlock — 砚砚 P1-2).
 */
export function HandoffProposalCard({ block }: { block: RichCardBlock; messageId?: string }) {
  const host = useApprovalHost();
  const shell = useShellPresentation();
  const compact = host.presentation === 'mailbox' || shell === 'v2';
  const copy = useShellCopy(originalApprovalCopy);
  const guardedWrite = useGuardedWrite();
  const proposalId = useMemo(() => extractProposalId(block), [block]);
  const native = useApprovalStatus('F225', proposalId, `/api/session-handoff/${encodeURIComponent(proposalId ?? '')}`);
  const nativeStatus = ['pending', 'approving', 'approved', 'rejected', 'expired'].includes(native.status ?? '')
    ? (native.status as Status)
    : null;
  const [status, setStatus] = useState<Status>(() => nativeStatus ?? 'pending');
  const [loading, setLoading] = useState(false);
  const [statusKnown, setStatusKnown] = useState(false);
  const writeBlocked = useWriteBlocked(
    loading || status === 'approving' || (host.presentation === 'mailbox' && !statusKnown),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!nativeStatus) return;
    setStatusKnown(true);
    setStatus((previous) => (isSettled(previous) && !isSettled(nativeStatus) ? previous : nativeStatus));
  }, [nativeStatus]);

  // Reflect async / other-tab approve via the same socket event ProposalCard listens to.
  useEffect(() => {
    if (!proposalId || typeof window === 'undefined') return;
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<HandoffSnapshot>).detail;
      if (!detail || detail.proposalId !== proposalId) return;
      setStatus(detail.status);
    };
    window.addEventListener('cat-cafe:proposal-updated', handler);
    return () => window.removeEventListener('cat-cafe:proposal-updated', handler);
  }, [proposalId]);

  const act = useCallback(
    async (verb: 'approve' | 'reject') => {
      if (!proposalId) return;
      const { settled: settledStatus, failMsg } = VERB_OUTCOME[verb];
      setLoading(true);
      setError(null);
      try {
        const attempt = await guardedWrite('producer-card', async (reportEvidence) => {
          const response = await apiFetch(`/api/session-handoff/${proposalId}/${verb}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          reportEvidence({ outcome: response.ok ? 'settled' : 'http-error', status: response.status });
          return response;
        });
        if (!attempt.sent) return;
        const res = attempt.value;
        const data = (await res.json().catch(() => ({}))) as { status?: Status; error?: string };
        // Converge to a SETTLED server status whenever the server reports one — REGARDLESS of res.ok.
        // Covers success, reject-after-expire dedup ({status:'expired'}), AND a 409 on an already-
        // terminal proposal (stale/cross-tab card clicking approve — gpt52 P2). A transient 'approving'
        // or a status-less body falls through, so a retryable 409 still surfaces as a retryable error
        // and a body-less success still applies the optimistic verb.
        if (data.status && isSettled(data.status)) {
          setStatus(data.status);
          return;
        }
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setStatus(settledStatus);
      } catch (err) {
        setError(err instanceof Error ? err.message : failMsg);
      } finally {
        approvalResultRead.invalidate({ producer: 'F225', proposalId });
        setLoading(false);
      }
    },
    [proposalId, guardedWrite],
  );

  const { metadataFields, contentFields } = useMemo(() => {
    const metadata: Array<{ label: string; value: string }> = [];
    const content: Array<{ label: string; value: string }> = [];
    for (const field of block.fields ?? []) {
      (isMetadataField(field) ? metadata : content).push(field);
    }
    return { metadataFields: metadata, contentFields: content };
  }, [block.fields]);
  const originalTitle = displayHandoffTitle(block.title);
  const title =
    compact && originalTitle === '提议 session 接力（封印当前 → 续接 fresh 自己）' ? copy.handoffTitle : originalTitle;
  const body =
    compact && block.bodyMarkdown?.endsWith(' 想在干净断点封印当前 session，把这份亲手写的交接带给续接的自己。')
      ? copy.handoffReason
      : block.bodyMarkdown;
  const settled = isSettled(status);
  const presentation = statusPresentation(status);

  if (!proposalId) {
    return (
      <div className="border border-conn-red-ring bg-[var(--semantic-critical-surface)] rounded-lg p-3 text-xs text-conn-red-text">
        Handoff card missing proposalId
      </div>
    );
  }

  if (compact && settled) {
    return (
      <HandoffResultRow
        status={status === 'approved' ? 'approved' : status === 'rejected' ? 'rejected' : 'expired'}
        block={block}
        title={title}
        body={body}
        error={error}
        actions={host.originalPlaceAction}
      />
    );
  }

  return (
    <div
      className={`border bg-[var(--cafe-surface-elevated)]/80 backdrop-blur-md rounded-xl p-4 transition-all duration-300 ${presentation.card}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <HandoffCardIcon />
          <div className="min-w-0">
            <div className="font-semibold text-sm text-[var(--cafe-text)] leading-snug">{title}</div>
            {body && (
              <div className="mt-1 text-xs text-cafe-secondary leading-relaxed [&_p]:mb-1 [&_p:last-child]:mb-0">
                <MarkdownContent content={body} className="!text-xs" disableCommandPrefix />
              </div>
            )}
          </div>
        </div>
        {!compact ? (
          <span
            title="F225 session handoff"
            className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${presentation.badge}`}
          >
            F225
          </span>
        ) : null}
      </div>
      {compact ? (
        <HandoffCardContent fields={block.fields ?? []} />
      ) : (
        <>
          {metadataFields.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {metadataFields.map((field) => (
                <div
                  key={field.label}
                  className="flex min-w-0 items-center gap-1 rounded-full border border-[var(--console-border-soft)] bg-cafe-surface px-2 py-0.5 text-xs font-mono text-cafe-muted"
                >
                  <span>{field.label}:</span>
                  <span className="max-w-[12rem] truncate font-semibold text-cafe-secondary">{field.value}</span>
                </div>
              ))}
            </div>
          )}
          {contentFields.length > 0 && (
            <div className="mt-3 space-y-2.5">
              {contentFields.map((field) => (
                <section
                  key={field.label}
                  className="relative rounded-lg border border-[var(--console-border-soft)] bg-cafe-surface p-3"
                >
                  <div className="absolute left-0 top-3 bottom-3 w-0.5 rounded-full bg-conn-blue-ring" />
                  <div className="pl-2">
                    <div className="mb-1 text-xs font-semibold uppercase text-conn-blue-text">{field.label}</div>
                    <div className="text-xs leading-relaxed text-cafe-secondary [&_code]:text-xs [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:mb-1 [&_p:last-child]:mb-0 [&_ul]:list-disc [&_ul]:pl-4">
                      <MarkdownContent content={field.value} className="!text-xs" disableCommandPrefix />
                    </div>
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      )}
      {settled ? (
        <div className="mt-4 border-t border-[var(--console-border-soft)] pt-3">
          <div
            data-testid="original-approval-terminal"
            className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs ${presentation.badge}`}
          >
            {compact
              ? status === 'approved'
                ? copy.handoffApproved
                : status === 'rejected'
                  ? copy.handoffRejected
                  : copy.expired
              : presentation.label}
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2.5 border-t border-[var(--console-border-soft)] pt-3">
          <button
            type="button"
            disabled={writeBlocked}
            onClick={() => act('approve')}
            className={
              compact ? 'shell-focusable rounded-lg px-4 py-1.5 text-xs font-semibold disabled:opacity-50' : btnPrimary
            }
            style={compact ? { background: 'var(--shell-primary)', color: 'var(--shell-primary-on)' } : undefined}
          >
            {loading ? (compact ? copy.processing : '处理中...') : compact ? copy.approveHandoff : '批准并接力'}
          </button>
          <button type="button" disabled={writeBlocked} onClick={() => act('reject')} className={btnDanger}>
            {compact ? copy.reject : '驳回'}
          </button>
        </div>
      )}
      {host.originalPlaceAction ? (
        <div className="mt-3 flex flex-wrap justify-end gap-2">{host.originalPlaceAction}</div>
      ) : null}
      {error && <div className="mt-2 text-xs text-conn-red-text">{error}</div>}
    </div>
  );
}
