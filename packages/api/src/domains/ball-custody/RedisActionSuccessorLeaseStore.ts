import type { RedisClient } from '@cat-cafe/shared/utils';
import type {
  ActionSubjectTerminalTruth,
  ActionSuccessorClaimStoreResult,
  ActionSuccessorCommitOutcomeResult,
  ActionSuccessorLeaseStore,
  ActionSuccessorLocalReviewRecoveryStoreResult,
  ActionSuccessorOutputPreflightResult,
} from './ActionSuccessorLeaseStore.js';
import { ActionSuccessorKeys } from './action-successor-keys.js';
import {
  type RecoverActiveLocalReviewVerdictInput,
  recoverActiveLocalReviewVerdict,
} from './action-successor-local-review-recovery-state-machine.js';
import { preflightActionSuccessorOutputInRedis } from './action-successor-output-preflight.js';
import { parseActionSubjectTerminal, parseActionSuccessorLease } from './action-successor-redis-codecs.js';
import {
  CAS_ACTION_SUCCESSOR_LUA,
  CLAIM_ACTION_SUCCESSOR_LUA,
  CLEAR_ACTION_SUBJECT_TERMINAL_LUA,
  COMMIT_ACTION_SUCCESSOR_CAS_LUA,
  MARK_ACTION_SUBJECT_TERMINAL_LUA,
  PREFLIGHT_ACTION_SUCCESSOR_LUA,
} from './action-successor-redis-scripts.js';
import {
  type ActionSuccessorIdentityInput,
  type ActionSuccessorLease,
  type ActionSuccessorPreflightResult,
  type ClaimActionSuccessorInput,
  canonicalizeActionSubjectRef,
  claimActionSuccessor,
  commitActionCompletionVerdict,
  continueActionSuccessorFreshRevision,
  type MarkActionSuccessorReturnDeliveredResult,
  markActionSuccessorReturnDelivered,
  recordActionCompletionCandidate,
  recordActionSuccessorOutcome,
  recordActionSuccessorReturnDeliveryAttempt,
  replaceActionSuccessor,
  returnActionSuccessorToPredecessor,
} from './action-successor-state-machine.js';

const MAX_CAS_ATTEMPTS = 20;

function isPendingReturn(lease: ActionSuccessorLease | null): lease is ActionSuccessorLease {
  return lease?.returnDeliveryState === 'pending' || lease?.returnDeliveryState === 'overdue';
}

function isPendingDispatch(lease: ActionSuccessorLease | null): lease is ActionSuccessorLease {
  return lease?.dispatchDeliveryState === 'pending';
}

function isActiveTaskLease(lease: ActionSuccessorLease | null): lease is ActionSuccessorLease {
  return (
    lease?.status === 'active' &&
    lease.actionFamily === 'implement' &&
    lease.successorSlot === 'implementer' &&
    lease.subjectRef.startsWith('subject:task:') &&
    lease.terminalPredicate?.kind === 'task_done'
  );
}

export class RedisActionSuccessorLeaseStore implements ActionSuccessorLeaseStore {
  constructor(private readonly redis: RedisClient) {}

  async get(leaseId: string): Promise<ActionSuccessorLease | null> {
    return parseActionSuccessorLease(await this.redis.get(ActionSuccessorKeys.detail(leaseId)));
  }

  async getByIdentity(input: ActionSuccessorIdentityInput): Promise<ActionSuccessorLease | null> {
    const indexedDetailKey = await this.redis.get(ActionSuccessorKeys.identity(input));
    if (!indexedDetailKey) return null;
    const keyPrefix = this.redis.options.keyPrefix ?? '';
    const detailKey =
      keyPrefix && indexedDetailKey.startsWith(keyPrefix) ? indexedDetailKey.slice(keyPrefix.length) : indexedDetailKey;
    return parseActionSuccessorLease(await this.redis.get(detailKey));
  }

  async listPendingReturns(limit = 100): Promise<ActionSuccessorLease[]> {
    return this.listMatching(limit, 'pending return', isPendingReturn);
  }

  async listActiveTaskLeases(limit = 100): Promise<ActionSuccessorLease[]> {
    return this.listMatching(limit, 'active task lease', isActiveTaskLease);
  }

  async listPendingDispatches(limit = 100): Promise<ActionSuccessorLease[]> {
    return this.listMatching(limit, 'pending dispatch', isPendingDispatch);
  }

