import { createHash } from 'node:crypto';
import type { VideoProjectActor, VideoProjectDocumentV1 } from '@cat-cafe/shared';
import { assertCheckResultsBoundToInput } from './check-results.js';

export function projectValueDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
export function sameProjectValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Existing immutable material and audit evidence can only be appended. */
export function assertProjectHistoryPreserved(previous: VideoProjectDocumentV1, next: VideoProjectDocumentV1): void {
  for (const asset of previous.assets) {
    const current = next.assets.find((candidate) => candidate.id === asset.id);
    if (!current) throw new Error('Asset history must be retained');
    for (const version of asset.versions) {
      if (
        !sameProjectValue(
          version,
          current.versions.find((candidate) => candidate.id === version.id),
        )
      )
        throw new Error('Asset version is immutable');
    }
  }
  for (const result of previous.checkResults) {
    if (
      !sameProjectValue(
        result,
        next.checkResults.find((candidate) => candidate.id === result.id),
      )
    )
      throw new Error('Check result history is immutable');
  }
  for (const page of previous.checkPages) {
    if (!next.checkPages.some((candidate) => candidate.id === page.id))
      throw new Error('Archive check pages rather than erase history');
  }
  for (const decision of previous.decisions) {
    const current = next.decisions.find((candidate) => candidate.id === decision.id);
    if (!current || !sameProjectValue(current.history.slice(0, decision.history.length), decision.history))
      throw new Error('Decision history must be retained');
  }
}

export function assertProjectDecisions(
  previous: VideoProjectDocumentV1 | undefined,
  next: VideoProjectDocumentV1,
  actor: VideoProjectActor,
  ownerUserId: string,
  operationId: string,
  transitionDecisionId?: string,
): void {
  for (const decision of next.decisions) {
    if (decision.decider.kind !== 'human' || decision.decider.actorId !== ownerUserId)
      throw new Error('Decision requires the project Human owner');
    const prior = previous?.decisions.find((candidate) => candidate.id === decision.id);
    // Reopening permits choosing again; past choices must retain their exact meaning.
    if (
      prior?.history.some((event) => event.kind === 'decided') &&
      !sameProjectValue(decisionMeaning(prior), decisionMeaning(decision))
    )
      throw new Error('Decision meaning is frozen after a choice; create a new proposal');
    if (!prior) {
      if (
        decision.state !== 'open' ||
        decision.history.length !== 1 ||
        decision.history[0].kind !== 'proposed' ||
        !sameProjectValue(decision.proposer, actor) ||
        !sameProjectValue(decision.history[0].actor, actor) ||
        decision.history[0].operationId !== operationId
      )
        throw new Error('New decisions must record a real open proposal');
    } else if (
      decision.id !== transitionDecisionId &&
      (decision.state !== prior.state || !sameProjectValue(decision.history, prior.history))
    ) {
      throw new Error('Use an authorized decision command to change decision state/history');
    }
  }
}

export function assertNewCheckResults(
  previous: VideoProjectDocumentV1,
  next: VideoProjectDocumentV1,
  baseRevision: number,
) {
  const previousIds = new Set(previous.checkResults.map((result) => result.id));
  assertCheckResultsBoundToInput(
    previous,
    next.checkResults.filter((result) => !previousIds.has(result.id)),
    baseRevision,
  );
}

function decisionMeaning(decision: VideoProjectDocumentV1['decisions'][number]) {
  return Object.fromEntries(Object.entries(decision).filter(([key]) => key !== 'state' && key !== 'history'));
}

/** Only the renderer owning opaque parameters may change those parameters. */
export function assertOpaqueExtensionsPreserved(previous: VideoProjectDocumentV1, next: VideoProjectDocumentV1): void {
  const pairs = [
    [previous.timeline.extensions, next.timeline.extensions],
    ...previous.timeline.segments.map((segment) => [
      segment.extensions,
      next.timeline.segments.find((candidate) => candidate.id === segment.id)?.extensions,
    ]),
    ...previous.timeline.events.map((event) => [
      event.extensions,
      next.timeline.events.find((candidate) => candidate.id === event.id)?.extensions,
    ]),
  ];
  for (const [before, after] of pairs) {
    if (before && !sameProjectValue(before, after?.slice(0, before.length)))
      throw new Error('Unsupported renderer extension edit');
  }
}
