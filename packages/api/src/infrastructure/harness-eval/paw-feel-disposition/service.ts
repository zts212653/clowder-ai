import type {
  PawFeelCaptureAssessment,
  PawFeelCaptureMethod,
  PawFeelDispositionEvent,
  PawFeelDispositionProjection,
} from '@cat-cafe/shared';
import type { CanonicalPawFeelCandidate } from '../friction/paw-feel-source.js';
import {
  type PawFeelBundleAction,
  PawFeelBundleCommandSchema,
  type PawFeelDispositionCommand,
  PawFeelDispositionCommandSchema,
  type PawFeelResolvedCommandContext,
  type PawFeelResolvedFix,
  pawFeelCommandToEvent,
} from './commands.js';
import type { IPawFeelDispositionEventLog, PawFeelDispositionAppendResult } from './event-log.js';
import { projectPawFeelDisposition } from './projector.js';
import {
  isLegacyWrite,
  PawFeelDispositionServiceError,
  type PawFeelDispositionServiceErrorCode,
  type PawFeelTrustedPrincipal,
  parseCommand,
  parsePrincipal,
  requireMatchingEvent,
  sameDiscoveryIdentity,
} from './service-guards.js';

export { PawFeelDispositionServiceError, type PawFeelDispositionServiceErrorCode } from './service-guards.js';

export type PawFeelDispositionCommandResult =
  | { outcome: 'appended' | 'duplicate'; projection: PawFeelDispositionProjection }
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
  counts: Record<'appended' | 'duplicate' | 'conflict' | 'rejected', number>;
}

export interface PawFeelFixResolver {
  resolve(leaseId: string): Promise<PawFeelResolvedFix>;
}

export interface PawFeelBundleMembershipResolver {
  assertBundleMembers(bundleKey: string, signalIds: readonly string[]): Promise<void>;
}

export interface PawFeelDispositionServiceOptions {
  eventLog: IPawFeelDispositionEventLog;
  fixResolver?: PawFeelFixResolver;
  bundleMembershipResolver?: PawFeelBundleMembershipResolver;
  now?: () => string;
}

export interface PawFeelExecutionOptions {
  ownerCatId?: string;
}

function commandForBundleMember(
  action: import('./commands.js').PawFeelBundleAction,
  member: import('./commands.js').PawFeelBundleCommand['members'][number],
  eventId: string,
): PawFeelDispositionCommand {
  const base = { eventId, signalId: member.signalId, expectedSequence: member.expectedSequence };
  if (action.type === 'duplicate') return { ...base, type: 'mark_duplicate', duplicateOf: action.duplicateOf };
  if (action.type === 'no_action') return { ...base, type: 'mark_no_action', reasonCode: action.reasonCode };
  return { ...base, type: 'mark_fix', leaseId: action.leaseId };
}

export class PawFeelDispositionService {
  private readonly now: () => string;

  constructor(private readonly options: PawFeelDispositionServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
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
    const context = await this.resolveCommandContext(actor, command, options);
    const existing = currentEvents.find((event) => event.eventId === command.eventId);
    const attempted = pawFeelCommandToEvent(actor, command, existing?.occurredAt ?? this.now(), context);
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
    const parsed = PawFeelBundleCommandSchema.safeParse(rawBundle);
    if (!parsed.success) {
      throw new PawFeelDispositionServiceError('bundle_invalid', `invalid bundle command: ${parsed.error.message}`);
    }
    const bundle = parsed.data;
    const memberIds = bundle.members.map((member) => member.signalId);
    if (new Set(memberIds).size !== memberIds.length) {
      throw new PawFeelDispositionServiceError('bundle_invalid', 'bundle contains duplicate signal IDs');
    }
    const exceptions = new Map<string, PawFeelBundleAction>();
    for (const exception of bundle.exceptions ?? []) {
      if (!memberIds.includes(exception.signalId)) {
        throw new PawFeelDispositionServiceError(
          'bundle_invalid',
          `bundle exception ${exception.signalId} is not in the submitted snapshot`,
        );
      }
      if (exceptions.has(exception.signalId)) {
        throw new PawFeelDispositionServiceError('bundle_invalid', `duplicate exception for ${exception.signalId}`);
      }
      exceptions.set(exception.signalId, exception.action);
    }
    if (!this.options.bundleMembershipResolver) {
      throw new PawFeelDispositionServiceError(
        'bundle_invalid',
        'bundle actions require authoritative membership resolution',
      );
    }
    try {
      await this.options.bundleMembershipResolver.assertBundleMembers(bundle.bundleKey, memberIds);
    } catch (error) {
      throw new PawFeelDispositionServiceError(
        'bundle_invalid',
        `bundle membership mismatch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const commands = bundle.members.map((member, index) =>
      commandForBundleMember(
        exceptions.get(member.signalId) ?? bundle.action,
        member,
        `${bundle.eventIdPrefix}:${index}`,
      ),
    );
    const results = await this.executeMany(actor, commands, options);
    const counts = { appended: 0, duplicate: 0, conflict: 0, rejected: 0 };
    for (const result of results) counts[result.outcome] += 1;
    return { bundleKey: bundle.bundleKey, results, counts };
  }

  private async resolveCommandContext(
    actor: PawFeelTrustedPrincipal,
    command: PawFeelDispositionCommand,
    options: PawFeelExecutionOptions,
  ): Promise<PawFeelResolvedCommandContext> {
    if (command.type === 'mark_fix') {
      if (!this.options.fixResolver) {
        throw new PawFeelDispositionServiceError(
          'fix_evidence_invalid',
          'fix requires a task owner and active F167 lease resolver',
        );
      }
      try {
        const fix = await this.options.fixResolver.resolve(command.leaseId);
        if (fix.leaseId !== command.leaseId) throw new Error('resolved lease identity mismatch');
        return { fix };
      } catch (error) {
        throw new PawFeelDispositionServiceError(
          'fix_evidence_invalid',
          `fix requires a real task/owner/active lease: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (command.type !== 'mark_duplicate' && command.type !== 'mark_no_action') return {};
    if (actor.kind !== 'cat') {
      throw new PawFeelDispositionServiceError(
        'named_owner_required',
        `${command.type} requires a cat-signed named lightweight owner`,
      );
    }
    if (options.ownerCatId && options.ownerCatId !== actor.id) {
      throw new PawFeelDispositionServiceError('named_owner_required', 'cat actor may only sign itself as owner');
    }
    return { ownerCatId: actor.id };
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
