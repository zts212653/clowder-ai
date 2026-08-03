import { buildHumanDispositionLedgerReceipt } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { HumanDispositionKeys } from '../../human-disposition/human-disposition-keys.js';
import type { StoredPersonMemoryCandidate } from './PersonMemoryStore.js';
import {
  parseDispositionDecisionReceiptLocator,
  parseDispositionLineageBinding,
  parseDispositionLineageHandleLocator,
} from './person-memory-disposition-records.js';
import { PersonMemoryKeys } from './person-memory-keys.js';
import type { PersonMemoryRedisPlan } from './person-memory-redis-plan.js';

export interface PersonMemoryCandidateSnapshot {
  candidate: StoredPersonMemoryCandidate;
  raw: string;
}

interface PlanDispositionPurgeInput {
  redis: RedisClient;
  plan: PersonMemoryRedisPlan;
  ownerUserId: string;
  personId: string;
  artifactKeys: string[];
  candidates: Map<string, PersonMemoryCandidateSnapshot>;
}

interface DispositionPurgeState {
  artifactKeys: Set<string>;
  keyPrefix: string;
  bindingSources: Map<string, Set<string>>;
  plannedBindings: Set<string>;
}

function expectArtifact(artifactKeys: Set<string>, prefix: string, logicalKey: string): void {
  if (!artifactKeys.has(`${prefix}${logicalKey}`)) {
    throw new Error(`F276 hard-forget artifact closure missing ${logicalKey}`);
  }
}

async function planReceiptPurge(
  input: PlanDispositionPurgeInput,
  state: DispositionPurgeState,
  candidateKey: string,
  bindingKey: string,
  binding: NonNullable<ReturnType<typeof parseDispositionLineageBinding>>,
  snapshot: PersonMemoryCandidateSnapshot,
): Promise<void> {
  const entry = snapshot.candidate.humanDispositionLedgerEntry;
  if (!entry) return;
  const receipt = buildHumanDispositionLedgerReceipt(entry);
  const decisionLocatorKey = PersonMemoryKeys.dispositionDecisionReceiptLocator(input.ownerUserId, receipt.sourceRef);
  expectArtifact(state.artifactKeys, state.keyPrefix, decisionLocatorKey);
  const decisionLocatorRaw = await input.redis.get(decisionLocatorKey);
  const decisionLocator = parseDispositionDecisionReceiptLocator(decisionLocatorRaw);
  const isExactLocator =
    decisionLocator?.bindingKey === bindingKey &&
    decisionLocator.candidateKey === candidateKey &&
    decisionLocator.closurePersonId === input.personId &&
    binding.latestDecisionReceiptHandle === receipt.sourceRef;
  if (!isExactLocator) throw new Error('F276 hard-forget decision receipt locator is cross-wired');

  const receiptKey = HumanDispositionKeys.receipts(input.ownerUserId);
  const ownerIndexKey = HumanDispositionKeys.episodes(input.ownerUserId);
  const subjectIndexKey = HumanDispositionKeys.subject(input.ownerUserId, receipt.subjectRef);
  const [receiptRaw, ownerScore, subjectScore] = await Promise.all([
    input.redis.hget(receiptKey, receipt.sourceRef),
    input.redis.zscore(ownerIndexKey, receipt.sourceRef),
    input.redis.zscore(subjectIndexKey, receipt.sourceRef),
  ]);
  const canonicalReceipt = JSON.stringify(receipt);
  const hasExactIndexes =
    receiptRaw === canonicalReceipt &&
    ownerScore === String(receipt.decidedAt) &&
    subjectScore === String(receipt.decidedAt);
  if (!hasExactIndexes) throw new Error('F276 hard-forget F281 receipt/index invariant failed');

  input.plan.expect(decisionLocatorKey, decisionLocatorRaw ?? '');
  input.plan.expectHashField(receiptKey, receipt.sourceRef, canonicalReceipt);
  input.plan.expectZScore(ownerIndexKey, receipt.sourceRef, String(receipt.decidedAt));
  input.plan.expectZScore(subjectIndexKey, receipt.sourceRef, String(receipt.decidedAt));
  input.plan.del(decisionLocatorKey, 'string');
  input.plan.hdel(receiptKey, receipt.sourceRef);
  input.plan.zrem(ownerIndexKey, receipt.sourceRef);
  input.plan.zrem(subjectIndexKey, receipt.sourceRef);
  const sources = state.bindingSources.get(bindingKey) ?? new Set<string>();
  sources.add(receipt.sourceRef);
  state.bindingSources.set(bindingKey, sources);
}

