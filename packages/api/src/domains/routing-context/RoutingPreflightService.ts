import {
  type RoutingContextSnapshotV1,
  type RoutingPreflightDecisionV1,
  type RoutingReasonV1,
  routingPreflightDecisionV1Schema,
} from '@cat-cafe/shared';
import type {
  ResolveRoutingContextInput,
  RoutingContextResolution,
  RoutingContextResolver,
} from './RoutingContextResolver.js';
import {
  RoutingPreflightObserver,
  type RoutingPreflightTelemetryEvent,
  type RoutingPreflightTelemetrySink,
} from './RoutingPreflightTelemetry.js';

export interface RoutingPreflightInput extends ResolveRoutingContextInput {
  targetCatIds: readonly string[];
}

export interface RoutingPreflightAuditEvent {
  ownerId: string;
  failureClass: string;
  observedAt: number;
}

export interface RoutingPreflightAuditSink {
  record(event: RoutingPreflightAuditEvent): void | Promise<void>;
}

export interface RoutingPreflightClock {
  now(): number;
}

export interface RoutingPreflightServiceOptions {
  resolver: Pick<RoutingContextResolver, 'resolve'>;
  auditSink?: RoutingPreflightAuditSink;
  clock?: RoutingPreflightClock;
  readBudgetMs?: number;
  failureThreshold?: number;
  openIntervalMs?: number;
  auditDedupeMs?: number;
  telemetry?: RoutingPreflightTelemetrySink;
  processInstanceId?: string;
  restartEpoch?: number;
}

type CircuitState =
  | { kind: 'closed'; consecutiveFailures: number; epoch: number }
  | { kind: 'open'; openUntil: number; epoch: number }
  | { kind: 'half_open'; epoch: number };

type ResolverAttempt = { kind: 'closed' | 'half_open'; epoch: number };

class ResolverBudgetTimeoutError extends Error {
  constructor() {
    super('routing context resolution exceeded its read budget');
    this.name = 'ResolverBudgetTimeoutError';
  }
}

const NULL_AUDIT_SINK: RoutingPreflightAuditSink = { record: () => undefined };
const SYSTEM_CLOCK: RoutingPreflightClock = { now: () => Date.now() };

function reasonRefsForAlternative(snapshot: RoutingContextSnapshotV1, catId: string): string[] {
  const candidate = snapshot.candidates.find((entry) => entry.binding.catId === catId);
  const refs = [
    snapshot.catalogRevision,
    ...(candidate?.profile.state === 'applied' ? [candidate.profile.revision.dossierRevision] : []),
    ...(candidate?.reasons.flatMap((reason) => reason.sourceRefs) ?? []),
  ];
  return [...new Set(refs)].slice(0, 16);
}

function alternativesFor(snapshot: RoutingContextSnapshotV1, targetCatId: string) {
  return snapshot.candidates
    .filter(
      (candidate) =>
        candidate.binding.catId !== targetCatId &&
        candidate.effect === 'eligible' &&
        candidate.profile.state === 'applied',
    )
    .map((candidate) => ({
      catId: candidate.binding.catId,
      reasonRefs: reasonRefsForAlternative(snapshot, candidate.binding.catId),
    }));
}

function unavailableReason(failureClass: string): RoutingReasonV1 {
  return {
    code: 'routing_context_unavailable',
    summary: 'Routing context is temporarily unavailable; the requested target remains unchanged',
    sourceRefs: [`routing-context:${failureClass}`],
  };
}

export class RoutingPreflightService {
  private readonly resolver: Pick<RoutingContextResolver, 'resolve'>;
  private readonly auditSink: RoutingPreflightAuditSink;
  private readonly clock: RoutingPreflightClock;
  private readonly readBudgetMs: number;
  private readonly failureThreshold: number;
  private readonly openIntervalMs: number;
  private readonly auditDedupeMs: number;
  private readonly observer: RoutingPreflightObserver;
  private readonly lastAuditAt = new Map<string, number>();
  private circuit: CircuitState = { kind: 'closed', consecutiveFailures: 0, epoch: 0 };

