import { readApprovalProducerBody } from '@/lib/approval-producer-read';
import { approvalResultRead } from '@/lib/approval-result-read';
import { apiFetch } from '@/utils/api-client';
import { apiSessionIdentity } from '@/utils/api-session-identity';
import type { SettledLookupInput } from './settled-lookup';
import type { SettledResultItem } from './settled-results-source';
import { isRecord } from './thread-proposal-read';

function displayedBinding(input: SettledLookupInput): { threadId: string; verified: boolean } | null {
  if (apiSessionIdentity.getSnapshot().ownerUserId !== input.ownerUserId) return null;
  const key = { owner: input.ownerUserId, producer: 'F128', proposalId: input.proposalId };
  const verified = approvalResultRead.isCurrent(key, 'verified-thread')
    ? approvalResultRead.snapshot<string>(key, 'verified-thread').value
    : undefined;
  if (verified) return { threadId: verified, verified: true };
  if (approvalResultRead.isStale(key, 'verified-thread') || !approvalResultRead.isCurrent(key, 'settled')) return null;
  const item = approvalResultRead.snapshot<SettledResultItem>(key, 'settled').value;
  return item?.ownerUserId === input.ownerUserId &&
    item.sourceFeatureId === 'F128' &&
    item.proposalId === input.proposalId &&
    item.resolution === 'accepted' &&
    typeof item.detail.createdThreadId === 'string' &&
    item.detail.createdThreadId.trim()
    ? { threadId: item.detail.createdThreadId, verified: false }
    : null;
}

async function nativeBinding(input: SettledLookupInput, reuseForDisplay: boolean) {
  let body: unknown;
  if (reuseForDisplay && apiSessionIdentity.getSnapshot().ownerUserId === input.ownerUserId) {
    body = await readApprovalProducerBody(
      { owner: input.ownerUserId, producer: 'F128', proposalId: input.proposalId },
      `/api/proposals/${encodeURIComponent(input.proposalId)}`,
      { signal: input.signal },
    );
  } else {
    const response = await apiFetch(
      `/api/proposals/${encodeURIComponent(input.proposalId)}`,
      { signal: input.signal },
      { afterCurrentGet: true },
    );
    if (!response.ok) return null;
    body = await response.json();
  }
  const proposal = isRecord(body) ? body.proposal : null;
  return isRecord(proposal) &&
    proposal.status === 'approved' &&
    proposal.proposalId === input.proposalId &&
    proposal.createdBy === input.ownerUserId &&
    typeof proposal.createdThreadId === 'string' &&
    proposal.createdThreadId.trim()
    ? { threadId: proposal.createdThreadId, body }
    : null;
}

/** Read-only proof: the producer's finalized binding and the exact, still available Thread owner must agree. */
export async function lookupCreatedThread(
  input: SettledLookupInput,
  options: { reuseProducerForDisplay?: boolean } = {},
): Promise<string | null> {
  const key = { owner: input.ownerUserId, producer: 'F128', proposalId: input.proposalId };
  const initialVersion = approvalResultRead.factsVersion(key);
  try {
    const display = options.reuseProducerForDisplay ? displayedBinding(input) : null;
    if (display?.verified) {
      input.signal?.throwIfAborted();
      return display.threadId;
    }
    const native = display ? null : await nativeBinding(input, options.reuseProducerForDisplay === true);
    const threadId = display?.threadId ?? native?.threadId;
    if (!threadId) return null;
    const displayVersion = approvalResultRead.factsVersion(key);
    const threadResponse = await apiFetch(
      `/api/threads/${encodeURIComponent(threadId)}`,
      { signal: input.signal },
      { afterCurrentGet: true },
    );
    if (!threadResponse.ok) return null;
    const thread: unknown = await threadResponse.json();
    const target =
      isRecord(thread) &&
      thread.id === threadId &&
      thread.createdBy === input.ownerUserId &&
      thread.createdFromProposalId === input.proposalId
        ? threadId
        : null;
    const version = options.reuseProducerForDisplay ? displayVersion : initialVersion;
    if (
      target &&
      !input.signal?.aborted &&
      version === approvalResultRead.factsVersion(key) &&
      apiSessionIdentity.getSnapshot().ownerUserId === input.ownerUserId
    ) {
      approvalResultRead.seedFacts(key, { ...(native ? { native: native.body } : {}), 'verified-thread': target });
      approvalResultRead.terminal(key);
    }
    return target;
  } catch {
    return null;
  }
}
