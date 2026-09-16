import type {
  PawFeelApprovalContinuationV1,
  PawFeelCaptureAssessment,
  PawFeelCaptureMethod,
  PawFeelDispositionEvent,
  PawFeelDispositionProjection,
} from '@cat-cafe/shared';
import type { CanonicalPawFeelCandidate } from '../friction/paw-feel-source.js';
import {
  type PawFeelBlockerReopenCommand,
  planPawFeelConditionBlockerReopen,
  preparePawFeelBlockerReopen,
  projectPawFeelBlockerReopen,
} from './blocker-recovery/service-blocker-reopen.js';
import type { PawFeelFixResolver } from './command-context.js';
import { PawFeelDispositionCommandSchema, pawFeelCommandToEvent } from './commands.js';
import type {
  IPawFeelDispositionEventLog,
  PawFeelDispositionAppendResult,
  PawFeelSignalScanCursorV1,
  PawFeelSignalScanPage,
} from './event-log.js';
import { projectPawFeelDisposition } from './projector.js';
import {
  isLegacyWrite,
  PawFeelDispositionServiceError,
  type PawFeelDispositionServiceErrorCode,
  parseCommand,
  parsePrincipal,
  requireMatchingEvent,
  sameDiscoveryIdentity,
} from './service-guards.js';
import {
  type PawFeelBundleMembershipResolver,
  preparePawFeelBundleCommands,
} from './service-internals/service-bundle.js';
import {
  type PawFeelCommandEvidenceOptions,
  resolvePawFeelWriteContext,
} from './service-internals/service-command-resolution.js';

export type { PawFeelBlockerReopenCommand } from './blocker-recovery/service-blocker-reopen.js';
export type { PawFeelFixResolver } from './command-context.js';
export { PawFeelDispositionServiceError, type PawFeelDispositionServiceErrorCode } from './service-guards.js';
export type { PawFeelBundleMembershipResolver } from './service-internals/service-bundle.js';

export type PawFeelDispositionCommandResult =
  | { outcome: 'appended' | 'duplicate'; projection: PawFeelDispositionProjection }
  | {
      outcome: 'continuation';
      projection: PawFeelDispositionProjection;
      continuation: PawFeelApprovalContinuationV1;
    }
  | Extract<PawFeelDispositionAppendResult, { outcome: 'conflict' }>;

export type PawFeelBulkCommandResult =
  | PawFeelDispositionCommandResult
  | {
      outcome: 'rejected';
      signalId: string;
      eventId: string;
      error: { code: PawFeelDispositionServiceErrorCode; message: string };
    };

export interface PawFeelBundleCommandResult {
  bundleKey: string;
  results: PawFeelBulkCommandResult[];
  counts: Record<'appended' | 'duplicate' | 'conflict' | 'rejected', number> & { continuation?: number };
}

export interface PawFeelDispositionServiceOptions extends PawFeelCommandEvidenceOptions {
  eventLog: IPawFeelDispositionEventLog;
  /** @deprecated Read models still consume this active-custody reader; writes require directRepairResolver. */
  fixResolver?: PawFeelFixResolver;
  bundleMembershipResolver?: PawFeelBundleMembershipResolver;
  now?: () => string;
}

export interface PawFeelExecutionOptions {
  ownerCatId?: string;
}

export type PawFeelBlockerReconciliationOutcome = 'ignored' | 'stable' | 'reopened' | 'conflicted' | 'deferred';

export class PawFeelDispositionService {
  private readonly now: () => string;

