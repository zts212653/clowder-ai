import { isAbsolute } from 'node:path';
import { VERDICT_CLASSES } from '../task-outcome/task-outcome-episode.js';
import type { HandlerError, TaskOutcomeSnapshotSourceRefs, VerdictSourceRefs } from './types.js';

export function isTaskOutcomeSourceRefs(refs: VerdictSourceRefs | undefined): refs is TaskOutcomeSnapshotSourceRefs {
  return Boolean(refs && 'kind' in refs && refs.kind === 'task-outcome-snapshot');
}

export function validateTaskOutcomeSourceRefs(
  sourceRefs: VerdictSourceRefs | undefined,
): { ok: true } | { ok: false; error: HandlerError } {
  if (!isTaskOutcomeSourceRefs(sourceRefs)) {
    return invalidSourceRef(
      `validateTaskOutcomeSourceRefs called with non-task-outcome sourceRefs (kind=${(sourceRefs as { kind?: string } | undefined)?.kind ?? 'unknown'}); use isTaskOutcomeSourceRefs guard before calling.`,
    );
  }
  const windowError = validateWindow(sourceRefs);
  if (windowError) return windowError;
  const scalarError = validateOptionalScalars(sourceRefs);
  if (scalarError) return scalarError;
  const episodeVerdictsError = validateEpisodeVerdicts(sourceRefs.episodeVerdicts);
  if (episodeVerdictsError) return episodeVerdictsError;
  return { ok: true };
}

function validateWindow(sourceRefs: TaskOutcomeSnapshotSourceRefs): { ok: false; error: HandlerError } | null {
  if (
    typeof sourceRefs.windowStartMs !== 'number' ||
    !Number.isFinite(sourceRefs.windowStartMs) ||
    typeof sourceRefs.windowEndMs !== 'number' ||
    !Number.isFinite(sourceRefs.windowEndMs)
  ) {
    return invalidSourceRef('task-outcome-snapshot requires finite numeric windowStartMs and windowEndMs');
  }
  if (sourceRefs.windowEndMs <= sourceRefs.windowStartMs) {
    return invalidSourceRef('task-outcome-snapshot requires windowEndMs > windowStartMs');
  }
  return null;
}

function validateOptionalScalars(sourceRefs: TaskOutcomeSnapshotSourceRefs): { ok: false; error: HandlerError } | null {
  for (const [field, value] of [
    ['databasePath', sourceRefs.databasePath],
    ['evidenceCatId', sourceRefs.evidenceCatId],
  ] as const) {
    const stringError = validateOptionalString(field, value);
    if (stringError) return stringError;
    if (field === 'databasePath' && typeof value === 'string') {
      const pathError = validateRelativeDatabasePath(value);
      if (pathError) return pathError;
    }
  }
  return null;
}

function validateOptionalString(field: string, value: unknown): { ok: false; error: HandlerError } | null {
  if (value !== undefined && typeof value !== 'string') {
    return invalidSourceRef(`${field} must be a string when provided`);
  }
  if (typeof value === 'string' && /[\r\n]/.test(value)) {
    return invalidSourceRef(`${field} must not contain newlines`);
  }
  return null;
}

function validateRelativeDatabasePath(value: string): { ok: false; error: HandlerError } | null {
  if (isAbsolute(value)) {
    return invalidSourceRef('databasePath must be repo-relative (absolute paths are forbidden)');
  }
  if (hasParentTraversalSegment(value)) {
    return invalidSourceRef('databasePath must not contain parent-directory traversal segments ("..")');
  }
  return null;
}

function validateEpisodeVerdicts(
  episodeVerdicts: TaskOutcomeSnapshotSourceRefs['episodeVerdicts'],
): { ok: false; error: HandlerError } | null {
  if (episodeVerdicts === undefined) return null;
  if (!Array.isArray(episodeVerdicts) || episodeVerdicts.length === 0) {
    return invalidSourceRef('episodeVerdicts must be a non-empty array when provided');
  }
  const seen = new Set<string>();
  for (const [index, entry] of episodeVerdicts.entries()) {
    const entryError = validateEpisodeVerdictEntry(entry, index, seen);
    if (entryError) return entryError;
  }
  return null;
}

function validateEpisodeVerdictEntry(
  entry: unknown,
  index: number,
  seen: Set<string>,
): { ok: false; error: HandlerError } | null {
  if (!entry || typeof entry !== 'object') {
    return invalidEpisodeVerdict(index, 'must be an object');
  }
  const episodeId = (entry as { episodeId?: unknown }).episodeId;
  if (typeof episodeId !== 'string' || episodeId.length === 0 || /[\r\n]/.test(episodeId)) {
    return invalidEpisodeVerdict(index, 'episodeId must be a non-empty string without newlines');
  }
  if (seen.has(episodeId)) {
    return invalidEpisodeVerdict(index, `duplicate episodeId '${episodeId}'`);
  }
  seen.add(episodeId);
  const verdict = (entry as { verdict?: unknown }).verdict;
  if (typeof verdict !== 'string' || !VERDICT_CLASSES.includes(verdict as (typeof VERDICT_CLASSES)[number])) {
    return invalidEpisodeVerdict(index, `verdict must be one of ${VERDICT_CLASSES.join(', ')}`);
  }
  return null;
}

function invalidEpisodeVerdict(index: number, detail: string): { ok: false; error: HandlerError } {
  return invalidSourceRef(`episodeVerdicts[${index}] ${detail}`);
}

function invalidSourceRef(detail: string): { ok: false; error: HandlerError } {
  return { ok: false, error: { status: 400, error: 'invalid_source_ref', detail } };
}

function hasParentTraversalSegment(value: string): boolean {
  return value.split(/[\\/]+/).some((segment) => segment === '..');
}
