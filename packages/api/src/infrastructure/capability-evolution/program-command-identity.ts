import { createHash } from 'node:crypto';
import type { EvolutionProgramEventEnvelopeV1, EvolutionProgramEventV1 } from '@cat-cafe/shared';
import type { EvolutionProgramServiceResult } from './program-command-contract.js';
import type { ProgramEvaluationDependencies, ProgramEvaluationLinkBase } from './program-evaluation-contract.js';
import type { EvolutionProgramProjectionV1 } from './program-projection.js';

/**
 * One append path for every Program command that derives its event from state.
 *
 * Both the lifecycle producers and the evaluation ingress go through here, so "is this a retry, a
 * stale sequence, or a reused id carrying different content" is answered the same way everywhere
 * rather than re-implemented per lane — which is how the two answers drift apart.
 */

/**
 * Complete identity of the incoming request, over EVERY field the caller supplied — not a per-event
 * subset and not a per-type special case. Object keys are emitted in sorted order so two structurally
 * identical requests digest identically regardless of JSON key order, and nested owner refs are
 * covered because the walk is recursive.
 *
 * This is what makes "retry" and "reused id, different content" distinguishable BEFORE the event is
 * derived. An earlier version compared only `measurement_linked.measurementResultRef`, so an
 * attribution or intervention that reused a client message id with different content was reported as
 * a plain duplicate and silently dropped.
 */
export function stableEncode(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableEncode).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableEncode(entry)}`).join(',')}}`;
}

export function commandIdentityDigest(input: ProgramEvaluationLinkBase): string {
  return createHash('sha256').update(stableEncode(input)).digest('hex');
}

/**
 * Reads, preflights, derives and appends. The preflight runs before the event is built because
 * building it may call an owner: a retry of an already-applied command must still answer `duplicate`
 * when that owner has since become unreachable, and a stale sequence must not spend an external call
 * before being told it is stale.
 */
export async function guardedAppend(
  input: ProgramEvaluationLinkBase,
  deps: ProgramEvaluationDependencies,
  build: (
    events: readonly EvolutionProgramEventEnvelopeV1[],
    projection: EvolutionProgramProjectionV1,
  ) => Promise<EvolutionProgramEventV1> | EvolutionProgramEventV1,
): Promise<EvolutionProgramServiceResult> {
  const events = await deps.read(input.programId);
  const projection = deps.project(events);
  const digest = commandIdentityDigest(input);
  const replayed = events.find((candidate) => candidate.clientMessageId === input.clientMessageId);
  if (replayed !== undefined) {
    // Only a byte-identical request is a duplicate. A reused clientMessageId carrying different
    // content — of ANY event type — must reach the append path so the identity digest raises a
    // collision, and must NOT be short-circuited by the sequence check: after the first append the
    // sequence has already moved, so a sequence answer here would mask the collision as a conflict.
    if (replayed.commandDigest === digest) return { outcome: 'duplicate', projection };
  } else if (input.expectedSequence !== projection.program.sequence) {
    return { outcome: 'conflict', actualSequence: projection.program.sequence, projection };
  }
  return deps.append(deps.envelope(input, await build(events, projection), digest));
}
