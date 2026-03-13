/**
 * Parse a string into one of the allowed enum values (case-insensitive).
 * Returns {@link fallback} when the input is missing or not in the allowed list.
 */
export function parseEnum<T extends string>(raw: string | undefined, allowed: readonly T[], fallback: T): T {
  if (raw == null || raw.trim() === '') return fallback;
  const normalized = raw.trim().toLowerCase() as T;
  return allowed.includes(normalized) ? normalized : fallback;
}

/**
 * Parse a string as a boolean (`"true"` / `"false"`, case-insensitive).
 * Returns {@link fallback} for missing or unrecognised values.
 */
export function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return fallback;
}

/**
 * Parse a string as an integer, clamped to `[min, max]`.
 * Returns {@link fallback} when the input is missing, non-numeric, or out of range.
 */
export function parseIntInRange(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const truncated = Math.trunc(parsed);
  if (truncated < min || truncated > max) return fallback;
  return truncated;
}

/**
 * Parse a comma-separated string into a deduplicated list of allowed enum values.
 * Returns {@link fallback} when no valid values are found.
 */
export function parseCsvEnumList<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: readonly T[],
): T[] {
  const parsed = (raw ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase() as T)
    .filter((v): v is T => allowed.includes(v));

  const normalized = Array.from(new Set(parsed));
  return normalized.length > 0 ? normalized : [...fallback];
}
