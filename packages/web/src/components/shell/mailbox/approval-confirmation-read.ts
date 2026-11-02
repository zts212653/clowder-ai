import { unifiedAttentionApprovalsSourceSchema } from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';
import type { Terminal } from './approval-reconcile';
import { lookupSettled, type SettledLookupInput } from './settled-lookup';

/**
 * A decision result needs the approval owner's fresh pending/history reads, not
 * completion of unrelated Needs Me, mentions or plugin sources. No write response
 * or optimistic store removal is evidence here. Nonterminal/unavailable reads
 * leave the ordinary unified reconciliation in charge.
 */
export async function readConfirmedApprovalTerminal(input: SettledLookupInput): Promise<Terminal | null> {
  try {
    const [pendingResponse, settled] = await Promise.all([
      apiFetch('/api/approval-hub/pending', { signal: input.signal }, { afterCurrentGet: true }),
      lookupSettled(input),
    ]);
    if (!pendingResponse.ok || settled.kind !== 'found') return null;
    const pending = unifiedAttentionApprovalsSourceSchema.safeParse(await pendingResponse.json());
    if (
      !pending.success ||
      pending.data.coverage?.state !== 'complete' ||
      pending.data.items.some(
        (item) =>
          item.ownerUserId !== input.ownerUserId ||
          (item.proposalId === input.proposalId && item.sourceFeatureId === input.sourceFeatureId),
      )
    )
      return null;

    // Reconfirm the current browser principal after the owner reads: changing
    // accounts while a request is outstanding cannot certify the old session.
    const response = await apiFetch('/api/session', { signal: input.signal }, { afterCurrentGet: true });
    if (!response.ok) return null;
    const session: unknown = await response.json();
    if (
      !session ||
      typeof session !== 'object' ||
      Array.isArray(session) ||
      !('userId' in session) ||
      session.userId !== input.ownerUserId ||
      input.signal?.aborted
    )
      return null;
    return settled.terminal;
  } catch {
    return null;
  }
}
