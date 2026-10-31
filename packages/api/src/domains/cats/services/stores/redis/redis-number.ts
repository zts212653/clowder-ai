const REDIS_NUMBER_ALIASES = new Map<string, number>([
  ['', Number.NaN],
  ['inf', Number.POSITIVE_INFINITY],
  ['+inf', Number.POSITIVE_INFINITY],
  ['-inf', Number.NEGATIVE_INFINITY],
]);

/** Decode Redis ZSCORE and persisted numeric spellings without truncation. */
export function parseRedisNumber(raw: string): number {
  const value = raw.trim();
  return REDIS_NUMBER_ALIASES.get(value) ?? Number(value);
}
