import { basename, resolve } from 'node:path';
import { resolveSafeRawPath } from '../safe-path.js';
import type { A2aSnapshotAttributionRefs, HandlerError, ResolvedSourceRefs, VerdictSourceRefs } from './types.js';

/**
 * F192 Phase H 收尾 PR-2: discriminator helper for the VerdictSourceRefs union.
 * Returns true when sourceRefs is the a2a variant (or unspecified, default a2a for backward compat).
 */
export function isA2aSourceRefs(refs: VerdictSourceRefs | undefined): refs is A2aSnapshotAttributionRefs {
  if (!refs) return true;
  if (!('kind' in refs) || refs.kind === undefined) return true;
  return refs.kind === 'a2a-snapshot-attribution';
}

/**
 * Validate sourceRefs format (presence + type + basename — no path resolution).
 * Path resolution happens inside stage callback against LIVE harnessFeedbackRoot
 * (砚砚 R17 P1 cloud: snapshots/attributions are gitignored, only in live).
 */
export function validateSourceRefsFormat(
  sourceRefs: VerdictSourceRefs | undefined,
): { ok: true } | { ok: false; error: HandlerError } {
  if (!isA2aSourceRefs(sourceRefs)) {
    return invalidSourceRef(
      `validateSourceRefsFormat called with non-a2a sourceRefs (kind=${(sourceRefs as { kind?: string }).kind ?? 'unknown'}); use isA2aSourceRefs guard before calling.`,
    );
  }
  const snap = sourceRefs?.snapshotName;
  const attr = sourceRefs?.attributionName;
  if (!snap || !attr) {
    return {
      ok: false,
      error: {
        status: 400,
        error: 'missing_evidence_refs',
        detail:
          'eval:a2a requires sourceRefs.snapshotName + .attributionName (basenames). Tool will not fabricate evidence.',
      },
    };
  }
  if (typeof snap !== 'string' || typeof attr !== 'string') {
    return invalidSourceRef(
      `sourceRefs.snapshotName + .attributionName must be strings (got ${typeof snap}, ${typeof attr})`,
    );
  }
  for (const [field, value] of [
    ['snapshotName', snap],
    ['attributionName', attr],
  ] as const) {
    if (value === '.' || value === '..' || basename(value) !== value) {
      return invalidSourceRef(`${field} invalid: must be simple basename (no path separators, no '.' / '..')`);
    }
  }
  return { ok: true };
}

export function resolveSourceRefsInRoot(
  harnessFeedbackRoot: string,
  snap: string,
  attr: string,
): { ok: true; refs: ResolvedSourceRefs } | { ok: false; reason: string } {
  const snapResult = resolveSafeRawPath(resolve(harnessFeedbackRoot, 'snapshots'), snap);
  if (!snapResult.ok) return { ok: false, reason: `snapshotName invalid: ${snapResult.reason}` };
  const attrResult = resolveSafeRawPath(resolve(harnessFeedbackRoot, 'attributions'), attr);
  if (!attrResult.ok) return { ok: false, reason: `attributionName invalid: ${attrResult.reason}` };
  return { ok: true, refs: { snapshotPath: snapResult.path, attributionPath: attrResult.path } };
}

function invalidSourceRef(detail: string): { ok: false; error: HandlerError } {
  return { ok: false, error: { status: 400, error: 'invalid_source_ref', detail } };
}
