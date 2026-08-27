import type {
  CatId,
  QueueAuthorIntent,
  QueueReminderAttempt,
  QueueTargetAttempt,
  QueueTargetOutcome,
} from '@cat-cafe/shared';
import {
  type ActionSuccessorFence,
  actionSuccessorFencesMatch,
} from '../../../../ball-custody/ActionSuccessorAdmissionContract.js';
import { normalizeOwnerAuthProvenance, type OwnerAuthProvenance } from '../../owner-auth-provenance.js';

export type QueuedMessageCustodyStatus = 'queued' | 'processing' | 'terminal';

export interface QueueBodyExposure {
  targetCatId: string;
  invocationId: string;
  seenAt: number;
}

export interface QueueTargetCarrierBinding {
  entryId: string;
  /** Immutable Queue admission identity, including action-successor generation. */
  idempotencyKey?: string;
  /** Durable action authority; passive restart must not downgrade this carrier. */
  actionSuccessorFence?: ActionSuccessorFence;
  source: 'agent';
  sourceCategory: 'a2a';
  callerCatId?: string;
  a2aParentInvocationId?: string;
  a2aTriggerMessageId: string;
  autoExecute: true;
  createdAt: number;
}

export interface QueueTargetCarrierState {
  status: 'queued' | 'processing';
  processingStartedAt?: number;
}

/**
 * Durable pre-CAS intent for one persisted A2A fan-out.
 *
 * Queue carriers are process-local until full custody is initialized. This
 * record is written after target policy is decided but before any carrier is
 * staged. `targetCats` is therefore the accepted subset startup may rebuild;
 * `requestedTargetCats` also preserves rejected targets so full custody can
 * terminalize them without making them selectable. Once full custody exists it
 * atomically replaces this intent as canonical truth.
 */
export interface QueueCustodyAdmissionIntent {
  version: 1;
  admissionId: string;
  ownerUserId: string;
  ownerAuthProvenance: OwnerAuthProvenance;
  intent: string;
  /** Targets admitted by depth/dedup/ping-pong policy and safe to reconstruct. */
  targetCats: CatId[];
  /** Complete requested fan-out; absent on v1 records written before accepted-subset persistence. */
  requestedTargetCats?: CatId[];
  callerCatId?: CatId;
  a2aParentInvocationId?: string;
  receiptScope?: 'primary_trigger' | 'cross_thread_delivery';
  actionSuccessorFence?: ActionSuccessorFence;
  priority: 'urgent' | 'normal';
  createdAt: number;
}

/**
 * Durable exact-group fence written before pre-start supersession begins.
 * A surviving member is sufficient to keep the complete group non-dispatchable
 * after process restart while idempotent retirement finishes.
 */
export interface QueuePrestartRetirementIntent {
  id: string;
  primaryEntryId: string;
  entryIds: string[];
  targetCatId: string;
  startedAt: number;
}

