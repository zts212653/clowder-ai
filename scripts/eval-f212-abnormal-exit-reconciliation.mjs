#!/usr/bin/env node

/**
 * F212 Phase H AC-H10 — CLI entrypoint for the bounded reconciliation eval.
 *
 * Asserts the Phase H architectural invariant:
 *   ∀ (invocationId): if cli-spawn / tmux-agent-spawner emit an abnormal CLI exit
 *   with `streamErrorCount > 0` AND the invocation ends in a terminal failure
 *   (final terminal signal is not `turn.completed`), THEN a persisted F212 error
 *   message must exist for the same invocationId. Any unmatched abnormal exit =
 *   verdict fail = silent-false-success regression re-introduced.
 *
 * The eval was split across four modules (cloud R4 P1 — AGENTS.md 350-line hard cap):
 *   - `eval-f212-reconciliation/calendar-validation.mjs` — R3 P1-D UTC round-trip
 *   - `eval-f212-reconciliation/archive-scanner.mjs` — R3 P1-C sequence-aware
 *   - `eval-f212-reconciliation/message-matcher.mjs` — R2 P1-B strict shape
 *   - `eval-f212-reconciliation/reconciliation.mjs` — R1..R3 fail-CLOSED walk
 *
 * Full contract history (R1 P1-4 + R2 P1-A/B + R3 P1-C/D + cloud R1 P2 timestamp
 * sort) documented in each module. This entrypoint is only the CLI shell.
 *
 * Usage:
 *   node scripts/eval-f212-abnormal-exit-reconciliation.mjs \
 *     --archive-dir=/path/to/cli-raw-archive \
 *     --message-store=/path/to/message-store.jsonl \
 *     --since=2026-07-09 --until=2026-07-10
 */

export { scanArchiveForAbnormalExit } from './eval-f212-reconciliation/archive-scanner.mjs';
// Re-export for backwards compatibility with existing imports (tests + adapter).
export { isValidCalendarDate } from './eval-f212-reconciliation/calendar-validation.mjs';
export { isPersistedF212ErrorFor, messageStoreHasErrorFor } from './eval-f212-reconciliation/message-matcher.mjs';
export { runReconciliation } from './eval-f212-reconciliation/reconciliation.mjs';

import { runReconciliation } from './eval-f212-reconciliation/reconciliation.mjs';

function parseArgs(argv) {
  const opts = {};
  for (const arg of argv.slice(2)) {
    const m = /^--([\w-]+)=(.*)$/.exec(arg);
    if (m) opts[m[1]] = m[2];
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv);
  const archiveDir = opts['archive-dir'];
  const messageStorePath = opts['message-store'];
  const windowStart = opts.since;
  const windowEnd = opts.until;

  if (!archiveDir || !messageStorePath || !windowStart || !windowEnd) {
    console.error(
      'Usage: eval-f212-abnormal-exit-reconciliation --archive-dir=<dir> --message-store=<path> --since=YYYY-MM-DD --until=YYYY-MM-DD',
    );
    console.error('All four flags are required (bounded eval — no unbounded default window).');
    process.exit(2);
  }

  const result = runReconciliation({ archiveDir, messageStorePath, windowStart, windowEnd });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.verdict === 'pass' ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
