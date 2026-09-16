import { createHash } from 'node:crypto';
import {
  type OwnerTruthRefV1,
  ownerTruthRefV1Schema,
  type PawFeelResumeConditionV1,
  type PawFeelResumeSelectorV1,
  refIdentity,
} from '@cat-cafe/shared';

// Resume identities are deterministic inputs to the sole disposition writer.

export interface PawFeelResumeResolverSnapshot {
  normalizedSelector: PawFeelResumeSelectorV1;
  state: string;
  version: string;
  satisfied: boolean;
  evidenceRefs: OwnerTruthRefV1[];
}

export interface PawFeelResumeConditionResolver {
  resolve(selector: PawFeelResumeSelectorV1): Promise<PawFeelResumeResolverSnapshot>;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function digest(tag: string, value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([tag, canonicalize(value)]))
    .digest('hex');
}

export function normalizePawFeelResumeSnapshot(snapshot: PawFeelResumeResolverSnapshot) {
  return {
    normalizedSelector: snapshot.normalizedSelector,
    state: snapshot.state.trim(),
    version: snapshot.version.trim(),
    satisfied: snapshot.satisfied,
    evidenceRefs: [...snapshot.evidenceRefs]
      .map((ref) => ownerTruthRefV1Schema.parse(ref))
      .sort((left, right) => refIdentity(left).localeCompare(refIdentity(right))),
  };
}

export function samePawFeelResumeSelector(left: PawFeelResumeSelectorV1, right: PawFeelResumeSelectorV1): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'bounded_time' && right.kind === 'bounded_time') return left.recheckAt === right.recheckAt;
  if (left.kind === 'bounded_time' || right.kind === 'bounded_time') return false;
  return left.ref.ownerFeatureId === right.ref.ownerFeatureId && left.ref.ownerStateRef === right.ref.ownerStateRef;
}

export function digestPawFeelResumeSnapshot(snapshot: PawFeelResumeResolverSnapshot): string {
  return digest('paw-feel-resume-snapshot:v1', normalizePawFeelResumeSnapshot(snapshot));
}

export function derivePawFeelResumeVersion(snapshot: PawFeelResumeResolverSnapshot, dueAt?: string): string {
  return dueAt ? digest('paw-feel-resume-snapshot:v1', `due:${dueAt}`) : digestPawFeelResumeSnapshot(snapshot);
}

export function derivePawFeelBlockerReopenEventId(input: {
  signalId: string;
  conditionId: string;
  blockedVersion: string;
  resumeVersion: string;
}): string {
  return `paw-feel-blocker-reopened:v1:${digest('paw-feel-blocker-reopened:v1', input)}`;
}

export function derivePawFeelResumeConditionId(
  blockedEpisode: OwnerTruthRefV1,
  selector: PawFeelResumeSelectorV1,
): string {
  return digest('paw-feel-resume:v1', [blockedEpisode, selector]);
}

export async function resolvePawFeelResumeSnapshot(
  selector: PawFeelResumeSelectorV1,
  resolver: PawFeelResumeConditionResolver,
) {
  const snapshot = normalizePawFeelResumeSnapshot(await resolver.resolve(selector));
  if (!samePawFeelResumeSelector(selector, snapshot.normalizedSelector)) {
    throw new Error('resume resolver changed the named selector identity');
  }
  if (!snapshot.state || !snapshot.version) throw new Error('resume resolver returned an empty snapshot');
  return snapshot;
}

export async function preparePawFeelResumeCondition(input: {
  signalId: string;
  blockingSequence: number;
  selector: PawFeelResumeSelectorV1;
  resolver: PawFeelResumeConditionResolver;
  now: string;
}): Promise<PawFeelResumeConditionV1> {
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) throw new Error('blocker time is invalid');
  if (input.selector.kind === 'bounded_time' && Date.parse(input.selector.recheckAt) <= nowMs) {
    throw new Error('bounded blocker recheckAt must be in the future');
  }
  const snapshot = await resolvePawFeelResumeSnapshot(input.selector, input.resolver);
  if (snapshot.satisfied) throw new Error('resume condition is already satisfied');
  const blockedEpisode = ownerTruthRefV1Schema.parse({
    ownerFeatureId: 'F278',
    ownerStateRef: `paw-feel-blocked:${input.signalId}`,
    version: String(input.blockingSequence),
  });
  return {
    schemaVersion: 1,
    blockedEpisode,
    selector: snapshot.normalizedSelector,
    conditionId: derivePawFeelResumeConditionId(blockedEpisode, snapshot.normalizedSelector),
    blockedVersion: digestPawFeelResumeSnapshot(snapshot),
  };
}
