'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import type { RichCardBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';

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

const btnPrimary =
  'text-xs px-3 py-1 rounded bg-[var(--semantic-info)] hover:opacity-90 text-[var(--cafe-surface)] disabled:opacity-50 transition-colors';
const btnDanger =
  'text-xs px-3 py-1 rounded bg-[var(--semantic-critical-surface)] hover:bg-red-200 dark:hover:bg-red-800/50 text-conn-red-text border border-[var(--semantic-critical)] disabled:opacity-50 transition-colors';

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
  const proposalId = useMemo(() => extractProposalId(block), [block]);
  const [status, setStatus] = useState<Status>('pending');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mount: fetch durable status so a reloaded / multi-tab card (that missed the socket event)
  // doesn't drift to stale 'pending' and re-show live buttons on a settled proposal (云端 review P2,
  // mirrors ProposalCard).
  useEffect(() => {
    if (!proposalId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/session-handoff/${proposalId}`);
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { proposal?: { status?: Status } };
        const fetched = data.proposal?.status;
        if (fetched && !cancelled) {
          // Monotonic hydration (砚砚 re-review P2): a late GET (e.g. a stale 'pending') must NOT
          // overwrite a status the user already settled by clicking approve/reject before it resolved.
          setStatus((prev) => (isSettled(prev) && !isSettled(fetched) ? prev : fetched));
        }
      } catch {
        // best-effort; keep optimistic 'pending' if the fetch fails
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [proposalId]);

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
        const res = await apiFetch(`/api/session-handoff/${proposalId}/${verb}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
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
        setLoading(false);
      }
    },
    [proposalId],
  );

  if (!proposalId) {
    return (
      <div className="border-l-4 border-l-red-400 bg-[var(--semantic-critical-surface)] rounded-r-lg p-3 text-xs text-conn-red-text">
        Handoff card missing proposalId
      </div>
    );
  }

  const settled = status === 'approved' || status === 'rejected' || status === 'expired';

  return (
    <div className="border-l-4 border-l-blue-400 bg-[var(--semantic-info-surface)] rounded-r-lg p-3">
      <div className="font-medium text-sm">{block.title}</div>
      {block.bodyMarkdown && (
        <div className="mt-1 text-xs text-cafe-secondary [&_p]:mb-1 [&_p:last-child]:mb-0">
          <MarkdownContent content={block.bodyMarkdown} className="!text-xs" disableCommandPrefix />
        </div>
      )}
      {block.fields && block.fields.length > 0 && (
        <div className="mt-2 grid grid-cols-1 gap-1 text-xs">
          {block.fields.map((f) => (
            <div key={f.label}>
              <span className="text-cafe-muted">{f.label}:</span> <span className="font-mono break-all">{f.value}</span>
            </div>
          ))}
        </div>
      )}
      {settled ? (
        <div className="mt-2 text-xs text-cafe-muted">
          {status === 'approved'
            ? '✓ 已批准，session 接力已发起'
            : status === 'rejected'
              ? '✗ 已驳回，当前 session 继续'
              : '○ 已过期'}
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" disabled={loading} onClick={() => act('approve')} className={btnPrimary}>
            {loading ? '处理中...' : '批准并接力'}
          </button>
          <button type="button" disabled={loading} onClick={() => act('reject')} className={btnDanger}>
            驳回
          </button>
        </div>
      )}
      {error && <div className="mt-1 text-xs text-conn-red-text">{error}</div>}
    </div>
  );
}
