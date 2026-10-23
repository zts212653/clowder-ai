import type { RichCardBlock } from '@cat-cafe/shared';
import type { Terminal } from '@/components/shell/mailbox/approval-reconcile';
import { lookupSettled } from '@/components/shell/mailbox/settled-lookup';
import { type DomainApprovalEffect, domainAttemptEffect } from '@/stores/approval-domain-effect';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { apiFetch } from '@/utils/api-client';
import { type DomainCardCoordinate, domainApprovalCandidate } from './read-domain-approval-source';

async function resultOwner(): Promise<string | null> {
  const response = await apiFetch('/api/session', {}, { afterCurrentGet: true });
  if (!response.ok) return null;
  const session: unknown = await response.json();
  return session && typeof session === 'object' && 'userId' in session && typeof session.userId === 'string'
    ? session.userId
    : null;
}
async function tasteWriteEffect(proposalId: string): Promise<DomainApprovalEffect | undefined> {
  try {
    const response = await apiFetch(
      `/api/taste-proposals/${encodeURIComponent(proposalId)}`,
      {},
      { afterCurrentGet: true },
    );
    const body: unknown = response.ok ? await response.json() : null;
    return body &&
      typeof body === 'object' &&
      'proposalId' in body &&
      body.proposalId === proposalId &&
      'status' in body &&
      body.status === 'approved'
      ? 'taste-written'
      : undefined;
  } catch {
    return;
  }
}

/** Private canonical history observation, never a permission to write or a conclusion from a missing pending row. */
export async function readDomainApprovalResult(
  block: RichCardBlock,
  coordinate: DomainCardCoordinate,
  expectedOwnerUserId?: string,
): Promise<{ ownerUserId: string; terminal: Terminal; effect?: DomainApprovalEffect } | null> {
  const candidate = domainApprovalCandidate(block);
  if (!candidate) return null;
  try {
    const ownerUserId = await resultOwner();
    if (!ownerUserId || (expectedOwnerUserId && ownerUserId !== expectedOwnerUserId)) return null;
    const result = await lookupSettled({
      ownerUserId,
      sourceFeatureId: candidate.feature,
      proposalId: candidate.proposalId,
      approvalCardRef: coordinate,
    });
    if (result.kind !== 'found') return null;
    const terminal = result.terminal;
    if (terminal.resolution !== 'accepted') return { ownerUserId, terminal };
    const attempt = useApprovalHubStore.getState().decisionAttempts[candidate.proposalId];
    let effect = terminal.domainEffect ?? domainAttemptEffect(attempt, ownerUserId, candidate.feature, coordinate);
    // F221's approved status is finalized only after its durable vignette checkpoint. A cold Chat read can recover it.
    if (!effect && candidate.feature === 'F221') effect = await tasteWriteEffect(candidate.proposalId);
    return {
      ownerUserId,
      terminal: { ...terminal, ...(!effect ? { effectUnknown: true } : {}) },
      ...(effect ? { effect } : {}),
    };
  } catch {
    return null;
  }
}
