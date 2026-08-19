import { readFileSync } from 'node:fs';

/**
 * F212 Phase H AC-H10 R3 P1-C + Cloud R1 P2: sequence-aware NDJSON scanner.
 *
 * Walks the archive sorted by archived `timestamp` (NOT physical line order —
 * Codex raw archive writes are fire-and-forget append promises so line order
 * is NOT a reliable chronological sequence; empirically ~10% of real 2026-07-09
 * archives had ≥1 reordering). Tracks the LAST terminal signal seen in
 * chronological order (`turn.completed` | `turn.failed` | `__cliError`).
 *
 * Sort contract: stable ascending by numeric timestamp. Rows sharing timestamp
 * keep archived (file) order — that IS the earliest observation the archive
 * writer saw, so it's the best-effort chronological signal for ties. Records
 * with NaN timestamps sort to the end deterministically.
 *
 * Downstream decision (in reconciliation.mjs):
 *   - `finalTerminal === 'completed'` → invocation ended in recovery success →
 *     excluded from abnormal universe.
 *   - `finalTerminal === 'failed' | 'error'` AND `streamErrorCount > 0` →
 *     terminal failure → persistence required.
 */
export function scanArchiveForAbnormalExit(archivePath) {
  const text = readFileSync(archivePath, 'utf8');
  // Sol R6 P2 fix: preserve 1-based PHYSICAL line numbers so downstream error
  // messages match the actual file (`sed -n 1,10p` in editor). Blank lines are
  // still skipped for parsing but do not shift the reported line number.
  const rawLines = text.split('\n');

  /**
   * F212 Phase H Sol Final确权 P1-B (2026-07-10): fail-CLOSED on malformed input.
   * Previously JSON.parse errors were silently skipped and missing timestamps
   * became NaN sorted to the end — so an archive that contained a single
   * corrupt `__cliError` line would report `{emitted:false, streamErrorCount:0}`
   * and the reconciliation would verdict:pass, contradicting the fail-CLOSED
   * contract documented in reconciliation.mjs:10-13.
   *
   * Now every parse error and every missing/non-numeric timestamp gets
   * captured in `malformedLines` (as 1-based physical line numbers matching
   * the file on disk) and surfaced to the caller. The caller
   * (reconciliation.mjs) propagates it as verdict:error.
   */
  const malformedLines = [];
  const records = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (line.trim().length === 0) continue; // Skip blank lines silently.
    const physicalLine = i + 1; // 1-based physical line number
    let record;
    try {
      record = JSON.parse(line);
    } catch (err) {
      malformedLines.push({ line: physicalLine, reason: `JSON parse: ${err.message.slice(0, 100)}` });
      continue;
    }
    if (typeof record.timestamp !== 'number' || Number.isNaN(record.timestamp)) {
      malformedLines.push({ line: physicalLine, reason: 'missing/non-numeric timestamp' });
      continue;
    }
    records.push({ record, timestamp: record.timestamp, _orderIndex: i });
  }

  // Stable ascending sort by timestamp. Node's Array.sort has been spec-stable
  // since 2019, so equal-timestamp events keep their archived order.
  // (NaN records are now rejected upstream in malformedLines — no NaN handling here.)
  records.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    return a._orderIndex - b._orderIndex;
  });

  let emitted = false;
  let streamErrorCount = 0;
  let reasonCode;
  let finalTerminal = null;

  for (const { record } of records) {
    const payload = record.payload ?? record;
    if (payload?.type === 'error') {
      streamErrorCount++;
    }
    if (payload?.type === 'turn.completed') {
      finalTerminal = 'completed';
    } else if (payload?.type === 'turn.failed') {
      finalTerminal = 'failed';
    }
    if (payload?.__cliError === true) {
      emitted = true;
      finalTerminal = 'error';
      reasonCode = payload.cliDiagnostics?.reasonCode ?? undefined;
    }
  }

  return { emitted, streamErrorCount, finalTerminal, reasonCode, malformedLines };
}
