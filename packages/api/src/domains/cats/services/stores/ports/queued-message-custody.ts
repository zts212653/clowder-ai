import type { CatId, QueueAuthorIntent, QueueReminderAttempt, QueueTargetOutcome } from '@cat-cafe/shared';
import { normalizeOwnerAuthProvenance, type OwnerAuthProvenance } from '../../owner-auth-provenance.js';

export type QueuedMessageCustodyStatus = 'queued' | 'processing' | 'terminal';

export interface QueueBodyExposure {
  targetCatId: string;
  invocationId: string;
  seenAt: number;
}

export interface QueueTargetCarrierBinding {
  entryId: string;
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

export interface QueuedMessageCustody {
  version: 1;
  entryId: string;
  revision: number;
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
  /** Mutable per-carrier runtime state; target-local writes must preserve siblings. */
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
  failedByCatIds: CatId[];
  /** Author-cleared targets: terminal for Queue actionability, preserved in owner history. */
  withdrawnByCatIds?: CatId[];
  withdrawnAtByCatId?: Record<string, number>;
  handledByCatIds: CatId[];
  /** F264: exact successful invocation evidence; absent on legacy handled custody. */
  targetOutcomeByCatId?: Record<string, QueueTargetOutcome>;
  /** F264: exact Steer replacement fence while the selected message is running. */
  steeredInvocationIdByCatId?: Record<string, string>;
  /** F264: Steer was accepted but the replacement invocation has not bound its id yet. */
  steerRequestedByCatIds?: CatId[];
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

function assertCustodyIdentity(custody: QueuedMessageCustody): void {
  if (custody.version !== 1) throw new Error('queue custody version must be 1');
  if (!custody.entryId) throw new Error('queue custody entryId is required');
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
    for (const binding of Object.values(carriers)) {
      if (
        !binding.entryId ||
        binding.source !== 'agent' ||
        binding.sourceCategory !== 'a2a' ||
        !binding.a2aTriggerMessageId ||
        binding.autoExecute !== true
      ) {
        throw new Error('invalid cross-thread Queue carrier binding');
      }
      assertFiniteNonNegative(binding.createdAt, 'carrier.createdAt');
    }
  }
  if (custody.carrierStateByTargetCatId) {
    for (const [catId, state] of Object.entries(custody.carrierStateByTargetCatId)) {
      if (!carriers?.[catId]) throw new Error('queue custody carrier state requires an immutable carrier binding');
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
      outcome.evidenceRef?.kind !== 'invocation_lineage' ||
      outcome.evidenceRef.invocationId !== outcome.invocationId
    ) {
      throw new Error('target outcome must carry matching invocation lineage evidence');
    }
    if (outcome.disposition !== 'responded' && outcome.disposition !== 'completed_with_turn') {
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
  assertTargetSubsets(custody, allTargets);
  assertBodyExposures(custody, allTargets);
  assertInvocationBindings(custody, allTargets);
  assertTargetOutcomes(custody, allTargets, allowLegacyMissingExposure);
  assertReminderAttempts(custody, allTargets);
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
    if (
      !next.withdrawnByCatIds?.includes(catId) ||
      next.withdrawnAtByCatId?.[catId] !== current.withdrawnAtByCatId?.[catId]
    ) {
      throw new Error('queue custody withdrawals are append-only');
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
  deliveryStatus?: 'queued' | 'delivered' | 'canceled';
}): void {
  if (!message.queueCustody) return;
  assertQueuedMessageCustody(message.queueCustody);
  if (message.deliveryStatus !== 'queued') {
    throw new Error('queue custody can only be stored on a queued message');
  }
}

export function assertQueueCustodyTransition(current: QueuedMessageCustody, input: QueueCustodyTransitionInput): void {
  assertQueuedMessageCustody(current);
  assertQueuedMessageCustody(input.next);
  if (input.next.entryId !== current.entryId) throw new Error('queue custody entryId is immutable');
  if (input.next.ownerAuthProvenance !== current.ownerAuthProvenance) {
    throw new Error('queue custody ownerAuthProvenance is immutable');
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
    throw new Error('queue custody per-target carrier bindings are immutable');
  }
  assertTargetOutcomeMonotonicity(current, input.next);
  assertBodyExposureMonotonicity(current, input.next);
  assertAuthorIntentMonotonicity(current, input.next);
  assertWithdrawalMonotonicity(current, input.next);
  assertReminderAttemptMonotonicity(current, input.next);
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
    if (withdrawn.size === 0 || !allTargetsSettled) {
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
    ...(custody.carrierByTargetCatId ? { carrierByTargetCatId: structuredClone(custody.carrierByTargetCatId) } : {}),
    ...(custody.carrierStateByTargetCatId
      ? { carrierStateByTargetCatId: structuredClone(custody.carrierStateByTargetCatId) }
      : {}),
    ...(custody.authorIntentByCatId ? { authorIntentByCatId: structuredClone(custody.authorIntentByCatId) } : {}),
    failedByCatIds: [...custody.failedByCatIds],
    ...(custody.withdrawnByCatIds ? { withdrawnByCatIds: [...custody.withdrawnByCatIds] } : {}),
    ...(custody.withdrawnAtByCatId ? { withdrawnAtByCatId: { ...custody.withdrawnAtByCatId } } : {}),
    handledByCatIds: [...custody.handledByCatIds],
    ...(custody.targetOutcomeByCatId ? { targetOutcomeByCatId: structuredClone(custody.targetOutcomeByCatId) } : {}),
    ...(custody.steeredInvocationIdByCatId
      ? { steeredInvocationIdByCatId: { ...custody.steeredInvocationIdByCatId } }
      : {}),
    ...(custody.steerRequestedByCatIds ? { steerRequestedByCatIds: [...custody.steerRequestedByCatIds] } : {}),
    ...(custody.reminderAttempts
      ? { reminderAttempts: custody.reminderAttempts.map((attempt) => ({ ...attempt })) }
      : {}),
  };
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
