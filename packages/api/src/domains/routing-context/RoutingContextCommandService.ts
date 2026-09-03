import { randomUUID } from 'node:crypto';
import {
  type RoutingPreferenceCreateCommandV1,
  type RoutingPreferenceRetireCommandV1,
  type RoutingPreferenceSupersedeCommandV1,
  type RoutingSignalCloseCommandV1,
  type RoutingSignalMarkCommandV1,
  routingPreferenceRevisionV1Schema,
  routingSignalEventV1Schema,
} from '@cat-cafe/shared';
import type { IRoutingPreferenceStore, RoutingPreferenceAppendResult } from './RoutingPreferenceStore.js';
import type { IRoutingSignalEventStore, RoutingSignalEventAppendResult } from './RoutingSignalEventStore.js';
import {
  type PreferenceCommandExpectation,
  preferenceCommandMatches,
  type SignalCommandExpectation,
  signalCommandMatches,
} from './routing-context-command-match.js';

export type RoutingContextIdKind = 'signal' | 'preference' | 'preference-revision';
export type RoutingContextCommandErrorCode = 'conflict' | 'invalid' | 'not_found';

export class RoutingContextCommandError extends Error {
  constructor(
    readonly code: RoutingContextCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RoutingContextCommandError';
  }
}

export interface RoutingContextCommandServiceOptions {
  signalStore: Pick<IRoutingSignalEventStore, 'append' | 'get' | 'getByCommand'>;
  preferenceStore: Pick<IRoutingPreferenceStore, 'append' | 'getHead' | 'getByCommand'>;
  now?: () => number;
  nextId?: (kind: RoutingContextIdKind) => string;
}

