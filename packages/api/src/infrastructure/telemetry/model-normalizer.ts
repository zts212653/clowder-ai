/**
 * F152: Model name normalization for bounded metric cardinality.
 *
 * `defaultModel` in runtime-cat-catalog is a free string — reporting
 * raw values as metric attributes would cause cardinality explosion.
 * This module buckets model names into provider+family groups.
 */

const MODEL_BUCKETS: ReadonlyArray<readonly [string, string]> = [
  ['claude-opus', 'claude-opus'],
  ['claude-sonnet', 'claude-sonnet'],
  ['claude-haiku', 'claude-haiku'],
  ['gpt-4o', 'gpt-4o'],
  ['gpt-4', 'gpt-4'],
  ['gpt-5', 'gpt-5'],
  ['o3', 'o3'],
  ['o4', 'o4'],
  ['gemini-2.5', 'gemini-2.5'],
  ['gemini-2.0', 'gemini-2.0'],
  ['qwen', 'qwen'],
];

/**
 * Normalize a raw model string into a bounded bucket.
 * Unknown models map to `'other'`.
 */
export function normalizeModel(raw: string): string {
  const lowered = raw.toLowerCase();
  for (const [prefix, bucket] of MODEL_BUCKETS) {
    if (lowered.includes(prefix)) return bucket;
  }
  return 'other';
}
