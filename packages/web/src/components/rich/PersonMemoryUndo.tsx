'use client';
import { useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { useApprovalHost, useGuardedWrite } from '../ApprovalHost';
import { useShellCopy } from '../shell/shell-copy';
import { personMemoryCopy } from './person-memory.shell-copy';
import {
  type PersonMemorySnapshot,
  personMemoryUndoRequestId,
  readPersonMemorySnapshot,
} from './person-memory-proposal-source';

/** Undo the producer's exact durable decision; a displayed receipt cannot authorize a different or newer write. */
export function PersonMemoryUndo({
  proposalId,
  messageId,
  snapshot,
  afterWrite,
}: {
  proposalId: string;
  messageId: string;
  snapshot: PersonMemorySnapshot;
  afterWrite: () => Promise<unknown>;
}) {
  const guard = useGuardedWrite(),
    host = useApprovalHost();
  const t = useShellCopy(personMemoryCopy),
    busy = useRef(false);
  const [undoing, setUndoing] = useState(false),
    [failed, setFailed] = useState(false);
  const receipt = snapshot.decisionReceipt;
  const canUndo =
    receipt &&
    !snapshot.undoReceipt &&
    (snapshot.status === 'materialized' || snapshot.status === 'partially_materialized');
  if (!canUndo) return null;
  const undo = async () => {
    if (busy.current || host.writesLocked) return;
    busy.current = true;
    setUndoing(true);
    setFailed(false);
    try {
      const current = await readPersonMemorySnapshot(proposalId, messageId);
      if (
        !current ||
        current.undoReceipt ||
        current.decisionReceipt?.decisionId !== receipt.decisionId ||
        !['materialized', 'partially_materialized'].includes(current.status)
      )
        throw new Error('changed receipt');
      const written = await guard('person-memory-undo', async (report) => {
        const response = await apiFetch(`/api/person-memory-proposals/${encodeURIComponent(proposalId)}/undo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decisionId: receipt.decisionId,
            requestId: personMemoryUndoRequestId(proposalId, receipt.decisionId),
          }),
        });
        report(
          response.ok
            ? { outcome: 'settled', status: response.status }
            : { outcome: 'http-error', status: response.status },
        );
        const result: unknown = response.ok ? await response.json() : null;
        return Boolean(result && typeof result === 'object' && 'verdict' in result && result.verdict === 'undone');
      });
      if (!written.sent) return;
      if (!written.value) throw new Error('unconfirmed undo');
      await afterWrite();
      window.dispatchEvent(new CustomEvent('cat-cafe:proposal-updated', { detail: { proposalId } }));
    } catch {
      setFailed(true);
    } finally {
      busy.current = false;
      setUndoing(false);
    }
  };
  return (
    <div className="space-y-1">
      <button
        type="button"
        data-testid="person-memory-undo"
        disabled={undoing || host.writesLocked}
        onClick={() => void undo()}
        className="shell-focusable rounded-md border border-[var(--shell-hairline)] px-3 py-1.5 text-sm disabled:opacity-50"
      >
        {undoing ? t.undoing : t.undo}
      </button>
      {failed ? (
        <p role="status" className="text-xs">
          {t.undoFailed}
        </p>
      ) : null}
    </div>
  );
}
