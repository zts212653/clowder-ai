import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '@/utils/api-client';
import { useShellCopy } from '../shell-copy';
import { personProposalForgetCopy } from './person-proposal-forget.shell-copy';
import {
  executePendingProposalForget,
  type PendingProposalForget,
  savePendingProposalForget,
  usePendingProposalForgets,
} from './proposal-forget-recovery';

const previewSchema = z.union([
  z.object({
    outcome: z.literal('eligible'),
    count: z.number().int().min(1).max(32),
    revision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    proposalIds: z
      .array(z.string().regex(/^person_candidate_[A-Za-z0-9._:-]+$/))
      .min(1)
      .max(32),
  }),
  z.object({ outcome: z.enum(['person_bound', 'conflict', 'absent', 'stale_revision']) }),
]);
type Preview = z.infer<typeof previewSchema>;

export function PersonProposalForget({
  proposalId,
  ownerUserId,
  onForgotten,
  authorize,
}: {
  proposalId: string;
  ownerUserId: string;
  onForgotten: (count: number, ids: string[]) => void;
  authorize: () => boolean;
}) {
  const t = useShellCopy(personProposalForgetCopy);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [storageFailed, setStorageFailed] = useState(false);
  const pending = usePendingProposalForgets(ownerUserId).some((command) => command.proposalId === proposalId);
  const request = useRef<PendingProposalForget | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && (preview || readFailed)) box.current?.scrollIntoView({ block: 'nearest' });
  }, [open, preview, readFailed]);

  async function inspect() {
    if (!authorize()) return;
    setOpen(true);
    setBusy(true);
    setPreview(null);
    setConfirmed(false);
    setReadFailed(false);
    setStorageFailed(false);
    request.current = null;
    try {
      const response = await apiFetch(`/api/person-memory-proposals/${encodeURIComponent(proposalId)}/forget`);
      if (!response.ok) throw new Error('preview unavailable');
      const result = previewSchema.parse(await response.json());
      setPreview(result);
      if (result.outcome === 'eligible')
        request.current = {
          proposalId,
          proposalIds: result.proposalIds,
          requestId: `person_forget_${crypto.randomUUID()}`,
          expectedRevision: result.revision,
        };
    } catch {
      setReadFailed(true);
    } finally {
      setBusy(false);
    }
  }

  async function forget() {
    if (!request.current || busy || !confirmed || !authorize()) return;
    if (!savePendingProposalForget(ownerUserId, request.current)) {
      setStorageFailed(true);
      return;
    }
    setBusy(true);
    const result = await executePendingProposalForget(ownerUserId, request.current);
    setBusy(false);
    if (result.outcome === 'purged' || result.outcome === 'already_absent')
      onForgotten(result.count, request.current.proposalIds);
    else if (result.outcome !== 'unknown') setPreview({ outcome: result.outcome });
    else setOpen(false);
  }

  return (
    <div data-testid="person-proposal-forget" className="contents">
      <button
        type="button"
        disabled={busy || pending}
        className="shell-focusable text-compact text-[var(--shell-body)] underline underline-offset-4 disabled:opacity-50"
        onClick={() => void inspect()}
      >
        {pending ? t.pending : t.entry}
      </button>
      {open && !pending ? (
        <div
          ref={box}
          role="group"
          aria-label={t.group}
          className="order-2 w-full basis-full space-y-3 rounded-lg p-3 text-compact leading-relaxed"
          data-chat-background-surface="frame"
          style={{ background: 'var(--shell-frame)' }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !busy) {
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          {readFailed ? <p role="alert">{t.readFailed}</p> : null}
          {storageFailed ? <p role="alert">{t.storageFailed}</p> : null}
          {!preview && !readFailed ? <p>{t.reading}</p> : null}
          {preview?.outcome === 'eligible' ? (
            <>
              <p>{t.scope(preview.count)}</p>
              <p className="text-[var(--shell-muted)]">{t.retained}</p>
              <label className="flex cursor-pointer items-start gap-2 py-1">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 shrink-0 accent-[var(--shell-primary)]"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                {t.confirmation}
              </label>
            </>
          ) : null}
          {preview?.outcome === 'person_bound' ? <p>{t.bound}</p> : null}
          {preview?.outcome === 'conflict' ? <p>{t.conflict}</p> : null}
          {preview?.outcome === 'stale_revision' ? <p>{t.stale}</p> : null}
          {preview?.outcome === 'absent' ? <p>{t.absent}</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="shell-nav-row shell-focusable h-8 rounded-lg border border-[var(--shell-hairline-strong)] bg-[var(--shell-paper)] px-3 text-compact disabled:opacity-50"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              {t.cancel}
            </button>
            {preview?.outcome === 'eligible' ? (
              <button
                type="button"
                className="shell-nav-row shell-focusable h-8 rounded-lg border border-[var(--shell-hairline-strong)] bg-[var(--shell-paper)] px-3 text-compact font-medium disabled:opacity-40"
                disabled={busy || !confirmed}
                onClick={() => void forget()}
              >
                {busy ? t.busy : t.forget}
              </button>
            ) : preview?.outcome === 'person_bound' ? (
              <a
                className="shell-nav-row shell-focusable flex h-8 items-center rounded-lg border border-[var(--shell-hairline-strong)] bg-[var(--shell-paper)] px-3 text-compact"
                href="/memory"
              >
                {t.memory}
              </a>
            ) : (
              <button
                type="button"
                className="shell-nav-row shell-focusable h-8 rounded-lg border border-[var(--shell-hairline-strong)] bg-[var(--shell-paper)] px-3 text-compact disabled:opacity-50"
                disabled={busy}
                onClick={() => void inspect()}
              >
                {t.reread}
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
