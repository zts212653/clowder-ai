import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export interface PendingProposalForget {
  proposalId: string;
  requestId: string;
  expectedRevision: string;
  proposalIds: string[];
}
const eventName = 'cat-cafe:proposal-forget-recovery';
const inFlight = new Set<string>();
const key = (owner: string) => `cat-cafe:proposal-forget-pending:${encodeURIComponent(owner)}`;
const notify = () => window.dispatchEvent(new Event(eventName));
const candidateId = (id: unknown): id is string =>
  typeof id === 'string' && /^person_candidate_[A-Za-z0-9._:-]+$/.test(id);
function valid(value: unknown): value is PendingProposalForget {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    candidateId(item.proposalId) &&
    typeof item.requestId === 'string' &&
    /^person_forget_[A-Za-z0-9._:-]{32,}$/.test(item.requestId) &&
    typeof item.expectedRevision === 'string' &&
    /^sha256:[a-f0-9]{64}$/.test(item.expectedRevision) &&
    Array.isArray(item.proposalIds) &&
    item.proposalIds.length > 0 &&
    item.proposalIds.length <= 32 &&
    item.proposalIds.every(candidateId)
  );
}

/** Recovery coordinates only, never a second proposal/history store. Retained until the result is known. */
export function readPendingProposalForgets(owner: string): PendingProposalForget[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(owner)) ?? '[]');
    return Array.isArray(value) ? value.filter(valid) : [];
  } catch {
    return [];
  }
}
export function savePendingProposalForget(owner: string, command: PendingProposalForget): boolean {
  if (!valid(command)) return false;
  try {
    const pending = readPendingProposalForgets(owner).filter((item) => item.proposalId !== command.proposalId);
    localStorage.setItem(key(owner), JSON.stringify([...pending, command]));
    notify();
    return true;
  } catch {
    return false;
  }
}
function clearPending(owner: string, requestId: string) {
  const pending = readPendingProposalForgets(owner).filter((item) => item.requestId !== requestId);
  if (pending.length) localStorage.setItem(key(owner), JSON.stringify(pending));
  else localStorage.removeItem(key(owner));
  notify();
}
export function usePendingProposalForgets(owner: string | null) {
  const [, update] = useState(0);
  useEffect(() => {
    const refresh = () => update((value) => value + 1);
    window.addEventListener(eventName, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(eventName, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  return owner ? readPendingProposalForgets(owner) : [];
}
export const proposalForgetBusy = (command: PendingProposalForget) => inFlight.has(command.requestId);
export type ProposalForgetExecution =
  | { outcome: 'purged' | 'already_absent'; count: number }
  | { outcome: 'conflict' | 'stale_revision' | 'person_bound' | 'unknown' };

/** A retry always resubmits the original command. The server's durable receipt owns its result. */
export async function executePendingProposalForget(
  owner: string,
  command: PendingProposalForget,
): Promise<ProposalForgetExecution> {
  if (inFlight.has(command.requestId)) return { outcome: 'unknown' };
  inFlight.add(command.requestId);
  notify();
  try {
    const response = await apiFetch(`/api/person-memory-proposals/${encodeURIComponent(command.proposalId)}/forget`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: command.requestId,
        expectedRevision: command.expectedRevision,
        confirmed: true,
      }),
    });
    const value: unknown = await response.json();
    const result = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    if (response.ok && (result.outcome === 'purged' || result.outcome === 'already_absent')) {
      const receipt = result.receipt as
        | { requestId?: unknown; purgedSurfaceCounts?: { candidates?: unknown } }
        | undefined;
      if (receipt?.requestId !== command.requestId) return { outcome: 'unknown' };
      const count = receipt.purgedSurfaceCounts?.candidates;
      clearPending(owner, command.requestId);
      return { outcome: result.outcome, count: typeof count === 'number' ? count : 0 };
    }
    if (
      response.status === 409 &&
      (result.outcome === 'conflict' || result.outcome === 'stale_revision' || result.outcome === 'person_bound')
    ) {
      clearPending(owner, command.requestId);
      return { outcome: result.outcome };
    }
    return { outcome: 'unknown' };
  } catch {
    return { outcome: 'unknown' };
  } finally {
    inFlight.delete(command.requestId);
    notify();
  }
}