export interface QueuedMessageCustody {
  version: 1;
  entryId: string;
  revision: number;
  /** Durable Queue owner principal. Automated message authorship is provenance and may differ. */
  ownerUserId?: string;
  /** Immutable server-derived authentication fact. Missing only on legacy records. */
  ownerAuthProvenance?: OwnerAuthProvenance;
  /** The message started this invocation; keep custody but suppress the work-period timeline dock. */
  receiptScope?: 'primary_trigger' | 'cross_thread_delivery';
  /** F264: per-target author-declared work disposition. Missing legacy records mean next_work. */
  authorIntentByCatId?: Record<string, QueueAuthorIntent>;
  /**
   * A cross-thread callback message can dispatch one independent A2A Queue
   * carrier per target. This immutable map binds each target receipt to the
   * exact carrier without cloning the durable message body.
   */
  carrierByTargetCatId?: Record<string, QueueTargetCarrierBinding>;
  /**
   * Mutable target-local runtime state. Cross-thread targets use their immutable
   * carrier binding; standard targets share the immutable top-level entryId.
   */
  carrierStateByTargetCatId?: Record<string, QueueTargetCarrierState>;
  intent: string;
  status: QueuedMessageCustodyStatus;
  allTargetCats: CatId[];
  pendingTargetCats: CatId[];
  notifiedByCatIds: CatId[];
  /** Exact child creation witness, persisted before prompt body exposure. */
  awakenedInvocationIdByCatId?: Record<string, string>;
  awakenedAtByCatId?: Record<string, number>;
  seenByCatIds: CatId[];
  seenInvocationIdByCatId: Record<string, string>;
  /** Append-only exact prompt-body exposure history; message id is the enclosing custody record. */
  bodyExposures?: QueueBodyExposure[];
  /** F1308: append-only target delivery attempts; retries always append. */
  targetAttempts?: QueueTargetAttempt[];
  failedByCatIds: CatId[];
  /** Author-cleared targets: terminal for Queue actionability, preserved in owner history. */
  withdrawnByCatIds?: CatId[];
  withdrawnAtByCatId?: Record<string, number>;
  /** Exact completed action fence that made a withdrawn target permanently non-retryable. */
  actionSuccessorTerminalFenceByTargetCatId?: Record<string, ActionSuccessorFence>;
  handledByCatIds: CatId[];
  /** F264: exact successful invocation evidence; absent on legacy handled custody. */
  targetOutcomeByCatId?: Record<string, QueueTargetOutcome>;
  /** F264: exact Steer replacement fence while the selected message is running. */
  steeredInvocationIdByCatId?: Record<string, string>;
  /** F264: Steer was accepted but the replacement invocation has not bound its id yet. */
  steerRequestedByCatIds?: CatId[];
  /** Exact pre-start group currently being durably retired. */
  prestartRetirement?: QueuePrestartRetirementIntent;
  /** F264: append-only per-message reminder attempts, terminalized by the exact invocation. */
  reminderAttempts?: QueueReminderAttempt[];
  priority: 'urgent' | 'normal';
  position?: number;
  processingStartedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface QueueCustodyTransitionInput {
  expectedRevision: number;
  next: QueuedMessageCustody;
  deliveredAt?: number;
  /** Exact action-authority adoption/advance for an otherwise immutable carrier. */
  actionSuccessorRebind?: QueueCustodyActionSuccessorRebindProof;
  /**
   * Gate 2: non-persisted proof that one exact queued source is moving from an
   * absent carrier to its verified replacement. Ordinary transitions may not
   * change entryId.
   */
  replacement?: QueueCustodyReplacementProof;
}

export interface QueueCustodyActionSuccessorRebindProof {
  readonly kind: 'verified_action_successor';
  readonly entryId: string;
  readonly targetCatIds: CatId[];
  readonly fence: ActionSuccessorFence;
}

export interface QueueCustodyReplacementProof {
  readonly kind: 'verified';
  readonly previousEntryId: string;
  readonly replacementEntryId: string;
  readonly sourceMessageId: string;
}

function assertFiniteNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be a finite non-negative number`);
}

function assertUniqueTargets(values: readonly string[], field: string): void {
  if (values.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new Error(`${field} must contain non-empty cat ids`);
  }
  if (new Set(values).size !== values.length) throw new Error(`${field} must be unique`);
}

function isValidActionSuccessorFence(fence: ActionSuccessorFence | undefined): boolean {
  return (
    !!fence &&
    !!fence.leaseId &&
    Number.isInteger(fence.generation) &&
    fence.generation >= 1 &&
    !!fence.dispatchId &&
    (fence.terminalPredicateDigest === undefined || !!fence.terminalPredicateDigest) &&
    (fence.invocationLineageRef === undefined || !!fence.invocationLineageRef)
  );
}

function assertAdmissionTargetPartition(intent: QueueCustodyAdmissionIntent): void {
  assertUniqueTargets(intent.targetCats, 'queue custody admission targetCats');
  const requestedTargetCats = intent.requestedTargetCats ?? intent.targetCats;
  assertUniqueTargets(requestedTargetCats, 'queue custody admission requestedTargetCats');
  if (requestedTargetCats.length === 0) throw new Error('queue custody admission requires at least one target');
  if (intent.targetCats.some((catId) => !requestedTargetCats.includes(catId))) {
    throw new Error('queue custody admission accepted target must belong to requested targets');
  }
}

export function assertQueueCustodyAdmissionIntent(intent: QueueCustodyAdmissionIntent): void {
  if (intent.version !== 1) throw new Error('queue custody admission version must be 1');
  if (!intent.admissionId) throw new Error('queue custody admission id is required');
  if (!intent.ownerUserId) throw new Error('queue custody admission owner is required');
  if (normalizeOwnerAuthProvenance(intent.ownerAuthProvenance) !== intent.ownerAuthProvenance) {
    throw new Error('invalid queue custody admission ownerAuthProvenance');
  }
  if (!intent.intent) throw new Error('queue custody admission intent is required');
  assertAdmissionTargetPartition(intent);
  if (
    intent.receiptScope !== undefined &&
    intent.receiptScope !== 'primary_trigger' &&
    intent.receiptScope !== 'cross_thread_delivery'
  ) {
    throw new Error(`invalid queue custody admission receipt scope: ${String(intent.receiptScope)}`);
  }
  if (intent.priority !== 'urgent' && intent.priority !== 'normal') {
    throw new Error(`invalid queue custody admission priority: ${String(intent.priority)}`);
  }
  assertFiniteNonNegative(intent.createdAt, 'queue custody admission createdAt');
  const fence = intent.actionSuccessorFence;
  if (fence && !isValidActionSuccessorFence(fence)) {
    throw new Error('invalid queue custody admission action successor fence');
  }
}

export function cloneQueueCustodyAdmissionIntent(intent: QueueCustodyAdmissionIntent): QueueCustodyAdmissionIntent {
  assertQueueCustodyAdmissionIntent(intent);
  return {
    ...intent,
    targetCats: [...intent.targetCats],
    ...(intent.requestedTargetCats ? { requestedTargetCats: [...intent.requestedTargetCats] } : {}),
    ...(intent.actionSuccessorFence ? { actionSuccessorFence: { ...intent.actionSuccessorFence } } : {}),
  };
}

export function parseQueueCustodyAdmissionIntent(raw: string | undefined): QueueCustodyAdmissionIntent | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as QueueCustodyAdmissionIntent;
    assertQueueCustodyAdmissionIntent(parsed);
    return cloneQueueCustodyAdmissionIntent(parsed);
  } catch {
    return undefined;
  }
}

export function queueCustodyAdmissionIntentsMatch(
  actual: QueueCustodyAdmissionIntent | undefined,
  expected: QueueCustodyAdmissionIntent,
): boolean {
  return !!actual && JSON.stringify(actual) === JSON.stringify(expected);
}

function assertCustodyIdentity(custody: QueuedMessageCustody): void {
  if (custody.version !== 1) throw new Error('queue custody version must be 1');
  if (!custody.entryId) throw new Error('queue custody entryId is required');
  if (custody.ownerUserId !== undefined && custody.ownerUserId.length === 0) {
    throw new Error('queue custody ownerUserId must be non-empty');
  }
  if (
    custody.ownerAuthProvenance !== undefined &&
    normalizeOwnerAuthProvenance(custody.ownerAuthProvenance) !== custody.ownerAuthProvenance
  ) {
    throw new Error('invalid queue custody ownerAuthProvenance');
  }
  if (!Number.isInteger(custody.revision) || custody.revision < 1) {
    throw new Error('queue custody revision must be a positive integer');
  }
  if (!custody.intent) throw new Error('queue custody intent is required');
  if (
    custody.receiptScope !== undefined &&
    custody.receiptScope !== 'primary_trigger' &&
    custody.receiptScope !== 'cross_thread_delivery'
  ) {
    throw new Error(`invalid queue custody receipt scope: ${String(custody.receiptScope)}`);
  }
  const carriers = custody.carrierByTargetCatId;
  if (custody.receiptScope === 'cross_thread_delivery' && !carriers) {
    throw new Error('cross-thread delivery custody requires per-target carrier bindings');
  }
  if (carriers) {
    const carrierTargets = Object.keys(carriers);
    if (carrierTargets.some((catId) => !custody.allTargetCats.includes(catId as CatId))) {
      throw new Error('queue custody carrier target must belong to allTargetCats');
    }
    for (const [catId, binding] of Object.entries(carriers)) {
      if (
        !binding.entryId ||
        binding.source !== 'agent' ||
        binding.sourceCategory !== 'a2a' ||
        !binding.a2aTriggerMessageId ||
        binding.autoExecute !== true
      ) {
        throw new Error('invalid cross-thread Queue carrier binding');
      }
      if (binding.idempotencyKey !== undefined && binding.idempotencyKey.length === 0) {
        throw new Error('cross-thread Queue carrier idempotency key must be non-empty');
      }
      if (binding.actionSuccessorFence) {
        if (!isValidActionSuccessorFence(binding.actionSuccessorFence)) {
          throw new Error('invalid cross-thread Queue carrier action successor fence');
        }
        const expectedActionKey = `action:${binding.actionSuccessorFence.leaseId}:${binding.actionSuccessorFence.generation}:${catId}`;
        if (binding.idempotencyKey !== expectedActionKey) {
          throw new Error('action-successor Queue carrier requires its exact durable idempotency key');
        }
      }
      assertFiniteNonNegative(binding.createdAt, 'carrier.createdAt');
    }
  }
  if (custody.carrierStateByTargetCatId) {
    for (const [catId, state] of Object.entries(custody.carrierStateByTargetCatId)) {
      if (!custody.allTargetCats.includes(catId as CatId) || !custody.pendingTargetCats.includes(catId as CatId)) {
        throw new Error('queue custody carrier state requires a pending target');
      }
      if (carriers && !carriers[catId]) {
        throw new Error('cross-thread queue custody carrier state requires an immutable carrier binding');
      }
      if (state.status !== 'queued' && state.status !== 'processing') {
        throw new Error('invalid queue custody carrier state');
      }
      if (state.processingStartedAt !== undefined) {
        assertFiniteNonNegative(state.processingStartedAt, 'carrier.processingStartedAt');
      }
    }
  }
  for (const [catId, invocationId] of Object.entries(custody.awakenedInvocationIdByCatId ?? {})) {
    if (!custody.allTargetCats.includes(catId as CatId) || !invocationId) {
      throw new Error('queue custody awakened child must bind a target and invocation');
    }
    const awakenedAt = custody.awakenedAtByCatId?.[catId];
    if (awakenedAt === undefined) throw new Error('queue custody awakened child requires awakenedAt');
    assertFiniteNonNegative(awakenedAt, 'awakenedAt');
  }
  for (const catId of Object.keys(custody.awakenedAtByCatId ?? {})) {
    if (!custody.awakenedInvocationIdByCatId?.[catId]) {
      throw new Error('queue custody awakenedAt requires an exact child invocation');
    }
  }
  if (custody.priority !== 'urgent' && custody.priority !== 'normal') {
    throw new Error(`invalid queue custody priority: ${custody.priority}`);
  }
  assertFiniteNonNegative(custody.createdAt, 'createdAt');
  assertFiniteNonNegative(custody.updatedAt, 'updatedAt');
  if (custody.updatedAt < custody.createdAt) throw new Error('updatedAt cannot precede createdAt');
  if (custody.processingStartedAt !== undefined) {
    assertFiniteNonNegative(custody.processingStartedAt, 'processingStartedAt');
  }
  if (custody.position !== undefined && !Number.isFinite(custody.position)) {
    throw new Error('queue custody position must be a finite number');
  }
  if (custody.prestartRetirement) {
    const retirement = custody.prestartRetirement;
    if (
      !retirement.id ||
      !retirement.primaryEntryId ||
      !retirement.targetCatId ||
      retirement.entryIds.length === 0 ||
      retirement.entryIds.some((entryId) => !entryId) ||
      new Set(retirement.entryIds).size !== retirement.entryIds.length ||
      !retirement.entryIds.includes(retirement.primaryEntryId)
    ) {
      throw new Error('invalid pre-start retirement group identity');
    }
    assertFiniteNonNegative(retirement.startedAt, 'prestartRetirement.startedAt');
  }
}

function carrierBindingWithoutActionIdentity(binding: QueueTargetCarrierBinding): object {
  const { idempotencyKey: _idempotencyKey, actionSuccessorFence: _actionSuccessorFence, ...base } = binding;
  return base;
}

function assertSelectedActionSuccessorCarrierRebind(
  before: QueueTargetCarrierBinding | undefined,
  after: QueueTargetCarrierBinding | undefined,
  catId: string,
  proof: QueueCustodyActionSuccessorRebindProof,
): void {
  if (
    !before ||
    !after ||
    before.entryId !== proof.entryId ||
    after.entryId !== proof.entryId ||
    JSON.stringify(carrierBindingWithoutActionIdentity(after)) !==
      JSON.stringify(carrierBindingWithoutActionIdentity(before))
  ) {
    throw new Error('action-successor Queue carrier rebind cannot change immutable carrier identity');
  }
  const priorFence = before.actionSuccessorFence;
  if (
    priorFence &&
    (priorFence.leaseId !== proof.fence.leaseId ||
      priorFence.dispatchId !== proof.fence.dispatchId ||
      proof.fence.generation < priorFence.generation)
  ) {
    throw new Error('action-successor Queue carrier rebind cannot replace or rewind authority');
  }
  if (JSON.stringify(after.actionSuccessorFence) !== JSON.stringify(proof.fence)) {
    throw new Error('action-successor Queue carrier rebind must persist the exact verified fence');
  }
  const expectedKey = `action:${proof.fence.leaseId}:${proof.fence.generation}:${catId}`;
  if (after.idempotencyKey !== expectedKey) {
    throw new Error('action-successor Queue carrier rebind must persist the exact action idempotency key');
  }
}

function assertActionSuccessorCarrierRebind(
  current: QueuedMessageCustody,
  next: QueuedMessageCustody,
  proof: QueueCustodyActionSuccessorRebindProof,
): void {
  if (!proof.entryId || proof.targetCatIds.length === 0) {
    throw new Error('action-successor Queue carrier rebind requires an exact carrier and targets');
  }
  assertUniqueTargets(proof.targetCatIds, 'action-successor Queue carrier rebind targets');
  if (!isValidActionSuccessorFence(proof.fence)) {
    throw new Error('action-successor Queue carrier rebind requires a valid fence');
  }
  const selectedTargets = new Set<string>(proof.targetCatIds);
  const allTargets = new Set([
    ...Object.keys(current.carrierByTargetCatId ?? {}),
    ...Object.keys(next.carrierByTargetCatId ?? {}),
  ]);
  for (const catId of allTargets) {
    const before = current.carrierByTargetCatId?.[catId];
    const after = next.carrierByTargetCatId?.[catId];
    if (!selectedTargets.has(catId)) {
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        throw new Error('action-successor Queue carrier rebind cannot mutate another target binding');
      }
      continue;
    }
    assertSelectedActionSuccessorCarrierRebind(before, after, catId, proof);
  }
  if (proof.targetCatIds.some((catId) => !allTargets.has(catId))) {
    throw new Error('action-successor Queue carrier rebind target is not custody-bound');
  }
}

function assertTargetSubsets(custody: QueuedMessageCustody, allTargets: ReadonlySet<string>): void {
  const targetSets = [
    ['pendingTargetCats', custody.pendingTargetCats],
    ['notifiedByCatIds', custody.notifiedByCatIds],
    ['seenByCatIds', custody.seenByCatIds],
    ['failedByCatIds', custody.failedByCatIds],
    ['withdrawnByCatIds', custody.withdrawnByCatIds ?? []],
    ['handledByCatIds', custody.handledByCatIds],
  ] as const;
  for (const [field, values] of targetSets) {
    if (values.some((catId) => !allTargets.has(catId))) throw new Error(`${field} must be a subset of allTargetCats`);
  }
}

function assertInvocationBindings(custody: QueuedMessageCustody, allTargets: ReadonlySet<string>): void {
  for (const [catId, invocationId] of Object.entries(custody.seenInvocationIdByCatId)) {
    if (!allTargets.has(catId) || !custody.seenByCatIds.includes(catId as CatId) || !invocationId) {
      throw new Error('seenInvocationIdByCatId must bind seen targets to non-empty invocation ids');
    }
    // Pre-F264 custody can carry a parent-level seen binding without an exact
    // body exposure. Mixed records are valid during rolling migration: exact
    // targets project seenAt, while legacy targets remain visible without one.
  }
  for (const [catId, invocationId] of Object.entries(custody.steeredInvocationIdByCatId ?? {})) {
    if (!allTargets.has(catId) || !custody.pendingTargetCats.includes(catId as CatId) || !invocationId) {
      throw new Error('steeredInvocationIdByCatId must bind pending targets to non-empty invocation ids');
    }
  }
  for (const [catId, invocationId] of Object.entries(custody.awakenedInvocationIdByCatId ?? {})) {
    if (!allTargets.has(catId) || !custody.pendingTargetCats.includes(catId as CatId) || !invocationId) {
      throw new Error('awakenedInvocationIdByCatId must bind pending targets to non-empty invocation ids');
    }
  }
  assertUniqueTargets(custody.steerRequestedByCatIds ?? [], 'steerRequestedByCatIds');
  if ((custody.steerRequestedByCatIds ?? []).some((catId) => !custody.pendingTargetCats.includes(catId))) {
    throw new Error('steerRequestedByCatIds must contain pending targets only');
  }
}

function assertTargetOutcomeExposure(
  custody: QueuedMessageCustody,
  catId: string,
  outcome: QueueTargetOutcome,
  allowLegacyMissingExposure: boolean,
): void {
  const exposure = custody.bodyExposures?.find(
    (candidate) => candidate.targetCatId === catId && candidate.invocationId === outcome.invocationId,
  );
  if (!exposure) {
    if (!allowLegacyMissingExposure) throw new Error('target outcome requires matching exact body exposure');
    return;
  }
  if (outcome.handledAt <= exposure.seenAt) {
    throw new Error('target outcome handledAt must follow exact body exposure seenAt');
  }
}

function assertTargetOutcomes(
  custody: QueuedMessageCustody,
  allTargets: ReadonlySet<string>,
  allowLegacyMissingExposure = false,
): void {
  for (const [catId, outcome] of Object.entries(custody.targetOutcomeByCatId ?? {})) {
    if (!allTargets.has(catId) || !custody.handledByCatIds.includes(catId as CatId)) {
      throw new Error('targetOutcomeByCatId must contain handled targets only');
    }
    if (
      !outcome.invocationId ||
      (outcome.evidenceRef?.kind !== 'invocation_lineage' && outcome.evidenceRef?.kind !== 'turn_execution') ||
      outcome.evidenceRef.invocationId !== outcome.invocationId
    ) {
      throw new Error('target outcome must carry matching invocation evidence');
    }
    if (
      outcome.disposition !== 'responded' &&
      outcome.disposition !== 'completed_with_turn' &&
      outcome.disposition !== 'managed_hold_disposition'
    ) {
      throw new Error(`invalid target outcome disposition: ${outcome.disposition}`);
    }
    if (outcome.consumption !== undefined) {
      if (outcome.consumption.kind === 'terminal_silent') {
        if (
          outcome.consumption.projectionState !== 'covered_empty' ||
          outcome.consumption.wake !== 'coordination_terminal'
        ) {
          throw new Error('invalid target terminal consumption witness');
        }
      } else if (outcome.consumption.kind === 'source_response') {
        const outputMessageIds = outcome.consumption.outputMessageIds;
        if (
          outputMessageIds.length === 0 ||
          outputMessageIds.some((messageId) => typeof messageId !== 'string' || messageId.length === 0) ||
          new Set(outputMessageIds).size !== outputMessageIds.length
        ) {
          throw new Error('source response consumption requires unique output message ids');
        }
      } else if (outcome.consumption.kind === 'managed_hold_continued') {
        if (
          !outcome.consumption.sourceMessageId ||
          !outcome.consumption.taskId ||
          !['reheld', 'event_wait', 'transferred'].includes(outcome.consumption.transition)
        ) {
          throw new Error('invalid managed hold continuation witness');
        }
      } else if (outcome.consumption.kind === 'dispatch_handled_continuation') {
        if (
          !outcome.consumption.sourceMessageId ||
          !outcome.consumption.dispositionEventId ||
          !Number.isFinite(outcome.consumption.dispositionAt) ||
          outcome.consumption.dispositionAt < 0
        ) {
          throw new Error('invalid dispatch handled continuation witness');
        }
      } else {
        throw new Error('invalid target terminal consumption witness');
      }
    }
    assertFiniteNonNegative(outcome.handledAt, 'targetOutcome.handledAt');
    assertTargetOutcomeExposure(custody, catId, outcome, allowLegacyMissingExposure);
  }
}

function assertBodyExposures(custody: QueuedMessageCustody, allTargets: ReadonlySet<string>): void {
  const keys = new Set<string>();
  for (const exposure of custody.bodyExposures ?? []) {
    if (!allTargets.has(exposure.targetCatId) || !exposure.invocationId) {
      throw new Error('body exposure must bind a target and non-empty invocation id');
    }
    assertFiniteNonNegative(exposure.seenAt, 'bodyExposure.seenAt');
    const key = `${exposure.targetCatId}\u0000${exposure.invocationId}`;
    if (keys.has(key)) throw new Error('body exposures must be unique by target invocation');
    keys.add(key);
  }
}

function assertReminderAttemptTimestamps(attempt: QueueReminderAttempt): void {
  assertFiniteNonNegative(attempt.requestedAt, 'reminderAttempt.requestedAt');
  if (attempt.deliveredAt !== undefined) {
    assertFiniteNonNegative(attempt.deliveredAt, 'reminderAttempt.deliveredAt');
  }
  if (attempt.state === 'delivered' && attempt.deliveredAt === undefined) {
    throw new Error('delivered reminder attempt requires deliveredAt');
  }
  if (attempt.state === 'seen') {
    if (attempt.seenAt === undefined) throw new Error('seen reminder attempt requires seenAt');
    assertFiniteNonNegative(attempt.seenAt, 'reminderAttempt.seenAt');
  }
  if (attempt.state === 'missed') {
    const validReason =
      attempt.missedReason === 'invocation_ended_before_delivery' ||
      attempt.missedReason === 'delivered_not_read' ||
      attempt.missedReason === 'source_withdrawn';
    if (attempt.missedAt === undefined || !validReason) {
      throw new Error('missed reminder attempt requires missedAt and a valid missedReason');
    }
    assertFiniteNonNegative(attempt.missedAt, 'reminderAttempt.missedAt');
  }
}

function assertReminderAttempts(custody: QueuedMessageCustody, allTargets: ReadonlySet<string>): void {
  const reminderKeys = new Set<string>();
  const reminderIds = new Set<string>();
  for (const attempt of custody.reminderAttempts ?? []) {
    if (!attempt.id || !attempt.invocationId || !allTargets.has(attempt.targetCatId)) {
      throw new Error('reminder attempt must bind a target and invocation with a non-empty id');
    }
    const key = `${attempt.targetCatId}\u0000${attempt.invocationId}`;
    if (reminderKeys.has(key) || reminderIds.has(attempt.id)) {
      throw new Error('reminder attempts must be unique by id and target invocation');
    }
    reminderKeys.add(key);
    reminderIds.add(attempt.id);
    if (!['requested', 'delivered', 'seen', 'missed'].includes(attempt.state)) {
      throw new Error(`invalid reminder attempt state: ${attempt.state}`);
    }
    assertReminderAttemptTimestamps(attempt);
  }
}

const TARGET_ATTEMPT_NEXT_STATES: Readonly<
  Record<QueueTargetAttempt['state'], ReadonlySet<QueueTargetAttempt['state']>>
> = {
  queued: new Set(['queued', 'starting', 'appended', 'failed', 'interrupted', 'cancelled', 'handled']),
  starting: new Set(['starting', 'appended', 'failed', 'interrupted', 'cancelled', 'handled']),
  appended: new Set(['appended', 'failed', 'interrupted', 'cancelled', 'handled']),
  failed: new Set(['failed']),
  interrupted: new Set(['interrupted']),
  cancelled: new Set(['cancelled']),
  handled: new Set(['handled']),
};

function assertTargetAttempts(custody: QueuedMessageCustody, allTargets: ReadonlySet<string>): void {
  const ids = new Set<string>();
  const sequencesByTarget = new Map<string, Set<number>>();
  for (const attempt of custody.targetAttempts ?? []) {
    if (
      !attempt.id ||
      !allTargets.has(attempt.targetCatId) ||
      !Number.isInteger(attempt.sequence) ||
      attempt.sequence < 1
    ) {
      throw new Error('target attempt must bind a target with a positive sequence and non-empty id');
    }
    if (!TARGET_ATTEMPT_NEXT_STATES[attempt.state]) throw new Error('invalid target attempt state');
    if (ids.has(attempt.id)) throw new Error('target attempt ids must be unique');
    ids.add(attempt.id);
    const sequences = sequencesByTarget.get(attempt.targetCatId) ?? new Set<number>();
    if (sequences.has(attempt.sequence)) throw new Error('target attempt sequences must be unique per target');
    sequences.add(attempt.sequence);
    sequencesByTarget.set(attempt.targetCatId, sequences);
    assertFiniteNonNegative(attempt.createdAt, 'targetAttempt.createdAt');
    assertFiniteNonNegative(attempt.updatedAt, 'targetAttempt.updatedAt');
    if (attempt.updatedAt < attempt.createdAt) throw new Error('target attempt updatedAt cannot precede createdAt');
    if (attempt.invocationId !== undefined && !attempt.invocationId)
      throw new Error('target attempt invocation id cannot be empty');
    if (attempt.seenAt !== undefined) assertFiniteNonNegative(attempt.seenAt, 'targetAttempt.seenAt');
    if (
      attempt.terminalReason !== undefined &&
      !['invocation_failed', 'runtime_restart', 'invocation_cancelled', 'source_withdrawn'].includes(
        attempt.terminalReason,
      )
    ) {
      throw new Error('invalid target attempt terminal reason');
    }
    if (attempt.state === 'failed' && attempt.terminalReason !== 'invocation_failed') {
      throw new Error('failed target attempt requires invocation_failed reason');
    }
    if (attempt.state === 'interrupted' && attempt.terminalReason !== 'runtime_restart') {
      throw new Error('interrupted target attempt requires runtime_restart reason');
    }
    if (
      attempt.state === 'cancelled' &&
      !['invocation_cancelled', 'source_withdrawn'].includes(attempt.terminalReason ?? '')
    ) {
      throw new Error('cancelled target attempt requires a cancellation reason');
    }
    if (
      (attempt.state === 'starting' || attempt.state === 'appended' || attempt.state === 'handled') &&
      !attempt.invocationId
    ) {
      throw new Error('started, appended, and handled target attempts require an invocation id');
    }
    if (attempt.state === 'appended' && attempt.seenAt === undefined) {
      throw new Error('appended target attempt requires exact body exposure time');
    }
  }
}

function assertAuthorIntentCarrierCapability(authorIntent: QueueAuthorIntent): void {
  const capability = authorIntent.carrierCapability;
  if (!capability) return;
  if (!['openai_codex', 'anthropic', 'kimi', 'other'].includes(capability.provider)) {
    throw new Error('invalid queue author intent carrier provider');
  }
  if (
    ![
      'codex_app_server',
      'codex_exec_json',
      'claude_print_sdk',
      'claude_stream_json',
      'kimi_stream_json',
      'mcp_result_piggyback',
      'other',
    ].includes(capability.carrier)
  ) {
    throw new Error('invalid queue author intent carrier');
  }
  if (
    !['exact_active_turn', 'queued_internal_turn', 'mcp_result_piggyback', 'unsupported', 'undeclared'].includes(
      capability.deliverySemantics,
    )
  ) {
    throw new Error('invalid queue author intent carrier delivery semantics');
  }
}

function assertAuthorIntentDisposition(authorIntent: QueueAuthorIntent): void {
  if (authorIntent.requested !== 'continue_current' && authorIntent.requested !== 'next_work') {
    throw new Error('invalid queue author intent disposition');
  }
  if (authorIntent.requested === 'next_work' && authorIntent.boundParentInvocationId !== undefined) {
    throw new Error('next-work author intent cannot bind a parent invocation');
  }
  const allowsMissingParent =
    authorIntent.fallbackReason === 'no_active_parent' ||
    authorIntent.fallbackReason === 'carrier_capability_undeclared' ||
    authorIntent.fallbackReason === 'unsupported_carrier';
  if (authorIntent.requested === 'continue_current' && !authorIntent.boundParentInvocationId && !allowsMissingParent) {
    throw new Error('continue-current author intent requires an exact parent fence');
  }
}

function assertAuthorIntentFallback(authorIntent: QueueAuthorIntent): void {
  const validReasons = new Set([
    'no_active_parent',
    'carrier_capability_undeclared',
    'unsupported_carrier',
    'parent_terminal_before_exposure',
    'parent_non_success_after_exposure',
  ]);
  if ((authorIntent.fallbackAt === undefined) !== (authorIntent.fallbackReason === undefined)) {
    throw new Error('queue author intent fallback requires timestamp and reason together');
  }
  if (authorIntent.fallbackAt !== undefined) {
    assertFiniteNonNegative(authorIntent.fallbackAt, 'authorIntent.fallbackAt');
  }
  if (authorIntent.fallbackReason !== undefined && !validReasons.has(authorIntent.fallbackReason)) {
    throw new Error('invalid queue author intent fallback reason');
  }
}

function assertAuthorIntents(custody: QueuedMessageCustody, allTargets: ReadonlySet<string>): void {
  for (const [catId, authorIntent] of Object.entries(custody.authorIntentByCatId ?? {})) {
    if (!allTargets.has(catId)) throw new Error('queue author intent target must belong to allTargetCats');
    assertAuthorIntentDisposition(authorIntent);
    assertAuthorIntentCarrierCapability(authorIntent);
    assertAuthorIntentFallback(authorIntent);
  }
}

function assertCustodyTargets(custody: QueuedMessageCustody, allowLegacyMissingExposure = false): void {
  assertUniqueTargets(custody.allTargetCats, 'allTargetCats');
  if (custody.allTargetCats.length === 0) throw new Error('queue custody requires at least one target');
  assertUniqueTargets(custody.pendingTargetCats, 'pendingTargetCats');
  assertUniqueTargets(custody.notifiedByCatIds, 'notifiedByCatIds');
  assertUniqueTargets(custody.seenByCatIds, 'seenByCatIds');
  assertUniqueTargets(custody.failedByCatIds, 'failedByCatIds');
  assertUniqueTargets(custody.withdrawnByCatIds ?? [], 'withdrawnByCatIds');
  assertUniqueTargets(custody.handledByCatIds, 'handledByCatIds');

  const allTargets = new Set<string>(custody.allTargetCats);
  assertAuthorIntents(custody, allTargets);
  for (const catId of custody.withdrawnByCatIds ?? []) {
    const withdrawnAt = custody.withdrawnAtByCatId?.[catId];
    if (withdrawnAt === undefined) throw new Error('withdrawn target requires withdrawnAt');
    assertFiniteNonNegative(withdrawnAt, 'withdrawnAt');
  }
  for (const catId of Object.keys(custody.withdrawnAtByCatId ?? {})) {
    if (!custody.withdrawnByCatIds?.includes(catId as CatId)) {
      throw new Error('withdrawnAt requires a withdrawn target');
    }
  }
  for (const [catId, terminalFence] of Object.entries(custody.actionSuccessorTerminalFenceByTargetCatId ?? {})) {
    if (!custody.withdrawnByCatIds?.includes(catId as CatId)) {
      throw new Error('action-successor terminal fence requires a withdrawn target');
    }
    if (!isValidActionSuccessorFence(terminalFence)) {
      throw new Error('invalid withdrawn action-successor terminal fence');
    }
    if (!actionSuccessorFencesMatch(custody.carrierByTargetCatId?.[catId]?.actionSuccessorFence, terminalFence)) {
      throw new Error('withdrawn action-successor terminal fence must match its immutable carrier');
    }
  }
  assertTargetSubsets(custody, allTargets);
  assertBodyExposures(custody, allTargets);
  assertInvocationBindings(custody, allTargets);
  assertTargetOutcomes(custody, allTargets, allowLegacyMissingExposure);
  assertReminderAttempts(custody, allTargets);
  assertTargetAttempts(custody, allTargets);
}

function assertCustodyLifecycle(custody: QueuedMessageCustody): void {
  if (!['queued', 'processing', 'terminal'].includes(custody.status)) {
    throw new Error(`invalid queue custody status: ${custody.status}`);
  }
  if (custody.pendingTargetCats.some((catId) => custody.handledByCatIds.includes(catId))) {
    throw new Error('pending and handled targets must be disjoint');
  }
  if (custody.pendingTargetCats.some((catId) => custody.withdrawnByCatIds?.includes(catId))) {
    throw new Error('pending and withdrawn targets must be disjoint');
  }
  if (custody.handledByCatIds.some((catId) => custody.withdrawnByCatIds?.includes(catId))) {
    throw new Error('handled and withdrawn targets must be disjoint');
  }
  if (custody.status === 'terminal' && custody.pendingTargetCats.length > 0) {
    throw new Error('terminal queue custody cannot retain pending targets');
  }
  if (custody.status !== 'terminal' && custody.pendingTargetCats.length === 0) {
    throw new Error('active queue custody requires a pending target');
  }
  const activeCarrierTargets = Object.keys(custody.carrierStateByTargetCatId ?? {});
  if (activeCarrierTargets.some((catId) => custody.handledByCatIds.includes(catId as CatId))) {
    throw new Error('handled target cannot retain an active Queue carrier state');
  }
  if (activeCarrierTargets.some((catId) => custody.withdrawnByCatIds?.includes(catId as CatId))) {
    throw new Error('withdrawn target cannot retain an active Queue carrier state');
  }
  if (custody.status === 'terminal' && activeCarrierTargets.length > 0) {
    throw new Error('terminal queue custody cannot retain an active Queue carrier state');
  }
  if (
    custody.status === 'terminal' &&
    ((custody.reminderAttempts ?? []).some(
      (attempt) => attempt.state === 'requested' || attempt.state === 'delivered',
    ) ||
      (custody.steerRequestedByCatIds?.length ?? 0) > 0 ||
      Object.keys(custody.steeredInvocationIdByCatId ?? {}).length > 0)
  ) {
    throw new Error('terminal queue custody cannot retain an active reminder or Steer state');
  }
}

function assertTargetOutcomeMonotonicity(current: QueuedMessageCustody, next: QueuedMessageCustody): void {
  for (const [catId, outcome] of Object.entries(current.targetOutcomeByCatId ?? {})) {
    if (JSON.stringify(next.targetOutcomeByCatId?.[catId]) !== JSON.stringify(outcome)) {
      throw new Error('queue custody target outcomes are append-only');
    }
  }
}

function assertBodyExposureMonotonicity(current: QueuedMessageCustody, next: QueuedMessageCustody): void {
  const nextByKey = new Map(
    (next.bodyExposures ?? []).map((exposure) => [`${exposure.targetCatId}\u0000${exposure.invocationId}`, exposure]),
  );
  for (const exposure of current.bodyExposures ?? []) {
    const key = `${exposure.targetCatId}\u0000${exposure.invocationId}`;
    if (JSON.stringify(nextByKey.get(key)) !== JSON.stringify(exposure)) {
      throw new Error('queue custody body exposures are append-only');
    }
  }
}

function assertAuthorIntentMonotonicity(current: QueuedMessageCustody, next: QueuedMessageCustody): void {
  for (const [catId, authorIntent] of Object.entries(current.authorIntentByCatId ?? {})) {
    const successor = next.authorIntentByCatId?.[catId];
    if (!successor) throw new Error('queue author intent is immutable once assigned');
    if (
      successor.requested !== authorIntent.requested ||
      successor.boundParentInvocationId !== authorIntent.boundParentInvocationId ||
      JSON.stringify(successor.carrierCapability) !== JSON.stringify(authorIntent.carrierCapability)
    ) {
      throw new Error('queue author intent request and parent fence are immutable');
    }
    if (
      authorIntent.fallbackAt !== undefined &&
      (successor.fallbackAt !== authorIntent.fallbackAt || successor.fallbackReason !== authorIntent.fallbackReason)
    ) {
      throw new Error('queue author intent fallback is append-only');
    }
  }
}

function assertWithdrawalMonotonicity(current: QueuedMessageCustody, next: QueuedMessageCustody): void {
  for (const catId of current.withdrawnByCatIds ?? []) {
    if (next.withdrawnByCatIds?.includes(catId)) {
      if (next.withdrawnAtByCatId?.[catId] !== current.withdrawnAtByCatId?.[catId]) {
        throw new Error('queue custody withdrawals are append-only');
      }
      continue;
    }
    const lateOutcome = next.targetOutcomeByCatId?.[catId];
    const exactExposure = lateOutcome
      ? current.bodyExposures?.some(
          (exposure) => exposure.targetCatId === catId && exposure.invocationId === lateOutcome.invocationId,
        )
      : false;
    const supersededByExactTerminalHandling =
      current.status === 'terminal' &&
      next.status === 'terminal' &&
      !current.handledByCatIds.includes(catId) &&
      next.handledByCatIds.includes(catId) &&
      current.targetOutcomeByCatId?.[catId] === undefined &&
      lateOutcome !== undefined &&
      exactExposure === true &&
      lateOutcome.handledAt > (current.withdrawnAtByCatId?.[catId] ?? Number.POSITIVE_INFINITY);
    if (!supersededByExactTerminalHandling) throw new Error('queue custody withdrawals are append-only');
  }
}

function assertActionSuccessorTerminalMonotonicity(current: QueuedMessageCustody, next: QueuedMessageCustody): void {
  for (const [catId, fence] of Object.entries(current.actionSuccessorTerminalFenceByTargetCatId ?? {})) {
    if (!actionSuccessorFencesMatch(next.actionSuccessorTerminalFenceByTargetCatId?.[catId], fence)) {
      throw new Error('queue custody action-successor terminal fences are append-only');
    }
  }
}

const REMINDER_NEXT_STATES: Readonly<
  Record<QueueReminderAttempt['state'], ReadonlySet<QueueReminderAttempt['state']>>
> = {
  requested: new Set(['requested', 'delivered', 'seen', 'missed']),
  delivered: new Set(['delivered', 'seen', 'missed']),
  seen: new Set(['seen']),
  missed: new Set(['missed']),
};

function sameReminderIdentity(left: QueueReminderAttempt, right: QueueReminderAttempt): boolean {
  return (
    left.id === right.id &&
    left.targetCatId === right.targetCatId &&
    left.invocationId === right.invocationId &&
    left.requestedAt === right.requestedAt
  );
}

function assertReminderAttemptMonotonicity(current: QueuedMessageCustody, next: QueuedMessageCustody): void {
  const nextById = new Map((next.reminderAttempts ?? []).map((attempt) => [attempt.id, attempt]));
  for (const attempt of current.reminderAttempts ?? []) {
    const successor = nextById.get(attempt.id);
    const preservesDeliveredAt = attempt.deliveredAt === undefined || successor?.deliveredAt === attempt.deliveredAt;
    const terminalUnchanged =
      (attempt.state !== 'seen' && attempt.state !== 'missed') || JSON.stringify(successor) === JSON.stringify(attempt);
    if (
      !successor ||
      !sameReminderIdentity(attempt, successor) ||
      !REMINDER_NEXT_STATES[attempt.state].has(successor.state) ||
      !preservesDeliveredAt ||
      !terminalUnchanged
    ) {
      throw new Error('queue custody reminder attempts are append-only and monotonic');
    }
  }
}

function assertTargetAttemptMonotonicity(current: QueuedMessageCustody, next: QueuedMessageCustody): void {
  const nextById = new Map((next.targetAttempts ?? []).map((attempt) => [attempt.id, attempt]));
  for (const attempt of current.targetAttempts ?? []) {
    const successor = nextById.get(attempt.id);
    if (
      !successor ||
      successor.targetCatId !== attempt.targetCatId ||
      successor.sequence !== attempt.sequence ||
      successor.createdAt !== attempt.createdAt ||
      !TARGET_ATTEMPT_NEXT_STATES[attempt.state].has(successor.state) ||
      (attempt.invocationId !== undefined && successor.invocationId !== attempt.invocationId) ||
      (attempt.seenAt !== undefined && successor.seenAt !== attempt.seenAt) ||
      (attempt.terminalReason !== undefined && successor.terminalReason !== attempt.terminalReason) ||
      successor.updatedAt < attempt.updatedAt
    ) {
      throw new Error('queue custody target attempts are append-only and monotonic');
    }
    if (
      ['failed', 'interrupted', 'cancelled', 'handled'].includes(attempt.state) &&
      JSON.stringify(successor) !== JSON.stringify(attempt)
    ) {
      throw new Error('terminal target attempts are immutable');
    }
  }
}

export function assertQueuedMessageCustody(custody: QueuedMessageCustody): void {
  assertCustodyIdentity(custody);
  assertCustodyTargets(custody);
  assertCustodyLifecycle(custody);
}

function normalizePreExposurePersistedCustody(custody: QueuedMessageCustody): QueuedMessageCustody {
  if (custody.bodyExposures !== undefined || Object.keys(custody.targetOutcomeByCatId ?? {}).length === 0) {
    return custody;
  }

  // Records written before child-exact exposure persistence can carry a valid
  // parent-level F264 outcome but have no bodyExposures field at all. Validate
  // every other invariant before degrading that unprovable evidence to generic
  // handled truth. New-format records remain strict and cannot use this path.
  assertCustodyIdentity(custody);
  assertCustodyTargets(custody, true);
  assertCustodyLifecycle(custody);
  const normalized = cloneQueuedMessageCustody(custody);
  delete normalized.targetOutcomeByCatId;
  return normalized;
}

export function assertQueueCustodyMessageBinding(message: {
  queueCustody?: QueuedMessageCustody;
  queueCustodyAdmission?: QueueCustodyAdmissionIntent;
  deliveryStatus?: 'queued' | 'delivered' | 'canceled';
}): void {
  if (message.queueCustodyAdmission) {
    assertQueueCustodyAdmissionIntent(message.queueCustodyAdmission);
    if (message.deliveryStatus !== 'queued') {
      throw new Error('queue custody admission can only be stored on a queued message');
    }
    if (message.queueCustody) throw new Error('queue custody admission and full custody are mutually exclusive');
  }
  if (!message.queueCustody) return;
  assertQueuedMessageCustody(message.queueCustody);
  if (message.deliveryStatus !== 'queued') {
    throw new Error('queue custody can only be stored on a queued message');
  }
}

export function assertQueueCustodyTransition(current: QueuedMessageCustody, input: QueueCustodyTransitionInput): void {
  assertQueuedMessageCustody(current);
  assertQueuedMessageCustody(input.next);
  if (input.next.entryId !== current.entryId) {
    const replacement = input.replacement;
    if (
      replacement?.kind !== 'verified' ||
      replacement.previousEntryId !== current.entryId ||
      replacement.replacementEntryId !== input.next.entryId ||
      replacement.previousEntryId === replacement.replacementEntryId
    ) {
      throw new Error('queue custody entryId requires exact verified replacement proof');
    }
    if (current.status === 'terminal' || input.next.status !== 'queued') {
      throw new Error('queue custody replacement requires active custody and a queued successor');
    }
    if (current.carrierByTargetCatId || input.next.carrierByTargetCatId) {
      throw new Error('per-target Queue carrier replacement must settle through its immutable target binding');
    }
  } else if (input.replacement) {
    throw new Error('queue custody replacement proof cannot be used without changing entryId');
  }
  if (input.next.ownerAuthProvenance !== current.ownerAuthProvenance) {
    throw new Error('queue custody ownerAuthProvenance is immutable');
  }
  if (input.next.ownerUserId !== current.ownerUserId) {
    throw new Error('queue custody ownerUserId is immutable');
  }
  if (input.next.version !== current.version) throw new Error('queue custody version is immutable');
  if (input.next.createdAt !== current.createdAt) throw new Error('queue custody createdAt is immutable');
  if (input.next.intent !== current.intent) throw new Error('queue custody intent is immutable');
  if (current.receiptScope !== undefined && input.next.receiptScope !== current.receiptScope) {
    throw new Error('queue custody receipt scope is immutable once assigned');
  }
  if (JSON.stringify(input.next.allTargetCats) !== JSON.stringify(current.allTargetCats)) {
    throw new Error('queue custody allTargetCats is immutable');
  }
  if (JSON.stringify(input.next.carrierByTargetCatId) !== JSON.stringify(current.carrierByTargetCatId)) {
    if (!input.actionSuccessorRebind) {
      throw new Error('queue custody per-target carrier bindings are immutable');
    }
    assertActionSuccessorCarrierRebind(current, input.next, input.actionSuccessorRebind);
  } else if (input.actionSuccessorRebind) {
    throw new Error('action-successor Queue carrier rebind must change durable carrier authority');
  }
  if (
    current.prestartRetirement !== undefined &&
    JSON.stringify(input.next.prestartRetirement) !== JSON.stringify(current.prestartRetirement)
  ) {
    throw new Error('queue custody pre-start retirement identity is immutable once assigned');
  }
  assertTargetOutcomeMonotonicity(current, input.next);
  assertBodyExposureMonotonicity(current, input.next);
  assertAuthorIntentMonotonicity(current, input.next);
  assertWithdrawalMonotonicity(current, input.next);
  assertActionSuccessorTerminalMonotonicity(current, input.next);
  assertReminderAttemptMonotonicity(current, input.next);
  assertTargetAttemptMonotonicity(current, input.next);
  if (input.next.revision !== current.revision + 1) {
    throw new Error('queue custody next revision must increment by one');
  }
  if (input.deliveredAt !== undefined && input.next.status !== 'terminal') {
    throw new Error('delivery transition requires terminal custody');
  }
  if (input.next.status === 'terminal' && input.deliveredAt === undefined) {
    const withdrawn = new Set<string>(input.next.withdrawnByCatIds ?? []);
    const handled = new Set<string>(input.next.handledByCatIds);
    const allTargetsSettled = input.next.allTargetCats.every((catId) => withdrawn.has(catId) || handled.has(catId));
    const exactLateHandled = input.next.handledByCatIds.filter(
      (catId) =>
        !current.handledByCatIds.includes(catId) &&
        current.withdrawnByCatIds?.includes(catId) &&
        input.next.targetOutcomeByCatId?.[catId] !== undefined,
    );
    if ((withdrawn.size === 0 && exactLateHandled.length === 0) || !allTargetsSettled) {
      throw new Error('terminal custody without delivery requires exact author-withdrawal settlement');
    }
  }
  if (input.deliveredAt !== undefined) assertFiniteNonNegative(input.deliveredAt, 'deliveredAt');
}

export function cloneQueuedMessageCustody(custody: QueuedMessageCustody): QueuedMessageCustody {
  return {
    ...custody,
    allTargetCats: [...custody.allTargetCats],
    pendingTargetCats: [...custody.pendingTargetCats],
    notifiedByCatIds: [...custody.notifiedByCatIds],
    ...(custody.awakenedInvocationIdByCatId
      ? { awakenedInvocationIdByCatId: { ...custody.awakenedInvocationIdByCatId } }
      : {}),
    ...(custody.awakenedAtByCatId ? { awakenedAtByCatId: { ...custody.awakenedAtByCatId } } : {}),
    seenByCatIds: [...custody.seenByCatIds],
    seenInvocationIdByCatId: { ...custody.seenInvocationIdByCatId },
    ...(custody.bodyExposures ? { bodyExposures: custody.bodyExposures.map((exposure) => ({ ...exposure })) } : {}),
    ...(custody.targetAttempts ? { targetAttempts: custody.targetAttempts.map((attempt) => ({ ...attempt })) } : {}),
    ...(custody.carrierByTargetCatId ? { carrierByTargetCatId: structuredClone(custody.carrierByTargetCatId) } : {}),
    ...(custody.carrierStateByTargetCatId
      ? { carrierStateByTargetCatId: structuredClone(custody.carrierStateByTargetCatId) }
      : {}),
    ...(custody.authorIntentByCatId ? { authorIntentByCatId: structuredClone(custody.authorIntentByCatId) } : {}),
    failedByCatIds: [...custody.failedByCatIds],
    ...(custody.withdrawnByCatIds ? { withdrawnByCatIds: [...custody.withdrawnByCatIds] } : {}),
    ...(custody.withdrawnAtByCatId ? { withdrawnAtByCatId: { ...custody.withdrawnAtByCatId } } : {}),
    ...(custody.actionSuccessorTerminalFenceByTargetCatId
      ? {
          actionSuccessorTerminalFenceByTargetCatId: structuredClone(custody.actionSuccessorTerminalFenceByTargetCatId),
        }
      : {}),
    handledByCatIds: [...custody.handledByCatIds],
    ...(custody.targetOutcomeByCatId ? { targetOutcomeByCatId: structuredClone(custody.targetOutcomeByCatId) } : {}),
    ...(custody.steeredInvocationIdByCatId
      ? { steeredInvocationIdByCatId: { ...custody.steeredInvocationIdByCatId } }
      : {}),
    ...(custody.steerRequestedByCatIds ? { steerRequestedByCatIds: [...custody.steerRequestedByCatIds] } : {}),
    ...(custody.prestartRetirement
      ? {
          prestartRetirement: {
            ...custody.prestartRetirement,
            entryIds: [...custody.prestartRetirement.entryIds],
          },
        }
      : {}),
    ...(custody.reminderAttempts
      ? { reminderAttempts: custody.reminderAttempts.map((attempt) => ({ ...attempt })) }
      : {}),
  };
}

interface QueueCustodyWithdrawalOptions {
  /** Recall must advance the custody revision even when every target was already settled. */
  forceRevision?: boolean;
  /** Persist the exact business-terminal proof for matching action carriers. */
  actionSuccessorTerminalFence?: ActionSuccessorFence;
}

function withoutSelectedEntries<T>(
  current: Readonly<Record<string, T>> | undefined,
  selected: ReadonlySet<string>,
): Record<string, T> {
  const next = { ...(current ?? {}) };
  for (const catId of selected) delete next[catId];
  return next;
}

function includesSelected(values: readonly string[] | undefined, selected: ReadonlySet<string>): boolean {
  return (values ?? []).some((catId) => selected.has(catId));
}

function hasSelectedEntry<T>(current: Readonly<Record<string, T>> | undefined, selected: ReadonlySet<string>): boolean {
  return Object.keys(current ?? {}).some((catId) => selected.has(catId));
}

function settleSelectedReminderAttempts(
  current: readonly QueueReminderAttempt[] | undefined,
  selected: ReadonlySet<string>,
  withdrawnAt: number,
): { attempts: QueueReminderAttempt[]; changed: boolean } {
  let changed = false;
  const attempts = (current ?? []).map((attempt) => {
    const active = attempt.state === 'requested' || attempt.state === 'delivered';
    if (!selected.has(attempt.targetCatId) || !active) return attempt;
    changed = true;
    return {
      ...attempt,
      state: 'missed' as const,
      missedAt: withdrawnAt,
      missedReason: 'source_withdrawn' as const,
    };
  });
  return { attempts, changed };
}

function settleSelectedTargetAttempts(
  current: readonly QueueTargetAttempt[] | undefined,
  selected: ReadonlySet<string>,
  withdrawnAt: number,
): { attempts: QueueTargetAttempt[]; changed: boolean } {
  const latestSequenceByTarget = new Map<string, number>();
  for (const attempt of current ?? []) {
    latestSequenceByTarget.set(
      attempt.targetCatId,
      Math.max(latestSequenceByTarget.get(attempt.targetCatId) ?? 0, attempt.sequence),
    );
  }

  let changed = false;
  const attempts = (current ?? []).map((attempt) => {
    const isLatest = latestSequenceByTarget.get(attempt.targetCatId) === attempt.sequence;
    const isActive = attempt.state === 'queued' || attempt.state === 'starting' || attempt.state === 'appended';
    if (!selected.has(attempt.targetCatId) || !isLatest || !isActive) return attempt;
    changed = true;
    return {
      ...attempt,
      state: 'cancelled' as const,
      terminalReason: 'source_withdrawn' as const,
      updatedAt: Math.max(attempt.updatedAt, withdrawnAt),
    };
  });
  return { attempts, changed };
}

/**
 * Single source of truth for author-withdrawal terminalization. Queue withdraw
 * and true recall both use this projection so newly-added active fields cannot
 * remain live in one path while being settled in the other.
 */
export function settleQueueCustodyWithdrawal(
  current: QueuedMessageCustody,
  selectedTargetCats: readonly string[],
  withdrawnAt: number,
  options: QueueCustodyWithdrawalOptions = {},
): QueuedMessageCustody {
  assertFiniteNonNegative(withdrawnAt, 'withdrawnAt');
  const selected = new Set(selectedTargetCats);
  const withdrawnNow = current.pendingTargetCats.filter((catId) => selected.has(catId));
  const pendingTargetCats = current.pendingTargetCats.filter((catId) => !selected.has(catId));
  const withdrawnByCatIds = [...new Set([...(current.withdrawnByCatIds ?? []), ...withdrawnNow])] as CatId[];
  const withdrawnAtByCatId = { ...(current.withdrawnAtByCatId ?? {}) };
  for (const catId of withdrawnNow) {
    withdrawnAtByCatId[catId] ??= withdrawnAt;
  }
  const actionSuccessorTerminalFenceByTargetCatId = structuredClone(
    current.actionSuccessorTerminalFenceByTargetCatId ?? {},
  );
  let actionSuccessorTerminalChanged = false;
  if (options.actionSuccessorTerminalFence) {
    for (const catId of selected) {
      if (!withdrawnNow.includes(catId as CatId) && !current.withdrawnByCatIds?.includes(catId as CatId)) continue;
      const carrierFence = current.carrierByTargetCatId?.[catId]?.actionSuccessorFence;
      if (!actionSuccessorFencesMatch(carrierFence, options.actionSuccessorTerminalFence)) continue;
      if (!actionSuccessorTerminalFenceByTargetCatId[catId]) {
        actionSuccessorTerminalFenceByTargetCatId[catId] = { ...options.actionSuccessorTerminalFence };
        actionSuccessorTerminalChanged = true;
      }
    }
  }
  const awakenedInvocationIdByCatId = withoutSelectedEntries(current.awakenedInvocationIdByCatId, selected);
  const awakenedAtByCatId = withoutSelectedEntries(current.awakenedAtByCatId, selected);
  const steeredInvocationIdByCatId = withoutSelectedEntries(current.steeredInvocationIdByCatId, selected);
  const carrierStateByTargetCatId = withoutSelectedEntries(current.carrierStateByTargetCatId, selected);
  const reminderSettlement = settleSelectedReminderAttempts(current.reminderAttempts, selected, withdrawnAt);
  const targetAttemptSettlement = settleSelectedTargetAttempts(current.targetAttempts, selected, withdrawnAt);
  const activeStateChanged =
    withdrawnNow.length > 0 ||
    reminderSettlement.changed ||
    targetAttemptSettlement.changed ||
    includesSelected(current.notifiedByCatIds, selected) ||
    includesSelected(current.failedByCatIds, selected) ||
    hasSelectedEntry(current.awakenedInvocationIdByCatId, selected) ||
    hasSelectedEntry(current.steeredInvocationIdByCatId, selected) ||
    hasSelectedEntry(current.carrierStateByTargetCatId, selected) ||
    includesSelected(current.steerRequestedByCatIds, selected) ||
    actionSuccessorTerminalChanged;
  if (!activeStateChanged && !options.forceRevision) return current;

  const {
    processingStartedAt: _processingStartedAt,
    awakenedInvocationIdByCatId: _awakenedInvocationIdByCatId,
    awakenedAtByCatId: _awakenedAtByCatId,
    steerRequestedByCatIds: _steerRequestedByCatIds,
    steeredInvocationIdByCatId: _steeredInvocationIdByCatId,
    carrierStateByTargetCatId: _carrierStateByTargetCatId,
    withdrawnByCatIds: _withdrawnByCatIds,
    withdrawnAtByCatId: _withdrawnAtByCatId,
    actionSuccessorTerminalFenceByTargetCatId: _actionSuccessorTerminalFenceByTargetCatId,
    reminderAttempts: _reminderAttempts,
    targetAttempts: _targetAttempts,
    ...stableCurrent
  } = current;
  const next: QueuedMessageCustody = {
    ...stableCurrent,
    revision: current.revision + 1,
    status: pendingTargetCats.length === 0 ? 'terminal' : 'queued',
    pendingTargetCats,
    notifiedByCatIds: current.notifiedByCatIds.filter((catId) => !selected.has(catId)),
    ...(Object.keys(awakenedInvocationIdByCatId).length > 0 ? { awakenedInvocationIdByCatId } : {}),
    ...(Object.keys(awakenedAtByCatId).length > 0 ? { awakenedAtByCatId } : {}),
    failedByCatIds: current.failedByCatIds.filter((catId) => !selected.has(catId)),
    withdrawnByCatIds,
    withdrawnAtByCatId,
    ...(Object.keys(actionSuccessorTerminalFenceByTargetCatId).length > 0
      ? { actionSuccessorTerminalFenceByTargetCatId }
      : {}),
    ...(Object.keys(carrierStateByTargetCatId).length > 0 ? { carrierStateByTargetCatId } : {}),
    ...((current.steerRequestedByCatIds ?? []).some((catId) => !selected.has(catId))
      ? { steerRequestedByCatIds: (current.steerRequestedByCatIds ?? []).filter((catId) => !selected.has(catId)) }
      : {}),
    ...(Object.keys(steeredInvocationIdByCatId).length > 0 ? { steeredInvocationIdByCatId } : {}),
    ...(reminderSettlement.attempts.length > 0 ? { reminderAttempts: reminderSettlement.attempts } : {}),
    ...(targetAttemptSettlement.attempts.length > 0 ? { targetAttempts: targetAttemptSettlement.attempts } : {}),
    updatedAt: withdrawnAt,
  };
  return next;
}

/** True recall withdraws every target that was not already durably handled. */
export function terminalizeRecalledQueueCustody(
  current: QueuedMessageCustody,
  recalledAt: number,
): QueuedMessageCustody {
  return settleQueueCustodyWithdrawal(current, current.allTargetCats, recalledAt, { forceRevision: true });
}

export class QueueCustodyParseError extends Error {
  readonly code = 'INVALID_QUEUE_CUSTODY';
}

export function parseQueuedMessageCustody(raw: string | undefined): QueuedMessageCustody | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('queue custody must be an object');
    const custody = normalizePreExposurePersistedCustody(parsed as QueuedMessageCustody);
    assertQueuedMessageCustody(custody);
    return cloneQueuedMessageCustody(custody);
  } catch (error) {
    throw new QueueCustodyParseError(
      `invalid persisted queue custody: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
