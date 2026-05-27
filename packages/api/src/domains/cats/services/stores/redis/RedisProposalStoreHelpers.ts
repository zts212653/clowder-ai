/**
 * F128 RedisProposalStore — extracted helpers (Lua + serialize/hydrate + overrides).
 * Split out of RedisProposalStore.ts to keep both files under the 350-line hard limit (AC-X1).
 */

import type { CatId, ProposalApproveOverrides, ProposalStatus, ThreadProposal } from '@cat-cafe/shared';
import type { FinalizeApprovalInput } from '../ports/ProposalStore.js';

/**
 * CAS Lua: atomically check current status matches expected → HSET fields + ZREM/ZADD pending index.
 * KEYS[1] = proposal:{id}, KEYS[2] = proposals:pending:{userId}
 * ARGV[1] = proposalId
 * ARGV[2] = expected status (e.g. "pending")
 * ARGV[3] = pending-index action: "zrem" | "zadd" | "noop"
 * ARGV[4] = score for zadd (createdAt), required when action="zadd"
 * ARGV[5..N] = HSET field/value pairs
 * Returns 1 on success, 0 if current status doesn't match expected.
 */
export const CAS_TRANSITION_LUA = `
local current = redis.call('HGET', KEYS[1], 'status')
if current ~= ARGV[2] then
  return 0
end
local fields = {}
for i = 5, #ARGV do
  fields[#fields + 1] = ARGV[i]
end
if #fields > 0 then
  redis.call('HSET', KEYS[1], unpack(fields))
end
if ARGV[3] == 'zrem' then
  redis.call('ZREM', KEYS[2], ARGV[1])
elseif ARGV[3] == 'zadd' then
  redis.call('ZADD', KEYS[2], ARGV[4], ARGV[1])
end
return 1
`;

/** SET NX style release: delete dedup key only if value matches expected. */
export const RELEASE_DEDUP_LUA = `
local current = redis.call('GET', KEYS[1])
if current == ARGV[1] then
  redis.call('DEL', KEYS[1])
end
return 1
`;

/** Conditional HSET: write createdThreadId only if proposal status is still 'approving'. */
export const RECORD_CREATED_THREAD_LUA = `
local current = redis.call('HGET', KEYS[1], 'status')
if current == 'approving' then
  redis.call('HSET', KEYS[1], 'createdThreadId', ARGV[1])
end
return 1
`;

export function serializeProposal(proposal: ThreadProposal): string[] {
  const fields: string[] = [
    'proposalId',
    proposal.proposalId,
    'status',
    proposal.status,
    'sourceThreadId',
    proposal.sourceThreadId,
    'sourceInvocationId',
    proposal.sourceInvocationId,
    'sourceCatId',
    proposal.sourceCatId,
    'title',
    proposal.title,
    'reason',
    proposal.reason,
    'parentThreadId',
    proposal.parentThreadId,
    'preferredCats',
    JSON.stringify(proposal.preferredCats),
    'projectPath',
    proposal.projectPath,
    'createdBy',
    proposal.createdBy,
    'createdAt',
    String(proposal.createdAt),
  ];
  if (proposal.initialMessage) fields.push('initialMessage', proposal.initialMessage);
  if (proposal.cardMessageId) fields.push('cardMessageId', proposal.cardMessageId);
  return fields;
}

export function hydrateProposal(data: Record<string, string>): ThreadProposal {
  const preferredCats = parseCatArray(data.preferredCats);
  const initialMessage = data.initialMessage && data.initialMessage.length > 0 ? data.initialMessage : undefined;
  const proposal: ThreadProposal = {
    proposalId: data.proposalId!,
    status: (data.status ?? 'pending') as ProposalStatus,
    sourceThreadId: data.sourceThreadId!,
    sourceInvocationId: data.sourceInvocationId!,
    sourceCatId: data.sourceCatId! as CatId,
    title: data.title!,
    reason: data.reason!,
    parentThreadId: data.parentThreadId!,
    preferredCats,
    projectPath: data.projectPath!,
    createdBy: data.createdBy!,
    createdAt: parseInt(data.createdAt!, 10),
  };
  if (initialMessage) proposal.initialMessage = initialMessage;
  if (data.approvedBy) proposal.approvedBy = data.approvedBy;
  if (data.approvedAt) proposal.approvedAt = parseInt(data.approvedAt, 10);
  if (data.createdThreadId) proposal.createdThreadId = data.createdThreadId;
  if (data.rejectedBy) proposal.rejectedBy = data.rejectedBy;
  if (data.rejectedAt) proposal.rejectedAt = parseInt(data.rejectedAt, 10);
  if (data.rejectionReason) proposal.rejectionReason = data.rejectionReason;
  if (data.cardMessageId) proposal.cardMessageId = data.cardMessageId;
  const claimedAt = parseInt(data.claimedAt ?? '0', 10);
  if (claimedAt > 0) proposal.claimedAt = claimedAt;
  return proposal;
}

export function applyFinalize(proposal: ThreadProposal, input: FinalizeApprovalInput, now: number): ThreadProposal {
  const updated: ThreadProposal = {
    ...proposal,
    status: 'approved',
    approvedAt: now,
    createdThreadId: input.createdThreadId,
  };
  applyOverrides(updated, input.overrides);
  return updated;
}

export function applyOverrides(proposal: ThreadProposal, overrides: ProposalApproveOverrides | undefined): void {
  if (!overrides) return;
  if (overrides.title !== undefined) proposal.title = overrides.title;
  if (overrides.parentThreadId !== undefined) proposal.parentThreadId = overrides.parentThreadId;
  if (overrides.preferredCats !== undefined) proposal.preferredCats = [...overrides.preferredCats];
  if (overrides.initialMessage === null) delete proposal.initialMessage;
  else if (typeof overrides.initialMessage === 'string') proposal.initialMessage = overrides.initialMessage;
}

function parseCatArray(raw: string | undefined): CatId[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry as CatId);
  } catch {
    return [];
  }
}
