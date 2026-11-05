import type { EventMemoryCorrectionProposalView } from '@cat-cafe/shared';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useApprovalHost, useGuardedWrite, useWriteBlocked } from '@/components/ApprovalHost';
import { resolveShellCopy } from '@/components/shell/shell-copy';
import { useShellLanguage } from '@/components/shell/shell-language';
import { useCatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { memoryCorrectionCopy } from './memory-correction.shell-copy';

export type MemoryCorrectionDecision = 'approve' | 'reject';
type Proposal = Pick<
  EventMemoryCorrectionProposalView,
  'proposalId' | 'status' | 'expectedRevision' | 'reason' | 'sourceCatId'
>;

/** Shared presentation only; each original lane supplies its own endpoint and receipt contract. */
export function MemoryCorrectionCard({
  proposal,
  revision,
  noun,
  endpoint,
  matchesReceipt,
  reread,
  children,
  heading,
  beforeWrite,
  afterWrite,
  localized = false,
}: {
  proposal: Proposal;
  revision: string;
  noun: '事件' | '品味';
  endpoint: string;
  matchesReceipt: (body: unknown, proposalId: string, decision: MemoryCorrectionDecision) => boolean;
  reread: () => void;
  children: ReactNode;
  heading?: ReactNode;
  beforeWrite?: (decision: MemoryCorrectionDecision) => Promise<boolean>;
  afterWrite?: () => Promise<void>;
  localized?: boolean;
}) {
  const host = useApprovalHost(),
    guardedWrite = useGuardedWrite(),
    language = useShellLanguage();
  const t = resolveShellCopy(memoryCorrectionCopy, host.presentation === 'mailbox' || localized ? language : 'zh');
  const { getCatById } = useCatData();
  const cat = getCatById(proposal.sourceCatId);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState<MemoryCorrectionDecision | null>(null);
  const blocked = useWriteBlocked(busy);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function reportUnknown(decision: MemoryCorrectionDecision) {
    if (!mounted.current) return;
    setError(t.unknown);
    setRetry(decision);
  }
  async function decide(decision: MemoryCorrectionDecision) {
    if (inFlight.current || blocked) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      if (beforeWrite && !(await beforeWrite(decision))) {
        if (mounted.current) {
          setError(t.changed);
          setRetry(null);
        }
        return;
      }
      if (!mounted.current) return;
      const written = await guardedWrite('producer-card', async (report) => {
        const response = await apiFetch(`${endpoint}/${encodeURIComponent(proposal.proposalId)}/${decision}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!response.ok) report({ outcome: 'http-error', status: response.status });
        const body: unknown = await response.json().catch(() => null);
        return { response, body };
      });
      if (!written.sent) return;
      const { response, body } = written.value;
      if (!mounted.current) return;
      if (response.ok && matchesReceipt(body, proposal.proposalId, decision)) {
        reread();
        return;
      }
      const uncertain = response.ok || response.status >= 500;
      setError(uncertain ? t.unknown : response.status === 409 ? t.changed : t.unavailable);
      setRetry(uncertain ? decision : null);
    } catch {
      reportUnknown(decision);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
      await afterWrite?.();
    }
  }
  const stale = proposal.expectedRevision !== revision;
  const pending = proposal.status === 'pending';
  const primaryClass =
    host.presentation === 'mailbox'
      ? 'shell-focusable rounded-md px-3 py-1.5 disabled:opacity-50'
      : 'text-compact text-cafe-accent';
  const primaryStyle =
    host.presentation === 'mailbox'
      ? { background: 'var(--shell-primary)', color: 'var(--shell-primary-on)' }
      : undefined;
  return (
    <article
      data-testid={`memory-correction-${proposal.proposalId}`}
      className="space-y-3 rounded-lg bg-cafe-surface-sunken p-4"
    >
      {heading ?? (
        <p className="text-compact font-medium">
          {cat?.nickname || cat?.displayName || t.unavailableCat}
          {t.suggestion} · {t.statuses[proposal.status]}
        </p>
      )}
      <p className="text-compact text-cafe-muted">{t.reasons[proposal.reason]}</p>
      {children}
      {pending && stale && <p className="text-compact text-cafe-muted">{t.stale}</p>}
      {error && (
        <p role="alert" className="text-compact">
          {error}
        </p>
      )}
      {pending && (
        <div className="flex flex-wrap gap-3 text-compact text-cafe-accent">
          <button
            type="button"
            className={primaryClass}
            style={primaryStyle}
            disabled={blocked || !!error || stale}
            onClick={() => void decide('approve')}
          >
            {t.accept}
          </button>
          <button
            type="button"
            className={
              host.presentation === 'mailbox'
                ? 'shell-focusable rounded-md border border-[var(--shell-hairline)] px-3 py-1.5 disabled:opacity-50'
                : undefined
            }
            disabled={blocked || !!error}
            onClick={() => void decide('reject')}
          >
            {t.reject}
          </button>
        </div>
      )}
      {proposal.status === 'approving' && !error && (
        <button
          type="button"
          disabled={blocked}
          onClick={() => void decide('approve')}
          className={primaryClass}
          style={primaryStyle}
        >
          {t.resume}
        </button>
      )}
      {(error || proposal.status === 'approving') && (
        <div className="flex gap-3 text-compact text-cafe-accent">
          {retry && (
            <button
              type="button"
              className={primaryClass}
              style={primaryStyle}
              disabled={blocked}
              onClick={() => void decide(retry)}
            >
              {t.retry}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setError('');
              setRetry(null);
              reread();
            }}
          >
            {t.reread[noun]}
          </button>
        </div>
      )}
      {host.originalPlaceAction ? (
        <div className="ml-auto flex w-fit max-w-full flex-none items-center justify-end gap-2">
          {host.originalPlaceAction}
        </div>
      ) : null}
    </article>
  );
}