  private async listMatching(
    limit: number,
    label: string,
    predicate: (lease: ActionSuccessorLease | null) => lease is ActionSuccessorLease,
  ): Promise<ActionSuccessorLease[]> {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error(`${label} limit must be a positive integer`);
    const keyPrefix = this.redis.options.keyPrefix ?? '';
    const keys = (await this.redis.smembers(ActionSuccessorKeys.ALL))
      .map((key) => (keyPrefix && key.startsWith(keyPrefix) ? key.slice(keyPrefix.length) : key))
      .sort();
    const matches: ActionSuccessorLease[] = [];
    const batchSize = 100;
    for (let offset = 0; offset < keys.length && matches.length < limit; offset += batchSize) {
      const batch = keys.slice(offset, offset + batchSize);
      const raws = await this.redis.mget(...batch);
      matches.push(...raws.map(parseActionSuccessorLease).filter(predicate));
    }
    return matches.slice(0, limit);
  }

  async claim(input: ClaimActionSuccessorInput): Promise<ActionSuccessorClaimStoreResult> {
    const candidate = claimActionSuccessor(null, input).lease;
    const raw = (await this.redis.eval(
      CLAIM_ACTION_SUCCESSOR_LUA,
      4,
      ActionSuccessorKeys.detail(candidate.leaseId),
      ActionSuccessorKeys.identity(candidate),
      ActionSuccessorKeys.subjectTerminal(candidate.subjectRef),
      ActionSuccessorKeys.ALL,
      candidate.dispatchId,
      JSON.stringify(candidate),
    )) as [string, string];
    const [outcome, payload] = raw;
    if (outcome === 'subject_terminal') {
      const terminal = parseActionSubjectTerminal(payload);
      if (!terminal) throw new Error('missing action subject terminal payload');
      return { outcome, terminal };
    }
    const lease = parseActionSuccessorLease(payload);
    if (!lease) throw new Error('missing action successor lease payload');
    if (outcome !== 'claimed' && outcome !== 'replayed' && outcome !== 'safe_wait') {
      throw new Error(`unexpected action successor claim outcome: ${outcome}`);
    }
    if (outcome === 'replayed') return claimActionSuccessor(lease, input);
    return { outcome, lease };
  }

  async commitOutcome(
    leaseId: string,
    input: Parameters<ActionSuccessorLeaseStore['commitOutcome']>[1],
  ): Promise<ActionSuccessorCommitOutcomeResult> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.get(leaseId);
      if (!current) return { outcome: 'lease_missing', lease: null };
      if (input.generation !== current.generation) return { outcome: 'stale_generation', lease: current };
      if (current.status !== 'active') return { outcome: 'lease_not_active', lease: current };
      if (!current.holderCatIds.includes(input.catId)) {
        throw new Error(`cat is not an action successor holder: ${input.catId}`);
      }
      if (current.holderOutcomes[input.catId]) return { outcome: 'holder_outcome_exists', lease: current };

