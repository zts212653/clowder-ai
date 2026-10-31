/**
 * F212 Phase H AC-H10 R3 P1-D: strict calendar date validation via UTC round-trip.
 *
 * Regex-only shape checks (`/^\d{4}-\d{2}-\d{2}$/`) let `2026-02-30` / `2026-13-01`
 * pass because they match shape — the resulting empty window then silently
 * verdicts as pass. JS `new Date('2026-02-30')` auto-normalizes to Mar 2, so a
 * naive `!isNaN(date)` check ALSO lets bad dates through. Fix: parse Y/M/D,
 * construct via `Date.UTC`, then re-extract components and compare — any
 * overflow-normalization by JS is caught and rejected.
 */

export const YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;

/** Return true iff `str` is a real calendar date (round-trip through Date.UTC). */
export function isValidCalendarDate(str) {
  if (typeof str !== 'string' || !YYYY_MM_DD.test(str)) return false;
  const [y, m, d] = str.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Validate window bounds: shape + real calendar date + since ≤ until.
 * Returns an error string, or null if OK.
 */
export function validateWindow(windowStart, windowEnd) {
  if (typeof windowStart !== 'string' || typeof windowEnd !== 'string') {
    return 'both --since and --until are required (bounded eval — no unbounded default)';
  }
  if (!YYYY_MM_DD.test(windowStart)) {
    return `--since is not YYYY-MM-DD: ${windowStart}`;
  }
  if (!YYYY_MM_DD.test(windowEnd)) {
    return `--until is not YYYY-MM-DD: ${windowEnd}`;
  }
  if (!isValidCalendarDate(windowStart)) {
    return `--since is not a real calendar date (JS Date overflow-normalized): ${windowStart}`;
  }
  if (!isValidCalendarDate(windowEnd)) {
    return `--until is not a real calendar date (JS Date overflow-normalized): ${windowEnd}`;
  }
  if (windowStart > windowEnd) {
    return `--since (${windowStart}) is after --until (${windowEnd}) — invalid window`;
  }
  return null;
}
