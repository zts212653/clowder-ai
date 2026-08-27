import type { MeetingIntake } from '@cat-cafe/shared';

const SOURCE_STATES = new Set(['ready', 'not_ready', 'auth_required', 'deleted']);
const JUDGMENT_STATES = new Set(['unresolved', 'confirmed', 'auto_resolved', 'dismissed']);
const EXECUTION_STATES = new Set(['idle', 'queued', 'running', 'succeeded', 'failed']);
const HEALTH_STATES = new Set(['healthy', 'degraded']);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validArtifact(value: unknown, intakeId: string, sourceHandle: string): boolean {
  if (value === undefined) return true;
  const artifact = record(value);
  if (!artifact) return false;
  const allowed = new Set([
    'contentType',
    'resourceRef',
    'sourceHandle',
    'sourceRevision',
    'byteLength',
    'trust',
    'instructionPolicy',
  ]);
  if (Object.keys(artifact).some((key) => !allowed.has(key))) return false;
  if (
    artifact.contentType !== 'text/plain' ||
    artifact.sourceHandle !== sourceHandle ||
    typeof artifact.sourceRevision !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(artifact.sourceRevision) ||
    artifact.resourceRef !==
      `meeting-artifact://intakes/${encodeURIComponent(intakeId)}?revision=${artifact.sourceRevision}` ||
    !Number.isSafeInteger(artifact.byteLength) ||
    Number(artifact.byteLength) < 0 ||
    Number(artifact.byteLength) > 2_000_000 ||
    artifact.trust !== 'untrusted_external' ||
    artifact.instructionPolicy !== 'data_only'
  ) {
    return false;
  }
  return true;
}

export function parseMeetingIntake(raw: string): MeetingIntake {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('meeting intake record is not valid JSON');
  }
  const intake = record(value);
  const origin = record(intake?.origin);
  const source = record(intake?.source);
  const ingress = record(intake?.ingress);
  if (
    !intake ||
    !nonEmpty(intake.intakeId) ||
    !nonEmpty(intake.ownerId) ||
    !nonEmpty(intake.routeId) ||
    !Number.isSafeInteger(intake.routeGeneration) ||
    !origin ||
    !nonEmpty(origin.pluginId) ||
    !nonEmpty(origin.pluginInstanceId) ||
    !source ||
    !nonEmpty(source.handle) ||
    !validArtifact(intake.artifact, intake.intakeId as string, source.handle) ||
    !ingress ||
    !nonEmpty(ingress.publicationId) ||
    !nonEmpty(ingress.canonicalDigest) ||
    !SOURCE_STATES.has(String(intake.sourceState)) ||
    !JUDGMENT_STATES.has(String(intake.judgmentState)) ||
    !EXECUTION_STATES.has(String(intake.executionState)) ||
    !HEALTH_STATES.has(String(intake.healthState)) ||
    !Number.isSafeInteger(intake.revision) ||
    Number(intake.revision) < 1
  ) {
    throw new Error('meeting intake record is corrupt');
  }
  return structuredClone(intake) as unknown as MeetingIntake;
}
