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
 * The base always includes UTC with an explicit "UTC" marker. Call sites that
 * need co-creator time-of-day semantics can pass an IANA timezone to include
 * the co-creator's local wall clock alongside UTC.
 */

/** Internal: epoch-ms → "HH:mm" in UTC, zero-padded. */
function utcHhmm(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function localDateTime(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get('year')}-${byType.get('month')}-${byType.get('day')} ${byType.get('hour')}:${byType.get('minute')}`;
}

export interface PromptTimeFormatOptions {
  /** IANA timezone for co-creator-local rendering. Null/empty means UTC-only. */
  timeZone?: string | null;
}

function resolvePromptTimeZone(options?: PromptTimeFormatOptions): string | null {
  const explicit = options?.timeZone?.trim();
  return explicit ? explicit : null;
}

/** Format an epoch-ms timestamp for prompt injection. */
export function formatPromptTime(epochMs: number, options?: PromptTimeFormatOptions): string {
  const utc = `${utcHhmm(epochMs)} UTC`;
  const timeZone = resolvePromptTimeZone(options);
  if (!timeZone) return utc;
  return `co-creator本地 ${localDateTime(epochMs, timeZone)} ${timeZone} / ${utc}`;
}

/** Format a from–to range for prompt injection. */
export function formatPromptTimeRange(fromMs: number, toMs: number, options?: PromptTimeFormatOptions): string {
  const utc = `${utcHhmm(fromMs)} — ${utcHhmm(toMs)} UTC`;
  const timeZone = resolvePromptTimeZone(options);
  if (!timeZone) return utc;
  return `co-creator本地 ${localDateTime(fromMs, timeZone)} — ${localDateTime(toMs, timeZone)} ${timeZone} / ${utc}`;
}
