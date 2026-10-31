import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { scanArchiveForAbnormalExit } from './archive-scanner.mjs';
import { validateWindow, YYYY_MM_DD } from './calendar-validation.mjs';
import { messageStoreHasErrorFor } from './message-matcher.mjs';

/**
 * F212 Phase H AC-H10 R1..R3: main reconciliation walk.
 *
 * Fail-CLOSED contract:
 *   • BOTH sources must exist (archive dir + message store path).
 *   • Window must be explicit YYYY-MM-DD with real calendar dates, since ≤ until.
 *   • Any missing/malformed input → `verdict: error`, non-zero exit.
 *
 * Sequence-aware contract (R3 P1-C):
 *   • `finalTerminal === 'completed'` → recovered (invoke-single-cat transient
 *     retry succeeded) → excluded from abnormal universe, surfaced as `recovered[]`.
 *   • Other terminals + streamErrorCount>0 → require persisted F212 error.
 */
export function runReconciliation({ archiveDir, messageStorePath, windowStart, windowEnd }) {
  const errBase = (err) => ({
    windowStart,
    windowEnd,
    totalAbnormalExits: 0,
    matched: [],
    unmatched: [],
    recovered: [],
    verdict: 'error',
    error: err,
  });

  const windowError = validateWindow(windowStart, windowEnd);
  if (windowError) return errBase(windowError);

  if (typeof archiveDir !== 'string' || !archiveDir) return errBase('archive-dir is required');
  if (typeof messageStorePath !== 'string' || !messageStorePath) return errBase('message-store is required');
  if (!existsSync(archiveDir)) return errBase(`archive directory does not exist: ${archiveDir}`);
  if (!existsSync(messageStorePath)) return errBase(`message store path does not exist: ${messageStorePath}`);

  const matched = [];
  const unmatched = [];
  /** R3 P1-C: recovered invocations surfaced separately for visibility. */
  const recovered = [];
  let totalAbnormalExits = 0;

  const dayDirs = readdirSync(archiveDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && YYYY_MM_DD.test(d.name))
    .filter((d) => d.name >= windowStart && d.name <= windowEnd)
    .map((d) => join(archiveDir, d.name));

  for (const dayDir of dayDirs) {
    const groups = new Map();
    for (const file of readdirSync(dayDir).sort()) {
      if (!/\.ndjson(?:\.gz)?$/.test(file)) continue;
      const invocationId = file.replace(/\.ndjson(?:\.gz)?$/, '');
      const paths = groups.get(invocationId) ?? [];
      paths.push(join(dayDir, file));
      groups.set(invocationId, paths);
    }
    for (const [invocationId, paths] of groups) {
      let scan;
      try {
        scan = scanArchiveForAbnormalExit(paths);
      } catch (error) {
        return errBase(`cannot read archive ${invocationId}: ${error.message}`);
      }
      // Sol Final确权 P1-B: fail-CLOSED on malformed archive lines. Silent skip
      // let a corrupt `__cliError` line masquerade as an empty archive → verdict:pass.
      // Now propagates structured error with concrete file + line pointers.
      if (scan.malformedLines && scan.malformedLines.length > 0) {
        return {
          windowStart,
          windowEnd,
          totalAbnormalExits,
          matched,
          unmatched,
          recovered,
          verdict: 'error',
          error: `malformed archive line(s) for ${invocationId}: ${scan.malformedLines
            .slice(0, 3)
            .map((m) => `${basename(m.file)} line ${m.line}: ${m.reason}`)
            .join('; ')}${scan.malformedLines.length > 3 ? ` (+${scan.malformedLines.length - 3} more)` : ''}`,
        };
      }
      if (!scan.emitted || scan.streamErrorCount === 0) continue;
      if (scan.finalTerminal === 'completed') {
        recovered.push({ invocationId, streamErrorCount: scan.streamErrorCount, reasonCode: scan.reasonCode });
        continue;
      }
      totalAbnormalExits++;
      const lookup = messageStoreHasErrorFor(messageStorePath, invocationId);
      if (!lookup.ok) {
        return {
          windowStart,
          windowEnd,
          totalAbnormalExits,
          matched,
          unmatched,
          recovered,
          verdict: 'error',
          error: lookup.reason ?? 'message store lookup failed',
        };
      }
      if (lookup.found) {
        matched.push({ invocationId, streamErrorCount: scan.streamErrorCount, reasonCode: scan.reasonCode });
      } else {
        unmatched.push({ invocationId, streamErrorCount: scan.streamErrorCount, reasonCode: scan.reasonCode });
      }
    }
  }

  return {
    windowStart,
    windowEnd,
    totalAbnormalExits,
    matched,
    unmatched,
    recovered,
    verdict: unmatched.length === 0 ? 'pass' : 'fail',
  };
}
