import { apiFetch } from '@/utils/api-client';
import type { SettledLookup, Terminal } from './approval-reconcile';

/**
 * F322 S3-2b-1c: the exact settled lookup the reconciler asks for.
 *
 * After a write, an approval that has left the 待办 page is "decided" only if the Approval Hub's settled history holds a row for
 * exactly that proposal, that producer and that owner. Absence from the page proves nothing (it may have left for another
 * reason, or the page is only the first 20 rows), and the Hub store's optimistic removal proves nothing either.
 *
 * The history endpoint takes only a limit, so this reads a bounded window and looks for the row in it. That is a real
 * limit and it is stated, not hidden: a window that came back full and does not contain the row may simply be too short, so
 * that answer is "cannot rely on" and never "not found". Every failure to read is the same: the answer is unavailable.
 *
 * Deliberately not `approvalHubStore.fetchSettled`: that writes the history pane's global, unfenced list. This is a private
 * read whose answer belongs to one question.
 */
export const SETTLED_LOOKUP_LIMIT = 200;
export const SETTLED_LOOKUP_PATH = `/api/approval-hub/settled?limit=${SETTLED_LOOKUP_LIMIT}`;

const TERMINAL_RESOLUTIONS: readonly Terminal['resolution'][] = ['accepted', 'rejected', 'closed_without_decision'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function terminalOf(row: Record<string, unknown>): Terminal | null {
  const resolution = TERMINAL_RESOLUTIONS.find((candidate) => candidate === row.resolution);
  if (!resolution) return null;
  const decidedBy = typeof row.decidedBy === 'string' ? row.decidedBy.trim() : '';
  return {
    resolution,
    ...(typeof row.decidedAt === 'number' && Number.isFinite(row.decidedAt) ? { decidedAt: row.decidedAt } : {}),
    ...(decidedBy ? { decidedBy } : {}),
  };
}

function decidedAtOf(row: Record<string, unknown>): number {
  return typeof row.decidedAt === 'number' && Number.isFinite(row.decidedAt) ? row.decidedAt : Number.NEGATIVE_INFINITY;
}

export interface SettledLookupInput {
  /** The owner the card was shown to: a row of anyone else's is not this card's. */
  ownerUserId: string;
  sourceFeatureId: string;
  proposalId: string;
  signal?: AbortSignal;
}

export async function lookupSettled(input: SettledLookupInput): Promise<SettledLookup> {
  const unavailable: SettledLookup = { kind: 'unavailable' };
  let response: Response;
  try {
    // `afterCurrentGet`: a GET already in flight when the write ended may predate the write.
    response = await apiFetch(SETTLED_LOOKUP_PATH, { signal: input.signal }, { afterCurrentGet: true });
  } catch {
    return unavailable;
  }
  if (!response.ok) return unavailable;

  const body: unknown = await response.json().catch(() => null);
  if (!isRecord(body) || !Array.isArray(body.items)) return unavailable;
  const rows = body.items.filter(isRecord);

  const matching = rows
    .filter(
      (row) =>
        row.proposalId === input.proposalId &&
        row.sourceFeatureId === input.sourceFeatureId &&
        row.ownerUserId === input.ownerUserId,
    )
    .sort((a, b) => decidedAtOf(b) - decidedAtOf(a));

  if (matching.length > 0) {
    // The newest row for this exact proposal; one that does not say a terminal resolution is not a decision we can state.
    const terminal = terminalOf(matching[0]);
    return terminal ? { kind: 'found', terminal } : unavailable;
  }
  // Not in the window. Only a window that was not full can say the row is not there at all.
  return body.items.length >= SETTLED_LOOKUP_LIMIT ? unavailable : { kind: 'not_found' };
}