  constructor(private readonly options: PawFeelDispositionServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async listSignalIds(): Promise<string[]> {
    return this.options.eventLog.listSignalIds();
  }

  async scanSignalIds(cursor: PawFeelSignalScanCursorV1 | undefined, limit: number): Promise<PawFeelSignalScanPage> {
    return this.options.eventLog.scanSignalIds(cursor, limit);
  }

  async readSignalEvents(signalId: string): Promise<PawFeelDispositionEvent[]> {
    return this.options.eventLog.read(signalId);
  }

  async reconcileBlocker(signalId: string, mayWrite = true): Promise<PawFeelBlockerReconciliationOutcome> {
    const currentEvents = await this.options.eventLog.read(signalId);
    if (currentEvents.length === 0) {
      throw new PawFeelDispositionServiceError('signal_not_found', `signal ${signalId} not found`);
    }
    const plan = await planPawFeelConditionBlockerReopen({
      signalId,
      currentEvents,
      resolver: this.options.resumeConditionResolver,
      occurredAt: this.now(),
      mayWrite,
    });
    if (plan.outcome !== 'write') return plan.outcome;
    const append = await this.options.eventLog.append(plan.attempted, currentEvents.length);
    if (append.outcome === 'appended') return 'reopened';
    if (append.outcome === 'conflict') return 'conflicted';
    await this.resolveRacedCommand(signalId, plan.attempted);
    return 'conflicted';
  }

  async reopenBlocker(command: PawFeelBlockerReopenCommand): Promise<PawFeelDispositionCommandResult> {
    const attempted = preparePawFeelBlockerReopen(command);
    const currentEvents = await this.options.eventLog.read(attempted.signalId);
    if (currentEvents.length === 0) {
      throw new PawFeelDispositionServiceError('signal_not_found', `signal ${attempted.signalId} not found`);
    }
    const existing = currentEvents.find((event) => event.eventId === attempted.eventId);
    if (existing) {
      requireMatchingEvent(existing, attempted);
      return { outcome: 'duplicate', projection: projectPawFeelDisposition(currentEvents) };
    }
    if (currentEvents.length !== command.expectedSequence) {
      return { outcome: 'conflict', actualSequence: currentEvents.length };
    }
    const nextProjection = projectPawFeelBlockerReopen(attempted, currentEvents);
    const append = await this.options.eventLog.append(attempted, command.expectedSequence);
    if (append.outcome === 'appended') return { outcome: 'appended', projection: nextProjection };
    if (append.outcome === 'conflict') return append;
    return this.resolveRacedCommand(attempted.signalId, attempted);
  }

  async discover(
    candidate: CanonicalPawFeelCandidate,
    options: {
      backfilled: boolean;
      captureMethod?: PawFeelCaptureMethod;
      captureAssessment?: PawFeelCaptureAssessment;
    },
  ): Promise<Exclude<PawFeelDispositionCommandResult, { outcome: 'conflict' }>> {
    const existing = await this.options.eventLog.read(candidate.signalId);
    if (existing.length > 0) return this.resolveDiscoveryReplay(candidate, existing);

    const event: PawFeelDispositionEvent = {
      eventId: `f278:discovered:${candidate.signalId}`,
      signalId: candidate.signalId,
      type: 'discovered',
      actor: { kind: 'automation', id: 'paw-feel-capture' },
      occurredAt: this.now(),
      source: {
        sourceMessageId: candidate.sourceMessageId,
        sourceThreadId: candidate.sourceThreadId,
        sourceCatId: candidate.sourceCatId,
        markerDigest: candidate.markerDigest,
        sameDigestOrdinal: candidate.sameDigestOrdinal,
        markerIndex: candidate.markerIndex,
      },
      backfilled: options.backfilled,
      captureMethod: options.captureMethod ?? 'legacy_parser',
      captureAssessment: options.captureAssessment ?? 'ambiguous',
    };
    const append = await this.options.eventLog.append(event, 0);
    if (append.outcome === 'appended') {
      return { outcome: 'appended', projection: projectPawFeelDisposition([event]) };
    }
    const raced = await this.options.eventLog.read(candidate.signalId);
    return this.resolveDiscoveryReplay(candidate, raced);
  }

  async execute(
    rawPrincipal: unknown,
    rawCommand: unknown,
    options: PawFeelExecutionOptions = {},
  ): Promise<PawFeelDispositionCommandResult> {
    const actor = parsePrincipal(rawPrincipal);
    const command = parseCommand(rawCommand);
    if (isLegacyWrite(command)) {
      throw new PawFeelDispositionServiceError(
        'legacy_action_disabled',
        `legacy disposition action disabled: ${command.type}; use duplicate, no_action, or fix`,
      );
    }
    const currentEvents = await this.options.eventLog.read(command.signalId);
    if (currentEvents.length === 0) {
      throw new PawFeelDispositionServiceError('signal_not_found', `signal ${command.signalId} not found`);
    }
    const currentProjection = projectPawFeelDisposition(currentEvents);
    const existing = currentEvents.find((event) => event.eventId === command.eventId);
    const occurredAt = existing?.occurredAt ?? this.now();
    const resolved = await resolvePawFeelWriteContext({
      actor,
      command,
      projection: currentProjection,
      ...(existing ? { existing } : {}),
      occurredAt,
      ...(options.ownerCatId ? { ownerCatId: options.ownerCatId } : {}),
      evidence: this.options,
    });
    if ('continuation' in resolved) {
      return { outcome: 'continuation', projection: currentProjection, continuation: resolved.continuation };
    }
    const attempted = pawFeelCommandToEvent(actor, command, occurredAt, resolved.context);
    if (existing) {
      requireMatchingEvent(existing, attempted);
      return { outcome: 'duplicate', projection: projectPawFeelDisposition(currentEvents) };
    }
    if (currentEvents.length !== command.expectedSequence) {
      return { outcome: 'conflict', actualSequence: currentEvents.length };
    }
    if (command.type === 'mark_duplicate') {
      await this.assertDuplicateTarget(command.signalId, command.duplicateOf);
    }
    if (command.type === 'request_signature' && command.action.type === 'duplicate') {
      await this.assertDuplicateTarget(command.signalId, command.action.duplicateOf);
    }

    const nextProjection = projectPawFeelDisposition([...currentEvents, attempted]);
    const append = await this.options.eventLog.append(attempted, command.expectedSequence);
    if (append.outcome === 'appended') return { outcome: 'appended', projection: nextProjection };
    if (append.outcome === 'conflict') return append;
    return this.resolveRacedCommand(command.signalId, attempted);
  }

  async executeMany(
    rawPrincipal: unknown,
    rawCommands: readonly unknown[],
    options: PawFeelExecutionOptions = {},
  ): Promise<PawFeelBulkCommandResult[]> {
    if (rawCommands.length > 50) {
      throw new PawFeelDispositionServiceError('batch_too_large', 'bulk triage accepts at most 50 signals');
    }
    const actor = parsePrincipal(rawPrincipal);
    const results: PawFeelBulkCommandResult[] = [];
    for (const rawCommand of rawCommands) {
      const parsed = PawFeelDispositionCommandSchema.safeParse(rawCommand);
      if (!parsed.success) {
        results.push({
          outcome: 'rejected',
          signalId: 'unknown',
          eventId: 'unknown',
          error: { code: 'invalid_command', message: parsed.error.message },
        });
        continue;
      }
      try {
        results.push(await this.execute(actor, parsed.data, options));
      } catch (error) {
        const serviceError =
          error instanceof PawFeelDispositionServiceError
            ? error
            : new PawFeelDispositionServiceError('invalid_command', String(error));
        results.push({
          outcome: 'rejected',
          signalId: parsed.data.signalId,
          eventId: parsed.data.eventId,
          error: { code: serviceError.code, message: serviceError.message },
        });
      }
    }
    return results;
  }

  async executeBundle(
    rawPrincipal: unknown,
    rawBundle: unknown,
    options: PawFeelExecutionOptions = {},
  ): Promise<PawFeelBundleCommandResult> {
    const actor = parsePrincipal(rawPrincipal);
    const { bundleKey, commands } = await preparePawFeelBundleCommands(
      rawBundle,
      this.options.bundleMembershipResolver,
    );
    const results = await this.executeMany(actor, commands, options);
    const counts: PawFeelBundleCommandResult['counts'] = { appended: 0, duplicate: 0, conflict: 0, rejected: 0 };
    for (const result of results) {
      if (result.outcome === 'continuation') counts.continuation = (counts.continuation ?? 0) + 1;
      else counts[result.outcome] += 1;
    }
    return { bundleKey, results, counts };
  }

  private resolveDiscoveryReplay(
    candidate: CanonicalPawFeelCandidate,
    events: readonly PawFeelDispositionEvent[],
  ): Exclude<PawFeelDispositionCommandResult, { outcome: 'conflict' }> {
    if (events.length === 0) {
      throw new PawFeelDispositionServiceError(
        'identity_collision',
        `discovery for ${candidate.signalId} did not become durable`,
      );
    }
    const projection = projectPawFeelDisposition(events);
    if (!sameDiscoveryIdentity(projection, candidate)) {
      throw new PawFeelDispositionServiceError(
        'identity_collision',
        `signal ${candidate.signalId} resolves to different source identity`,
      );
    }
    return { outcome: 'duplicate', projection };
  }

  private async resolveRacedCommand(
    signalId: string,
    attempted: PawFeelDispositionEvent,
  ): Promise<Exclude<PawFeelDispositionCommandResult, { outcome: 'conflict' }>> {
    const latest = await this.options.eventLog.read(signalId);
    const raced = latest.find((event) => event.eventId === attempted.eventId);
    if (!raced) {
      throw new PawFeelDispositionServiceError(
        'idempotency_collision',
        `eventId ${attempted.eventId} was consumed outside signal ${signalId}`,
      );
    }
    requireMatchingEvent(raced, attempted);
    return { outcome: 'duplicate', projection: projectPawFeelDisposition(latest) };
  }

  private async assertDuplicateTarget(signalId: string, duplicateOf: string): Promise<void> {
    const visited = new Set([signalId]);
    let target = duplicateOf;
    for (;;) {
      if (visited.has(target)) {
        throw new PawFeelDispositionServiceError('duplicate_cycle', `duplicate cycle reaches ${target}`);
      }
      visited.add(target);
      const events = await this.options.eventLog.read(target);
      if (events.length === 0) {
        throw new PawFeelDispositionServiceError('duplicate_target_not_found', `duplicate target ${target} not found`);
      }
      const projection = projectPawFeelDisposition(events);
      if (projection.state !== 'duplicate' || !projection.duplicateOf) return;
      target = projection.duplicateOf;
    }
  }
}
