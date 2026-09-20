import { createHash, randomUUID } from 'node:crypto';
import type { HarnessGovernanceProposal, HarnessGovernanceProposalStatus } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

const PROPOSAL_HASH = 'harness-governance-proposal';
const OWNER_INDEX_PREFIX = 'harness-governance-proposal-owner:';
const UNIT_INDEX_PREFIX = 'harness-governance-proposal-unit:';
const DECISION_LOCK_PREFIX = 'harness-governance-proposal-decision-lock:';
const DECISION_LOCK_TTL_MS = 30_000;
const RELEASE_LOCK_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

const keyPart = (value: string) => encodeURIComponent(value);
const ownerIndexKey = (ownerUserId: string) => `${OWNER_INDEX_PREFIX}${keyPart(ownerUserId)}`;
const unitIndexKey = (ownerUserId: string, unitId: string) =>
  `${UNIT_INDEX_PREFIX}${keyPart(ownerUserId)}:${keyPart(unitId)}`;

export function harnessGovernanceProposalId(cycleId: string, cardOrdinal: number): string {
  const suffix = createHash('sha256')
    .update(JSON.stringify([cycleId, cardOrdinal]))
    .digest('hex')
    .slice(0, 16);
  return `HGP-${suffix}`;
}

export class HarnessGovernanceProposalStore {
  constructor(private readonly redis: RedisClient) {}

  async create(proposal: HarnessGovernanceProposal): Promise<'created' | 'duplicate'> {
    const existing = await this.get(proposal.proposalId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(proposal)) {
      throw new Error(`harness_governance_proposal_conflict:${proposal.proposalId}`);
    }
    if (!existing) await this.redis.hset(PROPOSAL_HASH, proposal.proposalId, JSON.stringify(proposal));
    await this.redis.sadd(ownerIndexKey(proposal.ownerUserId), proposal.proposalId);
    for (const unitId of new Set(proposal.changes.map((change) => change.unitId))) {
      await this.redis.sadd(unitIndexKey(proposal.ownerUserId, unitId), proposal.proposalId);
    }
    return existing ? 'duplicate' : 'created';
  }

  async get(proposalId: string): Promise<HarnessGovernanceProposal | null> {
    const raw = await this.redis.hget(PROPOSAL_HASH, proposalId);
    if (!raw) return null;
    try {
      return parseProposal(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  async listByOwner(ownerUserId: string): Promise<HarnessGovernanceProposal[]> {
    return this.readIndex(await this.redis.smembers(ownerIndexKey(ownerUserId)), ownerUserId);
  }

  async listByUnit(ownerUserId: string, unitId: string): Promise<HarnessGovernanceProposal[]> {
    const proposals = await this.readIndex(await this.redis.smembers(unitIndexKey(ownerUserId, unitId)), ownerUserId);
    return proposals.filter((proposal) => proposal.changes.some((change) => change.unitId === unitId));
  }

  async countPending(ownerUserId: string, unitId: string): Promise<number> {
    const proposals = await this.listByUnit(ownerUserId, unitId);
    return proposals.filter((proposal) => proposal.status === 'pending').length;
  }

  async settle(input: {
    proposalId: string;
    ownerUserId: string;
    status: Exclude<HarnessGovernanceProposalStatus, 'pending'>;
    decidedAt: number;
    decidedBy: string;
    reason?: string;
  }): Promise<HarnessGovernanceProposal> {
    const proposal = await this.get(input.proposalId);
    if (!proposal || proposal.ownerUserId !== input.ownerUserId) {
      throw new Error('harness_governance_proposal_not_found');
    }
    if (proposal.status === input.status && proposal.decidedBy === input.decidedBy) return proposal;
    if (proposal.status !== 'pending') throw new Error('harness_governance_proposal_not_pending');
    const settled: HarnessGovernanceProposal = {
      ...proposal,
      status: input.status,
      decidedAt: input.decidedAt,
      decidedBy: input.decidedBy,
      ...(input.reason ? { decisionReason: input.reason } : {}),
    };
    await this.redis.hset(PROPOSAL_HASH, proposal.proposalId, JSON.stringify(settled));
    return settled;
  }

  async withDecisionLock<T>(proposalId: string, operation: () => Promise<T>): Promise<T> {
    const key = `${DECISION_LOCK_PREFIX}${keyPart(proposalId)}`;
    const token = randomUUID();
    const acquired = await this.redis.set(key, token, 'PX', DECISION_LOCK_TTL_MS, 'NX');
    if (acquired !== 'OK') throw new Error('harness_governance_proposal_concurrent_transition');
    try {
      return await operation();
    } finally {
      await this.releaseLock(key, token);
    }
  }

  private async readIndex(ids: string[], ownerUserId: string): Promise<HarnessGovernanceProposal[]> {
    const proposals: HarnessGovernanceProposal[] = [];
    for (const id of ids) {
      const proposal = await this.get(id);
      if (proposal?.ownerUserId === ownerUserId) proposals.push(proposal);
    }
    return proposals.sort(
      (left, right) => right.createdAt - left.createdAt || left.proposalId.localeCompare(right.proposalId),
    );
  }

  private async releaseLock(key: string, token: string): Promise<void> {
    const client = this.redis as RedisClient & { eval?: (...args: unknown[]) => Promise<unknown> };
    if (typeof client.eval === 'function') {
      await client.eval(RELEASE_LOCK_LUA, 1, key, token);
    } else if ((await this.redis.get(key)) === token) {
      await this.redis.del(key);
    }
  }
}

function parseProposal(value: unknown): HarnessGovernanceProposal | null {
  if (!isRecord(value) || !isRecord(value.evaluation)) return null;
  const status = value.status;
  if (
    value.schemaVersion !== 1 ||
    typeof value.proposalId !== 'string' ||
    typeof value.ownerUserId !== 'string' ||
    !isRecord(value.objective) ||
    typeof value.objective.id !== 'string' ||
    typeof value.objective.label !== 'string' ||
    typeof value.objective.statement !== 'string' ||
    typeof value.objectiveId !== 'string' ||
    typeof value.cycleId !== 'string' ||
    typeof value.threadId !== 'string' ||
    !Number.isSafeInteger(value.cardOrdinal) ||
    (value.decision !== 'rollback' && value.decision !== 'evolve') ||
    !['pending', 'approved', 'skipped', 'rejected'].includes(typeof status === 'string' ? status : '') ||
    typeof value.reason !== 'string' ||
    typeof value.version !== 'string' ||
    typeof value.versionContentRef !== 'string' ||
    !Array.isArray(value.windows) ||
    !Array.isArray(value.triggeredBy) ||
    !isTriggerCounts(value.triggerCounts) ||
    !Array.isArray(value.evaluation.metrics) ||
    !Array.isArray(value.history) ||
    !Array.isArray(value.rejectReasons) ||
    !value.rejectReasons.every((item) => typeof item === 'string') ||
    !Array.isArray(value.changes) ||
    value.changes.length === 0 ||
    !Array.isArray(value.evidenceRefs) ||
    !value.evidenceRefs.every((item) => typeof item === 'string') ||
    typeof value.createdAt !== 'number' ||
    !Number.isFinite(value.createdAt)
  ) {
    return null;
  }
  return value as unknown as HarnessGovernanceProposal;
}

function isTriggerCounts(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.cumulative) || !isRecord(value.counterexamples)) return false;
  return [
    value.cumulative.count,
    value.cumulative.threshold,
    value.counterexamples.count,
    value.counterexamples.threshold,
  ].every((item) => typeof item === 'number' && Number.isFinite(item));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