async function planCandidateDispositionPurge(
  input: PlanDispositionPurgeInput,
  state: DispositionPurgeState,
  candidateId: string,
  snapshot: PersonMemoryCandidateSnapshot,
): Promise<void> {
  const bindingKey = snapshot.candidate.dispositionLineageBindingKey;
  if (!bindingKey) {
    if (snapshot.candidate.humanDispositionLedgerEntry) {
      throw new Error('F276 hard-forget candidate entry has no lineage binding');
    }
    return;
  }
  const candidateKey = PersonMemoryKeys.candidate(input.ownerUserId, candidateId);
  expectArtifact(state.artifactKeys, state.keyPrefix, candidateKey);
  expectArtifact(state.artifactKeys, state.keyPrefix, bindingKey);
  const bindingRaw = await input.redis.get(bindingKey);
  const binding = parseDispositionLineageBinding(bindingRaw);
  const isExactBinding =
    binding?.ownerUserId === input.ownerUserId &&
    binding.closurePersonId === input.personId &&
    input.candidates.has(binding.rootCandidateId) &&
    input.candidates.has(binding.currentCandidateId);
  if (!binding || !isExactBinding) {
    throw new Error('F276 hard-forget lineage binding is malformed or outside closure');
  }
  const locatorKey = PersonMemoryKeys.dispositionLineageHandleLocator(input.ownerUserId, binding.opaqueLineageHandle);
  expectArtifact(state.artifactKeys, state.keyPrefix, locatorKey);
  const locatorRaw = await input.redis.get(locatorKey);
  const locator = parseDispositionLineageHandleLocator(locatorRaw);
  if (locator?.bindingKey !== bindingKey || locator.closurePersonId !== input.personId) {
    throw new Error('F276 hard-forget lineage locator does not identify exact binding');
  }
  if (!state.plannedBindings.has(bindingKey)) {
    state.plannedBindings.add(bindingKey);
    input.plan.expect(bindingKey, bindingRaw ?? '');
    input.plan.expect(locatorKey, locatorRaw ?? '');
    input.plan.del(bindingKey, 'string');
    input.plan.del(locatorKey, 'string');
  }
  await planReceiptPurge(input, state, candidateKey, bindingKey, binding, snapshot);
}

async function validateDispositionSources(
  input: PlanDispositionPurgeInput,
  state: DispositionPurgeState,
): Promise<void> {
  for (const bindingKey of state.plannedBindings) {
    const binding = parseDispositionLineageBinding(await input.redis.get(bindingKey));
    if (!binding) throw new Error('F276 hard-forget lineage binding vanished');
    const sources = state.bindingSources.get(bindingKey) ?? new Set<string>();
    const hasMissingLatest =
      binding.latestDecisionReceiptHandle !== undefined && !sources.has(binding.latestDecisionReceiptHandle);
    if (hasMissingLatest || sources.size > 1) {
      throw new Error('F276 hard-forget disposition source is missing from exact closure');
    }
  }
}

export async function planPersonMemoryDispositionPurge(input: PlanDispositionPurgeInput): Promise<void> {
  const state: DispositionPurgeState = {
    artifactKeys: new Set(input.artifactKeys),
    keyPrefix: input.redis.options.keyPrefix ?? '',
    bindingSources: new Map(),
    plannedBindings: new Set(),
  };
  for (const [candidateId, snapshot] of input.candidates) {
    await planCandidateDispositionPurge(input, state, candidateId, snapshot);
  }
  await validateDispositionSources(input, state);
}
