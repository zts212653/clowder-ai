import {
  buildHumanDispositionLedgerReceipt,
  type PersonMemoryDeletionReceipt,
  type PersonMemorySuppressionToken,
  personMemoryDeletionReceiptSchema,
  personMemorySuppressionTokenSchema,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { HumanDispositionKeys } from '../../human-disposition/human-disposition-keys.js';
import { DeferredPersonMemoryReceiptKeys } from '../deferred-person-memory-redis-contract.js';
import type {
  HardForgetPersonMemoryProposalInput,
  PersonMemoryProposalForgetResult,
  StoredPersonMemoryCandidate,
} from './PersonMemoryStore.js';
import {
  loadDeferredReceiptSnapshotsForCandidates,
  planDeferredReceiptSnapshots,
} from './person-memory-deferred-forget.js';
import { personMemoryProposalLineageMarker } from './person-memory-delta-lineage.js';
import type { PersonMemoryCandidateSnapshot } from './person-memory-disposition-forget.js';
import {
  parseProposalDispositionDecisionReceiptLocator,
  parseProposalDispositionLineageBinding,
  parseProposalDispositionLineageHandleLocator,
} from './person-memory-disposition-records.js';
import { BEGIN_EXACT_PROPOSAL_FORGET_LUA, FINISH_HARD_FORGET_LUA } from './person-memory-forget-lua.js';
import { PersonMemoryKeys } from './person-memory-keys.js';
import { parseStoredCandidate } from './person-memory-records.js';
import { PersonMemoryRedisPlan } from './person-memory-redis-plan.js';

const FORGET_FENCE_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_LINEAGE_HOPS = 32;

function candidatePersonId(candidate: StoredPersonMemoryCandidate): string | undefined {
  return candidate.materializedPersonId ?? candidate.targetPersonId;
}

function receiptKey(input: HardForgetPersonMemoryProposalInput): string {
  return PersonMemoryKeys.proposalForgetReceipt(input.ownerUserId, input.proposalId, input.requestId);
}

async function existingReceipt(
  redis: RedisClient,
  input: HardForgetPersonMemoryProposalInput,
): Promise<PersonMemoryDeletionReceipt | null> {
  const raw = await redis.get(receiptKey(input));
  return raw ? personMemoryDeletionReceiptSchema.parse(JSON.parse(raw)) : null;
}

function deletionReceipt(
  input: HardForgetPersonMemoryProposalInput,
  verdict: 'purged' | 'already_absent',
  counts: Record<string, number>,
): PersonMemoryDeletionReceipt {
  return personMemoryDeletionReceiptSchema.parse({
    requestId: input.requestId,
    ownerUserId: input.ownerUserId,
    completedAt: input.requestedAt,
    purgedSurfaceCounts: counts,
    verdict,
  });
}

async function readCandidate(
  redis: RedisClient,
  ownerUserId: string,
  candidateId: string,
): Promise<PersonMemoryCandidateSnapshot | null> {
  const raw = await redis.get(PersonMemoryKeys.candidate(ownerUserId, candidateId));
  const candidate = parseStoredCandidate(raw);
  return raw && candidate && candidate.ownerUserId === ownerUserId && candidate.candidateId === candidateId
    ? { candidate, raw }
    : null;
}

async function loadExactLineage(
  redis: RedisClient,
  ownerUserId: string,
  exact: PersonMemoryCandidateSnapshot,
): Promise<Map<string, PersonMemoryCandidateSnapshot> | 'person_bound' | 'conflict'> {
  const reverse: PersonMemoryCandidateSnapshot[] = [];
  const seen = new Set<string>();
  let current: PersonMemoryCandidateSnapshot | null = exact;
  while (current) {
    if (seen.has(current.candidate.candidateId) || reverse.length >= MAX_LINEAGE_HOPS) return 'conflict';
    if (candidatePersonId(current.candidate)) return 'person_bound';
    seen.add(current.candidate.candidateId);
    reverse.push(current);
    current = current.candidate.replacesProposalId
      ? await readCandidate(redis, ownerUserId, current.candidate.replacesProposalId)
      : null;
    if (reverse.at(-1)?.candidate.replacesProposalId && !current) return 'conflict';
  }
  const root = reverse.at(-1);
  if (!root) return 'conflict';

  const lineage = new Map<string, PersonMemoryCandidateSnapshot>();
  current = root;
  while (current) {
    if (lineage.has(current.candidate.candidateId) || lineage.size >= MAX_LINEAGE_HOPS) return 'conflict';
    if (candidatePersonId(current.candidate)) return 'person_bound';
    lineage.set(current.candidate.candidateId, current);
    const nextId = current.candidate.replacedByProposalId;
    if (!nextId) break;
    const next = await readCandidate(redis, ownerUserId, nextId);
    if (!next || next.candidate.replacesProposalId !== current.candidate.candidateId) return 'conflict';
    current = next;
  }
  if (!lineage.has(exact.candidate.candidateId)) return 'conflict';
  const values = [...lineage.values()];
  const ancestorsAreWithdrawn = values.slice(0, -1).every((snapshot) => snapshot.candidate.state === 'withdrawn');
  const leafState = values.at(-1)?.candidate.state;
  if (!ancestorsAreWithdrawn || (leafState !== 'rejected' && leafState !== 'withdrawn')) return 'conflict';
  return lineage;
}

async function loadSuppression(
  redis: RedisClient,
  ownerUserId: string,
  candidateId: string,
): Promise<{ raw: string; token: PersonMemorySuppressionToken } | null> {
  const raw = await redis.get(PersonMemoryKeys.suppression(ownerUserId, candidateId));
  if (!raw) return null;
  return { raw, token: personMemorySuppressionTokenSchema.parse(JSON.parse(raw)) };
}

async function planDispositionPurge(
  redis: RedisClient,
  plan: PersonMemoryRedisPlan,
  input: HardForgetPersonMemoryProposalInput,
  lineage: Map<string, PersonMemoryCandidateSnapshot>,
): Promise<number> {
  const roots = [...lineage.values()].filter((snapshot) => !snapshot.candidate.replacesProposalId);
  const current = [...lineage.values()].at(-1);
  if (roots.length !== 1 || !current) throw new Error('F276 proposal forget lineage root is ambiguous');
  const bindingCandidates = [...lineage.values()].filter(
    (snapshot) => snapshot.candidate.dispositionLineageBindingKey !== undefined,
  );
  if (bindingCandidates.length === 0) {
    if ([...lineage.values()].some((snapshot) => snapshot.candidate.humanDispositionLedgerEntry !== undefined)) {
      throw new Error('F276 proposal forget ledger entry has no binding');
    }
    return 0;
  }
  if (bindingCandidates.length !== 1 || bindingCandidates[0] !== current) {
    throw new Error('F276 proposal forget binding is outside terminal candidate');
  }

  const bindingKey = current.candidate.dispositionLineageBindingKey;
  const entry = current.candidate.humanDispositionLedgerEntry;
  if (!bindingKey || !entry) throw new Error('F276 proposal forget disposition pair is incomplete');
  const bindingRaw = await redis.get(bindingKey);
  const binding = parseProposalDispositionLineageBinding(bindingRaw);
  if (
    !binding ||
    binding.ownerUserId !== input.ownerUserId ||
    binding.rootCandidateId !== roots[0]?.candidate.candidateId ||
    binding.currentCandidateId !== current.candidate.candidateId
  ) {
    throw new Error('F276 proposal forget binding is malformed');
  }
  const lineageLocatorKey = PersonMemoryKeys.dispositionLineageHandleLocator(
    input.ownerUserId,
    binding.opaqueLineageHandle,
  );
  const lineageLocatorRaw = await redis.get(lineageLocatorKey);
  const lineageLocator = parseProposalDispositionLineageHandleLocator(lineageLocatorRaw);
  if (
    !lineageLocator ||
    lineageLocator.bindingKey !== bindingKey ||
    lineageLocator.rootCandidateId !== binding.rootCandidateId
  ) {
    throw new Error('F276 proposal forget lineage locator is cross-wired');
  }
  const receipt = buildHumanDispositionLedgerReceipt(entry);
  const decisionLocatorKey = PersonMemoryKeys.dispositionDecisionReceiptLocator(input.ownerUserId, receipt.sourceRef);
  const decisionLocatorRaw = await redis.get(decisionLocatorKey);
  const decisionLocator = parseProposalDispositionDecisionReceiptLocator(decisionLocatorRaw);
  if (
    !decisionLocator ||
    decisionLocator.bindingKey !== bindingKey ||
    decisionLocator.candidateKey !== PersonMemoryKeys.candidate(input.ownerUserId, current.candidate.candidateId) ||
    decisionLocator.rootCandidateId !== binding.rootCandidateId ||
    binding.latestDecisionReceiptHandle !== receipt.sourceRef
  ) {
    throw new Error('F276 proposal forget decision locator is cross-wired');
  }
  const receiptKeyValue = HumanDispositionKeys.receipts(input.ownerUserId);
  const ownerIndexKey = HumanDispositionKeys.episodes(input.ownerUserId);
  const subjectIndexKey = HumanDispositionKeys.subject(input.ownerUserId, receipt.subjectRef);
  const [receiptRaw, ownerScore, subjectScore] = await Promise.all([
    redis.hget(receiptKeyValue, receipt.sourceRef),
    redis.zscore(ownerIndexKey, receipt.sourceRef),
    redis.zscore(subjectIndexKey, receipt.sourceRef),
  ]);
  const canonicalReceipt = JSON.stringify(receipt);
  if (
    receiptRaw !== canonicalReceipt ||
    ownerScore !== String(receipt.decidedAt) ||
    subjectScore !== String(receipt.decidedAt)
  ) {
    throw new Error('F276 proposal forget F281 receipt/index invariant failed');
  }
  plan.expect(bindingKey, bindingRaw ?? '');
  plan.expect(lineageLocatorKey, lineageLocatorRaw ?? '');
  plan.expect(decisionLocatorKey, decisionLocatorRaw ?? '');
  plan.expectHashField(receiptKeyValue, receipt.sourceRef, canonicalReceipt);
  plan.expectZScore(ownerIndexKey, receipt.sourceRef, String(receipt.decidedAt));
  plan.expectZScore(subjectIndexKey, receipt.sourceRef, String(receipt.decidedAt));
  plan.del(bindingKey, 'string');
  plan.del(lineageLocatorKey, 'string');
  plan.del(decisionLocatorKey, 'string');
  plan.hdel(receiptKeyValue, receipt.sourceRef);
  plan.zrem(ownerIndexKey, receipt.sourceRef);
  plan.zrem(subjectIndexKey, receipt.sourceRef);
  return 1;
}

function parseFinishResult(finish: string): PersonMemoryProposalForgetResult {
  if (finish.startsWith('PURGED:')) {
    const receipt = personMemoryDeletionReceiptSchema.parse(JSON.parse(finish.slice(7)));
    return { outcome: 'purged', receipt };
  }
  if (finish.startsWith('RECEIPT:')) {
    const receipt = personMemoryDeletionReceiptSchema.parse(JSON.parse(finish.slice(8)));
    return { outcome: receipt.verdict === 'purged' ? 'purged' : 'already_absent', receipt };
  }
  if (finish === 'CONFLICT') return { outcome: 'conflict' };
  throw new Error(`unexpected F276 proposal forget result: ${finish}`);
}

export async function hardForgetPersonMemoryProposal(
  redis: RedisClient,
  input: HardForgetPersonMemoryProposalInput,
): Promise<PersonMemoryProposalForgetResult> {
  const prior = await existingReceipt(redis, input);
  if (prior) return { outcome: prior.verdict === 'purged' ? 'purged' : 'already_absent', receipt: prior };
  const exact = await readCandidate(redis, input.ownerUserId, input.proposalId);
  if (!exact) {
    const receipt = deletionReceipt(input, 'already_absent', {});
    await redis.set(receiptKey(input), JSON.stringify(receipt), 'NX');
    return {
      outcome: 'already_absent',
      receipt: (await existingReceipt(redis, input)) ?? receipt,
    };
  }
  const lineage = await loadExactLineage(redis, input.ownerUserId, exact);
  if (lineage === 'person_bound') return { outcome: 'person_bound' };
  if (lineage === 'conflict') return { outcome: 'conflict' };
  const root = [...lineage.values()][0];
  if (!root) return { outcome: 'conflict' };
  const fenceKey = PersonMemoryKeys.proposalForgetFence(input.ownerUserId, root.candidate.candidateId);
  const resultReceiptKey = receiptKey(input);
  const begin = String(
    await redis.eval(
      BEGIN_EXACT_PROPOSAL_FORGET_LUA,
      3,
      fenceKey,
      resultReceiptKey,
      PersonMemoryKeys.candidate(input.ownerUserId, input.proposalId),
      input.requestId,
      String(FORGET_FENCE_TTL_MS),
    ),
  );
  if (begin.startsWith('RECEIPT:')) return parseFinishResult(begin);
  if (begin === 'CONFLICT') return { outcome: 'conflict' };
  if (begin === 'ABSENT') {
    const receipt = deletionReceipt(input, 'already_absent', {});
    await redis.set(resultReceiptKey, JSON.stringify(receipt), 'NX');
    return { outcome: 'already_absent', receipt: (await existingReceipt(redis, input)) ?? receipt };
  }

  const plan = new PersonMemoryRedisPlan([fenceKey, resultReceiptKey]);
  const dispositionCount = await planDispositionPurge(redis, plan, input, lineage);
  const deferredReceiptSnapshots = await loadDeferredReceiptSnapshotsForCandidates(redis, input.ownerUserId, lineage);
  planDeferredReceiptSnapshots(plan, input.ownerUserId, deferredReceiptSnapshots);
  for (const [candidateId, snapshot] of lineage) {
    const candidateKey = PersonMemoryKeys.candidate(input.ownerUserId, candidateId);
    const candidateOwnerKey = PersonMemoryKeys.candidateOwner(candidateId);
    const candidateOwner = await redis.get(candidateOwnerKey);
    if (candidateOwner !== input.ownerUserId) throw new Error('F276 proposal forget owner locator mismatch');
    plan.expect(candidateKey, snapshot.raw);
    plan.expect(candidateOwnerKey, input.ownerUserId);
    plan.zrem(PersonMemoryKeys.pending(input.ownerUserId), candidateId);
    plan.del(candidateKey, 'string');
    plan.del(candidateOwnerKey, 'string');
    plan.del(PersonMemoryKeys.candidatePerson(input.ownerUserId, candidateId), 'string');
    const suppression = await loadSuppression(redis, input.ownerUserId, candidateId);
    if (suppression) {
      plan.expect(PersonMemoryKeys.suppression(input.ownerUserId, candidateId), suppression.raw);
      for (const subjectRef of suppression.token.subjectRefs) {
        plan.srem(PersonMemoryKeys.suppressionSubject(input.ownerUserId, subjectRef), candidateId);
      }
    }
    plan.del(PersonMemoryKeys.suppression(input.ownerUserId, candidateId), 'string');
    plan.del(PersonMemoryKeys.candidateDecisions(input.ownerUserId, candidateId), 'set');
    if (snapshot.candidate.deltaFingerprint && !snapshot.candidate.deferredReceiptId) {
      const deltaKey = DeferredPersonMemoryReceiptKeys.dedupe(input.ownerUserId, snapshot.candidate.deltaFingerprint);
      plan.expect(deltaKey, personMemoryProposalLineageMarker(candidateId));
      plan.del(deltaKey, 'string');
    }
  }
  const receipt = deletionReceipt(input, 'purged', {
    candidates: lineage.size,
    deferredReceipts: deferredReceiptSnapshots.size,
    dispositionEntries: dispositionCount,
  });
  return parseFinishResult(
    String(
      await redis.eval(
        FINISH_HARD_FORGET_LUA,
        plan.keys.length,
        ...plan.keys,
        input.requestId,
        JSON.stringify(receipt),
        plan.serialize(),
      ),
    ),
  );
}
