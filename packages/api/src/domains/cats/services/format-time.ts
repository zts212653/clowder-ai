/**
 * Timezone-consistent timestamp formatting for agent prompts.
 *
 * Every timestamp injected into an agent's prompt MUST go through here so that
 * cats see one consistent, unambiguous time base. Before this module, three
 * inconsistent formats coexisted across prompt-building call sites:
 *   - `toISOString().slice(11, 16)` — UTC, but no marker (nav card / briefing)
 *   - `getHours()/getMinutes()`     — host-local, no marker (dialog history,
 *                                     thread memory, session bootstrap)
 *   - `toLocaleTimeString('en-US')` — host-local (time ranges)
 * The same instant therefore rendered differently across the nav card and the
 * dialog stream (e.g. `06:40` UTC vs `23:40` PDT — a 7h gap, neither tagged),
 * and cats could not align prompt timestamps with external UTC timestamps
 * (GitHub, verdict IDs, cron logs).
 *
 * The base is always UTC with an explicit "UTC" marker: it is the simplest to
 * align with external UTC sources, and immune to the host server's timezone.
 */

/** Internal: epoch-ms → "HH:mm" in UTC, zero-padded. */
function utcHhmm(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Format an epoch-ms timestamp as "HH:mm UTC" (e.g. "06:40 UTC"). */
export function formatPromptTime(epochMs: number): string {
  return `${utcHhmm(epochMs)} UTC`;
}

/** Format a from–to range as "HH:mm — HH:mm UTC" (single trailing marker). */
export function formatPromptTimeRange(fromMs: number, toMs: number): string {
  return `${utcHhmm(fromMs)} — ${utcHhmm(toMs)} UTC`;
}