function isNamedError(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

export class RoutingContextCommandService {
  private readonly now: () => number;
  private readonly nextId: (kind: RoutingContextIdKind) => string;

  constructor(private readonly options: RoutingContextCommandServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.nextId = options.nextId ?? ((kind) => `${kind}-${randomUUID()}`);
  }

  async mark(ownerId: string, command: RoutingSignalMarkCommandV1): Promise<RoutingSignalEventAppendResult> {
    const expected = { eventType: 'asserted' as const, command };
    const replay = await this.signalReplay(ownerId, expected);
    if (replay) return replay;
    const observedAt = this.now();
    if (
      (command.validUntil !== undefined && command.validUntil <= observedAt) ||
      (command.resetAt !== undefined && command.resetAt <= observedAt)
    ) {
      throw new RoutingContextCommandError('invalid', 'manual routing signal validity must be in the future');
    }
    const event = routingSignalEventV1Schema.parse({
      ...command,
      eventId: this.nextId('signal'),
      ownerId,
      source: 'manual_cvo',
      observedAt,
      evidenceRef: `routing-context:manual:${command.commandId}`,
      eventType: 'asserted',
    });
    return this.appendSignal(ownerId, expected, event);
  }

  async close(
    ownerId: string,
    assertionId: string,
    command: RoutingSignalCloseCommandV1,
    eventType: 'recovered' | 'retracted',
  ): Promise<RoutingSignalEventAppendResult> {
    const expected = { eventType, assertionId, command };
    const replay = await this.signalReplay(ownerId, expected);
    if (replay) return replay;
    const assertion = await this.options.signalStore.get(ownerId, assertionId);
    if (!assertion) throw new RoutingContextCommandError('not_found', 'Routing signal assertion not found');
    if (assertion.eventType !== 'asserted') {
      throw new RoutingContextCommandError('conflict', 'Only an assertion can be closed');
    }
    const event = routingSignalEventV1Schema.parse({
      v: 1,
      eventId: this.nextId('signal'),
      commandId: command.commandId,
      ownerId,
      subjectRef: assertion.subjectRef,
      reasonCode: command.reasonCode,
      ...(command.note !== undefined ? { note: command.note } : {}),
      source: 'manual_cvo',
      observedAt: this.now(),
      evidenceRef: `routing-context:manual:${command.commandId}`,
      eventType,
      ...(eventType === 'recovered' ? { state: 'available' } : {}),
      closesSignalIds: [assertionId],
    });
    return this.appendSignal(ownerId, expected, event);
  }

  async createPreference(
    ownerId: string,
    command: RoutingPreferenceCreateCommandV1,
  ): Promise<RoutingPreferenceAppendResult> {
    const expected = { kind: 'create' as const, command };
    const replay = await this.preferenceReplay(ownerId, expected);
    if (replay) return replay;
    const validFrom = this.now();
    this.requireFutureReview(command.reviewAfter, validFrom);
    const revision = routingPreferenceRevisionV1Schema.parse({
      ...command,
      preferenceId: this.nextId('preference'),
      revisionId: this.nextId('preference-revision'),
      ownerId,
      version: 1,
      validFrom,
      lifecycle: 'active',
    });
    return this.appendPreference(ownerId, expected, revision);
  }

  async supersedePreference(
    ownerId: string,
    preferenceId: string,
    command: RoutingPreferenceSupersedeCommandV1,
  ): Promise<RoutingPreferenceAppendResult> {
    const expected = { kind: 'supersede' as const, preferenceId, command };
    const replay = await this.preferenceReplay(ownerId, expected);
    if (replay) return replay;
    const head = await this.requireActivePreferenceHead(ownerId, preferenceId, command);
    const validFrom = this.now();
    this.requireFutureReview(command.reviewAfter, validFrom);
    const revision = routingPreferenceRevisionV1Schema.parse({
      v: 1,
      preferenceId,
      revisionId: this.nextId('preference-revision'),
      commandId: command.commandId,
      ownerId,
      appliesWhen: command.appliesWhen,
      prefer: command.prefer,
      over: command.over,
      rationale: command.rationale,
      evidenceRefs: command.evidenceRefs,
      version: head.version + 1,
      validFrom,
      lifecycle: 'active',
      ...(command.reviewAfter !== undefined ? { reviewAfter: command.reviewAfter } : {}),
      supersedesRevisionId: head.revisionId,
    });
    return this.appendPreference(ownerId, expected, revision);
  }

  async retirePreference(
    ownerId: string,
    preferenceId: string,
    command: RoutingPreferenceRetireCommandV1,
  ): Promise<RoutingPreferenceAppendResult> {
    const expected = { kind: 'retire' as const, preferenceId, command };
    const replay = await this.preferenceReplay(ownerId, expected);
    if (replay) return replay;
    const head = await this.requireActivePreferenceHead(ownerId, preferenceId, command);
    const retiredAt = this.now();
    const revision = routingPreferenceRevisionV1Schema.parse({
      v: 1,
      preferenceId,
      revisionId: this.nextId('preference-revision'),
      commandId: command.commandId,
      ownerId,
      appliesWhen: head.appliesWhen,
      prefer: head.prefer,
      over: head.over,
      rationale: head.rationale,
      evidenceRefs: head.evidenceRefs,
      version: head.version + 1,
      validFrom: retiredAt,
      lifecycle: 'retired',
      retiredAt,
      retirementReason: command.retirementReason,
      supersedesRevisionId: head.revisionId,
    });
    return this.appendPreference(ownerId, expected, revision);
  }

  private async signalReplay(ownerId: string, expected: SignalCommandExpectation) {
    const event = await this.options.signalStore.getByCommand(ownerId, expected.command.commandId);
    if (!event) return null;
    if (!signalCommandMatches(event, expected)) {
      throw new RoutingContextCommandError('conflict', 'Routing signal command conflict');
    }
    return { outcome: 'replayed' as const, event };
  }

  private async appendSignal(
    ownerId: string,
    expected: SignalCommandExpectation,
    event: Parameters<IRoutingSignalEventStore['append']>[0],
  ) {
    try {
      return await this.options.signalStore.append(event);
    } catch (error) {
      if (isNamedError(error, 'RoutingSignalEventConflictError')) {
        const replay = await this.signalReplay(ownerId, expected);
        if (replay) return replay;
      }
      throw error;
    }
  }

  private async preferenceReplay(ownerId: string, expected: PreferenceCommandExpectation) {
    const revision = await this.options.preferenceStore.getByCommand(ownerId, expected.command.commandId);
    if (!revision) return null;
    if (!preferenceCommandMatches(revision, expected)) {
      throw new RoutingContextCommandError('conflict', 'Routing preference command conflict');
    }
    return { outcome: 'replayed' as const, revision };
  }

  private async appendPreference(
    ownerId: string,
    expected: PreferenceCommandExpectation,
    revision: Parameters<IRoutingPreferenceStore['append']>[0],
  ) {
    try {
      return await this.options.preferenceStore.append(revision);
    } catch (error) {
      if (isNamedError(error, 'RoutingPreferenceConflictError')) {
        const replay = await this.preferenceReplay(ownerId, expected);
        if (replay) return replay;
      }
      throw error;
    }
  }

  private async requireActivePreferenceHead(
    ownerId: string,
    preferenceId: string,
    base: { baseRevisionId: string; baseVersion: number },
  ) {
    const head = await this.options.preferenceStore.getHead(ownerId, preferenceId);
    if (!head) throw new RoutingContextCommandError('not_found', 'Routing preference not found');
    if (head.lifecycle === 'retired' || head.revisionId !== base.baseRevisionId || head.version !== base.baseVersion) {
      throw new RoutingContextCommandError('conflict', 'Routing preference base is stale or retired');
    }
    return head;
  }

  private requireFutureReview(reviewAfter: number | undefined, validFrom: number): void {
    if (reviewAfter !== undefined && reviewAfter <= validFrom) {
      throw new RoutingContextCommandError('invalid', 'preference reviewAfter must be in the future');
    }
  }
}
