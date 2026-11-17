/**
 * The recent index's `since` window syntax, shared by its HTTP route and the find entry that forwards to it.
 *
 * Accepts a relative window of 1–5 digits in days or hours (`7d`, `24h`, at most `99999d` ≈ 273 years) or an
 * anchored ISO 8601 date / date-time (`2026-05-01`, `2026-05-01T08:00+14:00`). Anything else is rejected rather than
 * compared as a string: `tomorrow` / `7days` would silently produce wrong slices (砚砚 cloud-7/10 P2), an unbounded
 * digit count overflows Date arithmetic and throws on toISOString (cloud-11 P2), and `Date.parse` alone accepts
 * trailing garbage such as `2026-11-01junk` in some runtimes.
 */
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const RELATIVE_SINCE_RE = /^(\d{1,5})([dh])$/;

export function isValidRecentSince(since: string): boolean {
  if (RELATIVE_SINCE_RE.test(since)) return true;
  if (!ISO_8601_RE.test(since)) return false;
  return !Number.isNaN(Date.parse(since));
}

/** A valid `since` as its exact ISO lower bound (UTC); callers validate with isValidRecentSince first. */
export function recentSinceToIso(since: string, now = Date.now()): string {
  const relative = RELATIVE_SINCE_RE.exec(since);
  if (!relative) return new Date(Date.parse(since)).toISOString();
  const unitMs = relative[2] === 'd' ? 86_400_000 : 3_600_000;
  return new Date(now - Number(relative[1]) * unitMs).toISOString();
}
