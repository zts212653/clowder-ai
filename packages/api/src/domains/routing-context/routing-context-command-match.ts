import { isDeepStrictEqual } from 'node:util';
import type {
  RoutingPreferenceCreateCommandV1,
  RoutingPreferenceRetireCommandV1,
  RoutingPreferenceRevisionV1,
  RoutingPreferenceSupersedeCommandV1,
  RoutingSignalCloseCommandV1,
  RoutingSignalEventV1,
  RoutingSignalMarkCommandV1,
} from '@cat-cafe/shared';

export type SignalCommandExpectation =
  | { eventType: 'asserted'; command: RoutingSignalMarkCommandV1 }
  | { eventType: 'recovered' | 'retracted'; assertionId: string; command: RoutingSignalCloseCommandV1 };

export type PreferenceCommandExpectation =
  | { kind: 'create'; command: RoutingPreferenceCreateCommandV1 }
  | { kind: 'supersede'; preferenceId: string; command: RoutingPreferenceSupersedeCommandV1 }
  | { kind: 'retire'; preferenceId: string; command: RoutingPreferenceRetireCommandV1 };

export function signalCommandMatches(event: RoutingSignalEventV1, expected: SignalCommandExpectation): boolean {
  if (event.eventType !== expected.eventType) return false;
  if (event.eventType === 'asserted' && expected.eventType === 'asserted') {
    return isDeepStrictEqual(
      {
        v: event.v,
        commandId: event.commandId,
        subjectRef: event.subjectRef,
        state: event.state,
        reasonCode: event.reasonCode,
        ...(event.note ? { note: event.note } : {}),
        ...(event.validUntil !== undefined ? { validUntil: event.validUntil } : {}),
        ...(event.resetAt !== undefined ? { resetAt: event.resetAt } : {}),
      },
      expected.command,
    );
  }
  if (event.eventType === 'asserted' || expected.eventType === 'asserted') return false;
  return (
    isDeepStrictEqual(event.closesSignalIds, [expected.assertionId]) &&
    isDeepStrictEqual(
      {
        v: event.v,
        commandId: event.commandId,
        reasonCode: event.reasonCode,
        ...(event.note ? { note: event.note } : {}),
      },
      expected.command,
    )
  );
}

function preferenceRule(revision: RoutingPreferenceRevisionV1) {
  return {
    appliesWhen: revision.appliesWhen,
    prefer: revision.prefer,
    over: revision.over,
    rationale: revision.rationale,
    evidenceRefs: revision.evidenceRefs,
    ...(revision.lifecycle === 'active' && revision.reviewAfter !== undefined
      ? { reviewAfter: revision.reviewAfter }
      : {}),
  };
}

export function preferenceCommandMatches(
  revision: RoutingPreferenceRevisionV1,
  expected: PreferenceCommandExpectation,
): boolean {
  if (revision.commandId !== expected.command.commandId) return false;
  if (expected.kind === 'create') {
    const { v: _v, commandId: _commandId, ...rule } = expected.command;
    return (
      revision.lifecycle === 'active' && revision.version === 1 && isDeepStrictEqual(preferenceRule(revision), rule)
    );
  }
  if (revision.preferenceId !== expected.preferenceId) return false;
  if (
    revision.version !== expected.command.baseVersion + 1 ||
    revision.supersedesRevisionId !== expected.command.baseRevisionId
  ) {
    return false;
  }
  if (expected.kind === 'retire') {
    return revision.lifecycle === 'retired' && revision.retirementReason === expected.command.retirementReason;
  }
  const {
    v: _v,
    commandId: _commandId,
    baseRevisionId: _baseRevisionId,
    baseVersion: _baseVersion,
    ...rule
  } = expected.command;
  return revision.lifecycle === 'active' && isDeepStrictEqual(preferenceRule(revision), rule);
}