  constructor(options: RoutingPreflightServiceOptions) {
    this.resolver = options.resolver;
    this.auditSink = options.auditSink ?? NULL_AUDIT_SINK;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.readBudgetMs = options.readBudgetMs ?? 120;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.openIntervalMs = options.openIntervalMs ?? 30_000;
    this.auditDedupeMs = options.auditDedupeMs ?? 30_000;
    this.observer = new RoutingPreflightObserver({
      clock: this.clock,
      ...(options.telemetry ? { sink: options.telemetry } : {}),
      ...(options.processInstanceId ? { processInstanceId: options.processInstanceId } : {}),
      ...(options.restartEpoch !== undefined ? { restartEpoch: options.restartEpoch } : {}),
    });
    if (this.readBudgetMs <= 0 || this.failureThreshold <= 0 || this.openIntervalMs <= 0 || this.auditDedupeMs <= 0) {
      throw new Error('routing preflight circuit settings must be positive');
    }
  }

  async preflight(input: RoutingPreflightInput): Promise<RoutingPreflightDecisionV1> {
    const startedAt = performance.now();
    const attempt = this.acquireAttempt(input);
    if (attempt === null) {
      const failureClass = this.circuit.kind === 'half_open' ? 'half_open_busy' : 'circuit_open';
      this.observer.attempt('suppressed', failureClass, performance.now() - startedAt);
      return this.degradedDecision(input, failureClass);
    }

    let resolution: RoutingContextResolution;
    try {
      resolution = await this.resolveWithinBudget(input);
    } catch (error: unknown) {
      const failureClass = error instanceof ResolverBudgetTimeoutError ? 'resolver_timeout' : 'resolver_error';
      this.recordFailure(attempt);
      this.observer.attempt(attempt.kind, failureClass, performance.now() - startedAt);
      return this.degradedDecision(input, failureClass);
    }

    if (resolution.status === 'degraded') {
      const failureClass = `resolver_degraded:${resolution.reason}`;
      this.recordDegraded(attempt);
      this.observer.attempt(attempt.kind, 'resolver_degraded', performance.now() - startedAt);
      return this.degradedDecision(input, failureClass);
    }

    this.recordFresh(attempt);
    this.observer.attempt(attempt.kind, 'fresh', performance.now() - startedAt);
    return this.freshDecision(input, resolution);
  }

  private acquireAttempt(input: RoutingPreflightInput): ResolverAttempt | null {
    if (this.circuit.kind === 'closed') return { kind: 'closed', epoch: this.circuit.epoch };
    if (this.circuit.kind === 'half_open') {
      this.audit(input.ownerId, 'half_open_busy');
      return null;
    }
    if (this.clock.now() < this.circuit.openUntil) {
      this.audit(input.ownerId, 'circuit_open');
      return null;
    }
    const epoch = this.circuit.epoch;
    this.transition({ kind: 'half_open', epoch }, 'probe_interval_elapsed');
    return { kind: 'half_open', epoch };
  }