      const next = recordActionSuccessorOutcome(current, input);
      const committed = await this.compareAndSetUnlessSubjectTerminal(current, next);
      if (committed === 'written') return { outcome: 'recorded', lease: next };
      if (committed === 'subject_terminal') return { outcome: 'subject_terminal', lease: current };
    }
    throw new Error(`action successor commit CAS exhausted: ${leaseId}`);
  }

  async recoverLocalReviewVerdict(
    leaseId: string,
    input: RecoverActiveLocalReviewVerdictInput,
  ): Promise<ActionSuccessorLocalReviewRecoveryStoreResult> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.require(leaseId);
      const result = recoverActiveLocalReviewVerdict(current, input);
      if (result.outcome !== 'recovered') return result;
      const committed = await this.compareAndSetUnlessSubjectTerminal(current, result.lease);
      if (committed === 'written') return result;
      if (committed === 'subject_terminal') return { outcome: 'subject_terminal', lease: current };
    }
    throw new Error(`action successor local-review recovery CAS exhausted: ${leaseId}`);
  }

  async recordCompletionCandidate(
    leaseId: string,
    input: Parameters<ActionSuccessorLeaseStore['recordCompletionCandidate']>[1],
  ): Promise<ActionSuccessorCommitOutcomeResult> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.get(leaseId);
      if (!current) return { outcome: 'lease_missing', lease: null };
      if (input.generation !== current.generation) return { outcome: 'stale_generation', lease: current };
      if (current.status !== 'active') return { outcome: 'lease_not_active', lease: current };
      if (!current.holderCatIds.includes(input.catId)) {
        throw new Error(`cat is not an action successor holder: ${input.catId}`);
      }
      if (current.holderOutcomes[input.catId]) return { outcome: 'holder_outcome_exists', lease: current };
      const next = recordActionCompletionCandidate(current, input);
      if (next === current) return { outcome: 'recorded', lease: next };
      const committed = await this.compareAndSetUnlessSubjectTerminal(current, next);
      if (committed === 'written') return { outcome: 'recorded', lease: next };
      if (committed === 'subject_terminal') return { outcome: 'subject_terminal', lease: current };
    }
    throw new Error(`action successor completion-candidate CAS exhausted: ${leaseId}`);
  }

  async commitCompletionVerdict(
    leaseId: string,
    input: Parameters<ActionSuccessorLeaseStore['commitCompletionVerdict']>[1],
  ): ReturnType<ActionSuccessorLeaseStore['commitCompletionVerdict']> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.get(leaseId);
      if (!current) return { outcome: 'lease_missing', lease: null };
      if (input.generation !== current.generation) return { outcome: 'stale_generation', lease: current };
      if (current.status !== 'active') return { outcome: 'lease_not_active', lease: current };
      if (current.holderOutcomes[input.catId]) return { outcome: 'holder_outcome_exists', lease: current };
      const candidate = current.completionCandidates[input.catId];
      if (
        input.verdict.status === 'verified' &&
        candidate &&
        (input.verdict.candidateRevision !== candidate.candidateRevision ||
          input.verdict.evidenceDigest !== candidate.evidenceDigest)
      ) {
        return { outcome: 'candidate_changed', lease: current };
      }
      const next = commitActionCompletionVerdict(current, input);
      const committed = await this.compareAndSetUnlessSubjectTerminal(current, next);
      if (committed === 'written') return { outcome: 'committed', lease: next };
      if (committed === 'subject_terminal') return { outcome: 'subject_terminal', lease: current };
    }
    throw new Error(`action successor completion-verdict CAS exhausted: ${leaseId}`);
  }

  async continueFreshRevision(
    leaseId: string,
    input: Parameters<ActionSuccessorLeaseStore['continueFreshRevision']>[1],
  ): ReturnType<ActionSuccessorLeaseStore['continueFreshRevision']> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.require(leaseId);
      const result = continueActionSuccessorFreshRevision(current, input);
      if (result.outcome !== 'continued') return result;
      const committed = await this.compareAndSetUnlessSubjectTerminal(current, result.lease);
      if (committed === 'written') return result;
      if (committed === 'subject_terminal') return { outcome: 'subject_terminal', lease: current };
    }
    throw new Error(`action successor fresh-revision CAS exhausted: ${leaseId}`);
  }

  async replace(
    leaseId: string,
    input: Parameters<ActionSuccessorLeaseStore['replace']>[1],
  ): ReturnType<ActionSuccessorLeaseStore['replace']> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.require(leaseId);
      const result = replaceActionSuccessor(current, input);
      if (result.outcome !== 'replaced' && result.outcome !== 'reattached') return result;
      const committed = await this.compareAndSetUnlessSubjectTerminal(current, result.lease);
      if (committed === 'written') return result;
      if (committed === 'subject_terminal') return { outcome: 'subject_terminal', lease: current };
    }
    throw new Error(`action successor CAS exhausted: ${leaseId}`);
  }

  async returnToPredecessor(
    leaseId: string,
    input: Parameters<ActionSuccessorLeaseStore['returnToPredecessor']>[1],
  ): ReturnType<ActionSuccessorLeaseStore['returnToPredecessor']> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.require(leaseId);
      const result = returnActionSuccessorToPredecessor(current, input);
      if (result.lease.revision === current.revision) return result;
      const committed = await this.compareAndSetUnlessSubjectTerminal(current, result.lease);
      if (committed === 'written') return result;
      if (committed === 'subject_terminal') return { outcome: 'subject_terminal', lease: current };
    }
    throw new Error(`action successor return CAS exhausted: ${leaseId}`);
  }

  async markReturnDelivered(
    leaseId: string,
    input: Parameters<ActionSuccessorLeaseStore['markReturnDelivered']>[1],
  ): Promise<MarkActionSuccessorReturnDeliveredResult> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.require(leaseId);
      const result = markActionSuccessorReturnDelivered(current, input);
      if (result.outcome !== 'delivered') return result;
      if (await this.compareAndSet(current, result.lease)) return result;
    }
    throw new Error(`action successor return-delivery CAS exhausted: ${leaseId}`);
  }

  async recordReturnDeliveryAttempt(
    leaseId: string,
    input: Parameters<ActionSuccessorLeaseStore['recordReturnDeliveryAttempt']>[1],
  ): ReturnType<ActionSuccessorLeaseStore['recordReturnDeliveryAttempt']> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.require(leaseId);
      const result = recordActionSuccessorReturnDeliveryAttempt(current, input);
      if (result.outcome !== 'recorded') return result;
      if (await this.compareAndSet(current, result.lease)) return result;
    }
    throw new Error(`action successor return-attempt CAS exhausted: ${leaseId}`);
  }

  async recordDispatchDeliveryAttempt(
    leaseId: string,
    input: Parameters<ActionSuccessorLeaseStore['recordDispatchDeliveryAttempt']>[1],
  ): ReturnType<ActionSuccessorLeaseStore['recordDispatchDeliveryAttempt']> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.require(leaseId);
      if (input.expectedGeneration !== current.generation) {
        return { outcome: 'stale_generation', lease: current };
      }
      if (current.dispatchDeliveryState !== 'pending') {
        return { outcome: 'dispatch_not_pending', lease: current };
      }
      const next: ActionSuccessorLease = {
        ...current,
        dispatchDeliveryAttemptCount: (current.dispatchDeliveryAttemptCount ?? 0) + 1,
        dispatchDeliveryLastAttemptAt: input.now,
        revision: current.revision + 1,
        updatedAt: input.now,
      };
      const committed = await this.compareAndSetUnlessSubjectTerminal(current, next);
      if (committed === 'subject_terminal') return { outcome: 'subject_terminal', lease: current };
      if (committed === 'written') return { outcome: 'recorded', lease: next };
    }
    throw new Error(`action successor dispatch-attempt CAS exhausted: ${leaseId}`);
  }

  async markDispatchDelivered(
    leaseId: string,
    input: Parameters<ActionSuccessorLeaseStore['markDispatchDelivered']>[1],
  ): ReturnType<ActionSuccessorLeaseStore['markDispatchDelivered']> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.require(leaseId);
      if (input.expectedGeneration !== current.generation) {
        return { outcome: 'stale_generation', lease: current };
      }
      if (current.dispatchDeliveryState !== 'pending') {
        return { outcome: 'dispatch_not_pending', lease: current };
      }
      const deliveredMessageId = input.deliveredMessageId.trim();
      const evidenceRef = input.evidenceRef.trim();
      if (!deliveredMessageId || !evidenceRef) {
        throw new Error('dispatch delivery requires message and evidence identities');
      }
      const next: ActionSuccessorLease = {
        ...current,
        dispatchDeliveryState: 'delivered',
        dispatchDeliveredMessageId: deliveredMessageId,
        evidenceRefs: [...new Set([...current.evidenceRefs, evidenceRef])],
        revision: current.revision + 1,
        updatedAt: input.now,
      };
      if (await this.compareAndSet(current, next)) return { outcome: 'delivered', lease: next };
    }
    throw new Error(`action successor dispatch-delivery CAS exhausted: ${leaseId}`);
  }

  async markSubjectTerminal(input: {
    subjectRef: string;
    state: ActionSubjectTerminalTruth['state'];
    evidenceRef: string;
    now: number;
  }): Promise<ActionSubjectTerminalTruth> {
    const terminal: ActionSubjectTerminalTruth = {
      subjectRef: canonicalizeActionSubjectRef(input.subjectRef),
      state: input.state,
      evidenceRef: input.evidenceRef,
      observedAt: input.now,
    };
    const raw = String(
      await this.redis.eval(
        MARK_ACTION_SUBJECT_TERMINAL_LUA,
        2,
        ActionSuccessorKeys.subjectTerminal(terminal.subjectRef),
        ActionSuccessorKeys.subjectTerminalHistory(terminal.subjectRef),
        JSON.stringify(terminal),
      ),
    );
    const persisted = parseActionSubjectTerminal(raw);
    if (!persisted) throw new Error('failed to persist action subject terminal truth');
    return persisted;
  }

  async getSubjectTerminal(subjectRef: string): Promise<ActionSubjectTerminalTruth | null> {
    return parseActionSubjectTerminal(await this.redis.get(ActionSuccessorKeys.subjectTerminal(subjectRef)));
  }

  async clearSubjectTerminal(subjectRef: string, input: { evidenceRef: string; now: number }): Promise<boolean> {
    const canonical = canonicalizeActionSubjectRef(subjectRef);
    const activeEvidence = JSON.stringify({
      subjectRef: canonical,
      state: 'active',
      evidenceRef: input.evidenceRef,
      observedAt: input.now,
    });
    const cleared = Number(
      await this.redis.eval(
        CLEAR_ACTION_SUBJECT_TERMINAL_LUA,
        2,
        ActionSuccessorKeys.subjectTerminal(canonical),
        ActionSuccessorKeys.subjectTerminalHistory(canonical),
        String(input.now),
        activeEvidence,
      ),
    );
    return cleared === 1;
  }

  async preflight(
    leaseId: string,
    generation: number,
    terminalPredicateDigest?: string,
  ): Promise<ActionSuccessorPreflightResult | { ok: false; reason: 'lease_missing' }> {
    const current = await this.get(leaseId);
    if (!current) return { ok: false, reason: 'lease_missing' };
    const reason = String(
      await this.redis.eval(
        PREFLIGHT_ACTION_SUCCESSOR_LUA,
        2,
        ActionSuccessorKeys.detail(leaseId),
        ActionSuccessorKeys.subjectTerminal(current.subjectRef),
        String(generation),
        terminalPredicateDigest ?? '',
      ),
    );
    if (reason === 'active') return { ok: true, reason };
    if (
      reason === 'subject_terminal' ||
      reason === 'stale_generation' ||
      reason === 'lease_not_active' ||
      reason === 'predicate_mismatch' ||
      reason === 'lease_missing'
    ) {
      return { ok: false, reason };
    }
    throw new Error(`unexpected action successor preflight result: ${reason}`);
  }

  async preflightOutput(
    leaseId: string,
    generation: number,
    catId: string,
    terminalPredicateDigest?: string,
  ): Promise<ActionSuccessorOutputPreflightResult | { ok: false; reason: 'lease_missing' }> {
    const current = await this.get(leaseId);
    if (!current) return { ok: false, reason: 'lease_missing' };
    return preflightActionSuccessorOutputInRedis(this.redis, current, generation, catId, terminalPredicateDigest);
  }

  private async require(leaseId: string): Promise<ActionSuccessorLease> {
    const current = await this.get(leaseId);
    if (!current) throw new Error(`action successor lease not found: ${leaseId}`);
    return current;
  }

  private async compareAndSet(current: ActionSuccessorLease, next: ActionSuccessorLease): Promise<boolean> {
    const result = Number(
      await this.redis.eval(
        CAS_ACTION_SUCCESSOR_LUA,
        2,
        ActionSuccessorKeys.detail(current.leaseId),
        ActionSuccessorKeys.identity(current),
        String(current.revision),
        JSON.stringify(next),
      ),
    );
    if (result === 1) return true;
    if (result === -1) return false;
    if (result === 0) throw new Error(`action successor lease not found: ${current.leaseId}`);
    throw new Error(`action successor identity index mismatch: ${current.leaseId}`);
  }

  private async compareAndSetUnlessSubjectTerminal(
    current: ActionSuccessorLease,
    next: ActionSuccessorLease,
  ): Promise<'written' | 'retry' | 'subject_terminal'> {
    const result = Number(
      await this.redis.eval(
        COMMIT_ACTION_SUCCESSOR_CAS_LUA,
        3,
        ActionSuccessorKeys.detail(current.leaseId),
        ActionSuccessorKeys.identity(current),
        ActionSuccessorKeys.subjectTerminal(current.subjectRef),
        String(current.revision),
        JSON.stringify(next),
      ),
    );
    if (result === 1) return 'written';
    if (result === -1) return 'retry';
    if (result === -3) return 'subject_terminal';
    if (result === 0) throw new Error(`action successor lease not found: ${current.leaseId}`);
    throw new Error(`action successor identity index mismatch: ${current.leaseId}`);
  }
}
