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
 * The base always includes a UTC date and explicit "UTC" marker. Call sites
 * that need co-creator time-of-day semantics can pass an IANA timezone to
 * include the co-creator's local wall clock alongside UTC.
 */

function dateTimeInZone(epochMs: number, timeZone: string): string {
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

function dateKeyInZone(epochMs: number, timeZone: string): string {
  return dateTimeInZone(epochMs, timeZone).slice(0, 10);
}

function utcDateTime(epochMs: number): string {
  return `${dateTimeInZone(epochMs, 'UTC')} UTC`;
}

type IncludeAgeMode = 'always' | 'stale' | false;

export interface PromptTimeFormatOptions {
  /** IANA timezone for co-creator-local rendering. Null/empty means UTC-only. */
  timeZone?: string | null;
  /** Invocation wall-clock. When set with includeAge, the formatter appends an age. */
  nowMs?: number;
  /**
   * Age rendering mode:
   * - always: append age whenever nowMs is provided
   * - stale: append age only when the timestamp crosses the local date or threshold
   * - false/undefined: no age suffix
   */
  includeAge?: IncludeAgeMode;
  /** Staleness threshold for includeAge='stale'. Defaults to 6 hours. */
  staleThresholdMs?: number;
  /** IANA timezone used only for stale cross-date comparison. Output remains controlled by timeZone. */
  staleComparisonTimeZone?: string | null;
}

function resolvePromptTimeZone(options?: PromptTimeFormatOptions): string | null {
  const explicit = options?.timeZone?.trim();
  return explicit ? explicit : null;
}

function resolveStaleComparisonTimeZone(options?: PromptTimeFormatOptions): string {
  const explicit = options?.staleComparisonTimeZone?.trim();
  if (explicit) return explicit;
  return resolvePromptTimeZone(options) ?? 'UTC';
}

const DEFAULT_STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;

function formatAge(epochMs: number, nowMs: number): string {
  const deltaMs = Math.max(0, nowMs - epochMs);
  const totalMinutes = Math.floor(deltaMs / 60_000);
  if (totalMinutes < 1) return '<1m ago';
  if (totalMinutes < 60) return `${totalMinutes}m ago`;

  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return `${totalHours}h${minutes > 0 ? `${minutes}m` : ''} ago`;

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `${days}d${hours > 0 ? ` ${hours}h` : ''} ago`;
}

function shouldAppendAge(epochMs: number, options?: PromptTimeFormatOptions): boolean {
  if (typeof options?.nowMs !== 'number') return false;
  if (options.includeAge === 'always') return true;
  if (options.includeAge !== 'stale') return false;

  const comparisonTimeZone = resolveStaleComparisonTimeZone(options);
  const crossesDate = dateKeyInZone(epochMs, comparisonTimeZone) !== dateKeyInZone(options.nowMs, comparisonTimeZone);
  if (crossesDate) return true;

  const thresholdMs =
    typeof options.staleThresholdMs === 'number' ? options.staleThresholdMs : DEFAULT_STALE_THRESHOLD_MS;
  return options.nowMs - epochMs >= thresholdMs;
}

function withAge(base: string, epochMs: number, options?: PromptTimeFormatOptions): string {
  if (!shouldAppendAge(epochMs, options)) return base;
  if (typeof options?.nowMs !== 'number') return base;
  return `${base} · ${formatAge(epochMs, options.nowMs)}`;
}

/** Format an epoch-ms timestamp for prompt injection. */
export function formatPromptTime(epochMs: number, options?: PromptTimeFormatOptions): string {
  const utc = utcDateTime(epochMs);
  const timeZone = resolvePromptTimeZone(options);
  if (!timeZone) return withAge(utc, epochMs, options);
  return withAge(`co-creator本地 ${dateTimeInZone(epochMs, timeZone)} ${timeZone} / ${utc}`, epochMs, options);
}

/** Format a from–to range for prompt injection. */
export function formatPromptTimeRange(fromMs: number, toMs: number, options?: PromptTimeFormatOptions): string {
  const utc = `${dateTimeInZone(fromMs, 'UTC')} — ${dateTimeInZone(toMs, 'UTC')} UTC`;
  const timeZone = resolvePromptTimeZone(options);
  if (!timeZone) return utc;
  return `co-creator本地 ${dateTimeInZone(fromMs, timeZone)} — ${dateTimeInZone(toMs, timeZone)} ${timeZone} / ${utc}`;
}