  private async resolveWithinBudget(input: RoutingPreflightInput): Promise<RoutingContextResolution> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const budgetExpired = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new ResolverBudgetTimeoutError()), this.readBudgetMs);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() =>
          this.resolver.resolve({
            ownerId: input.ownerId,
            observedAt: input.observedAt,
            catalogRevision: input.catalogRevision,
            intent: input.intent,
            candidates: input.candidates,
          }),
        ),
        budgetExpired,
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private recordFresh(attempt: ResolverAttempt): void {
    if (attempt.kind === 'closed') {
      if (this.circuit.kind === 'closed' && this.circuit.epoch === attempt.epoch) {
        this.circuit = { ...this.circuit, consecutiveFailures: 0 };
      }
      return;
    }
    if (this.circuit.kind === 'half_open' && this.circuit.epoch === attempt.epoch) {
      this.transition({ kind: 'closed', consecutiveFailures: 0, epoch: attempt.epoch + 1 }, 'fresh_probe');
    }
  }

  private recordDegraded(attempt: ResolverAttempt): void {
    if (attempt.kind === 'closed') {
      this.recordFresh(attempt);
      return;
    }
    if (this.circuit.kind === 'half_open' && this.circuit.epoch === attempt.epoch) {
      this.transition(
        { kind: 'open', openUntil: this.clock.now() + this.openIntervalMs, epoch: attempt.epoch + 1 },
        'probe_failed',
      );
    }
  }

  private recordFailure(attempt: ResolverAttempt): void {
    if (attempt.kind === 'half_open') {
      if (this.circuit.kind === 'half_open' && this.circuit.epoch === attempt.epoch) {
        this.transition(
          {
            kind: 'open',
            openUntil: this.clock.now() + this.openIntervalMs,
            epoch: attempt.epoch + 1,
          },
          'probe_failed',
        );
      }
      return;
    }
    if (this.circuit.kind !== 'closed' || this.circuit.epoch !== attempt.epoch) return;
    const failures = this.circuit.consecutiveFailures + 1;
    if (failures >= this.failureThreshold) {
      this.transition(
        { kind: 'open', openUntil: this.clock.now() + this.openIntervalMs, epoch: attempt.epoch + 1 },
        'failure_threshold',
      );
    } else {
      this.circuit = { ...this.circuit, consecutiveFailures: failures };
    }
  }

  private freshDecision(
    input: RoutingPreflightInput,
    resolution: Extract<RoutingContextResolution, { status: 'fresh' }>,
  ): RoutingPreflightDecisionV1 {
    const targets = input.targetCatIds.map((targetCatId) => {
      const candidate = resolution.snapshot.candidates.find((entry) => entry.binding.catId === targetCatId);
      if (candidate === undefined) {
        return {
          targetCatId,
          disposition: 'warned' as const,
          reasons: [
            {
              code: 'routing_target_not_in_catalog',
              summary: 'The requested target has no binding in the resolved runtime catalog',
              sourceRefs: [resolution.snapshot.catalogRevision],
            },
          ],
          alternatives: alternativesFor(resolution.snapshot, targetCatId),
        };
      }
      const disposition =
        candidate.availability === 'unavailable'
          ? ('rejected' as const)
          : candidate.availability === 'available'
            ? ('allowed' as const)
            : ('warned' as const);
      return {
        targetCatId,
        disposition,
        reasons: candidate.reasons,
        alternatives: disposition === 'allowed' ? [] : alternativesFor(resolution.snapshot, targetCatId),
      };
    });
    return routingPreflightDecisionV1Schema.parse({
      v: 1,
      ownerId: input.ownerId,
      observedAt: input.observedAt,
      resolverState: 'fresh',
      snapshotRef: resolution.inputRevisionRef,
      targets,
    });
  }

  private degradedDecision(input: RoutingPreflightInput, failureClass: string): RoutingPreflightDecisionV1 {
    this.audit(input.ownerId, failureClass);
    const reason = unavailableReason(failureClass);
    return routingPreflightDecisionV1Schema.parse({
      v: 1,
      ownerId: input.ownerId,
      observedAt: input.observedAt,
      resolverState: 'degraded',
      targets: input.targetCatIds.map((targetCatId) => ({
        targetCatId,
        disposition: 'warned',
        reasons: [reason],
        alternatives: [],
      })),
    });
  }

  private audit(ownerId: string, failureClass: string): void {
    const now = this.clock.now();
    const key = `${ownerId}\u0000${failureClass}`;
    const previous = this.lastAuditAt.get(key);
    if (previous !== undefined && now - previous < this.auditDedupeMs) {
      this.observer.audit('dedupe_suppressed', failureClass);
      return;
    }
    this.lastAuditAt.set(key, now);
    this.observer.audit('emitted', failureClass);
    try {
      void Promise.resolve(this.auditSink.record({ ownerId, failureClass, observedAt: now })).catch(() => undefined);
    } catch {
      // An operational audit sink must never become a dispatch gate.
    }
  }

  private transition(
    next: CircuitState,
    reason: Extract<RoutingPreflightTelemetryEvent, { kind: 'circuit_transition' }>['reason'],
  ): void {
    const from = this.circuit.kind;
    this.circuit = next;
    if (from === next.kind) return;
    this.observer.transition(from, next.kind, reason);
  }
}
