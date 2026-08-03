import type { FreshnessClosureAggregate, FreshnessClosureDisposition } from '@cat-cafe/shared';
import type { MigrateLegacyFreshnessClosureInput } from './freshness-closure-store-types.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function uniqueSorted(values: readonly string[], field: string, allowEmpty = false): string[] {
  const normalized = values.map((value) => value.trim());
  if ((!allowEmpty && normalized.length === 0) || normalized.some((value) => value.length === 0)) {
    throw new Error(`legacy migration ${field} must contain non-empty values`);
  }
  const unique = [...new Set(normalized)].sort();
  if (unique.length !== normalized.length) throw new Error(`legacy migration ${field} must not contain duplicates`);
  return unique;
}

function dispositionFrom(input: MigrateLegacyFreshnessClosureInput): FreshnessClosureDisposition {
  if (!input.actorId.trim() || !input.evidenceRef.trim()) {
    throw new Error('legacy migration requires actor and primary evidence');
  }
  if (!SHA256_PATTERN.test(input.manifestSha256) || !SHA256_PATTERN.test(input.accountingSha256)) {
    throw new Error('legacy migration requires valid manifest and accounting hashes');
  }
  const invocationIds = uniqueSorted(input.invocationIds, 'invocationIds');
  const messageIds = uniqueSorted(input.messageIds, 'messageIds', true);
  const evidenceRefs = uniqueSorted(input.evidenceRefs, 'evidenceRefs');
  if (!evidenceRefs.includes(input.evidenceRef)) {
    throw new Error('legacy migration evidenceRefs must include the primary evidenceRef');
  }
  const counts = input.outcomeCounts;
  for (const [kind, count] of Object.entries(counts) as Array<[string, number]>) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`legacy migration outcome count ${kind} must be a non-negative integer`);
    }
  }
  const formalCount = counts.already_formal_exact + counts.already_recovered_exact;
  if (formalCount + counts.no_text !== invocationIds.length) {
    throw new Error('legacy migration outcomes must account for every invocation exactly once');
  }
  if (messageIds.length !== formalCount) {
    throw new Error('legacy migration must record one exact message for every formal or recovered invocation');
  }
  return {
    kind: 'legacy_migrated',
    actorId: input.actorId,
    evidenceRef: input.evidenceRef,
    manifestSha256: input.manifestSha256,
    accountingSha256: input.accountingSha256,
    invocationIds,
    messageIds,
    evidenceRefs,
    outcomeCounts: { ...counts },
  };
}

function sameDisposition(
  current: FreshnessClosureDisposition | undefined,
  expected: FreshnessClosureDisposition,
): boolean {
  if (current?.kind !== 'legacy_migrated' || expected.kind !== 'legacy_migrated') return false;
  const { actorId: _currentActor, ...currentSemanticIdentity } = current;
  const { actorId: _expectedActor, ...expectedSemanticIdentity } = expected;
  return JSON.stringify(currentSemanticIdentity) === JSON.stringify(expectedSemanticIdentity);
}

export function migrateLegacyFreshnessClosure(
  closure: FreshnessClosureAggregate,
  input: MigrateLegacyFreshnessClosureInput,
): FreshnessClosureAggregate {
  const disposition = dispositionFrom(input);
  if (sameDisposition(closure.disposition, disposition)) return closure;
  if (closure.status === 'committed' || closure.status === 'disposed') {
    throw new Error('freshness closure already has a different legacy migration or terminal outcome');
  }
  if (closure.status !== 'blocked' || closure.activeAttempt) {
    throw new Error('only an inactive blocked legacy closure may be migrated');
  }
  if (closure.revision !== input.expectedRevision) {
    throw new Error(
      `legacy migration revision mismatch: expected ${input.expectedRevision}, current ${closure.revision}`,
    );
  }
  if (!Number.isSafeInteger(input.now) || input.now <= 0) throw new Error('legacy migration now must be positive');
  return {
    ...closure,
    status: 'disposed',
    activeAttempt: undefined,
    disposition,
    revision: closure.revision + 1,
    updatedAt: input.now,
  };
}
