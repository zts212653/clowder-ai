import { createHash } from 'node:crypto';
import { z } from 'zod';

const timestamp = z.string().datetime({ offset: true });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const source = z
  .object({
    id: z.string().min(1).max(100),
    title: z.string().min(1).max(300),
    sourceRef: z.string().min(1).max(1000),
    revision: z.string().min(1).max(200),
    availableAt: timestamp,
    text: z.string().min(1).max(500_000),
    sha256: digest,
  })
  .strict();
const observation = z
  .object({
    sourceRef: z.string().min(1).max(1000),
    occurredAt: timestamp,
    text: z.string().min(1).max(100_000),
    sha256: digest,
  })
  .strict();

export const watcherCaseSchema = z
  .object({
    v: z.literal(1),
    id: z.string().min(1).max(100),
    group: z.enum(['debug', 'holdout', 'quiet', 'synthetic']),
    cutoffAt: timestamp,
    lastVisibleSourceRef: z.string().min(1).max(1000),
    goal: z.string().min(1).max(10_000),
    observations: z.array(observation).min(1).max(100),
    sources: z.array(source).max(100),
  })
  .strict();

export type WatcherCase = z.infer<typeof watcherCaseSchema>;
export type WatcherSource = WatcherCase['sources'][number];

export function textDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function validateWatcherCase(input: unknown): WatcherCase {
  const sample = watcherCaseSchema.parse(input);
  const cutoff = Date.parse(sample.cutoffAt);
  const ids = new Set<string>();
  for (const item of sample.sources) {
    if (ids.has(item.id)) throw new Error('duplicate_source_id');
    ids.add(item.id);
    if (Date.parse(item.availableAt) > cutoff) throw new Error('source_after_cutoff');
    if (textDigest(item.text) !== item.sha256) throw new Error('content_digest_mismatch');
  }
  let previous = -Infinity;
  let observationBytes = 0;
  for (const item of sample.observations) {
    const at = Date.parse(item.occurredAt);
    if (at > cutoff) throw new Error('observation_after_cutoff');
    if (at < previous) throw new Error('observations_out_of_order');
    if (textDigest(item.text) !== item.sha256) throw new Error('content_digest_mismatch');
    previous = at;
    observationBytes += Buffer.byteLength(item.text);
  }
  if (observationBytes > 64_000) throw new Error('observation_budget_exceeded');
  if (sample.observations.at(-1)?.sourceRef !== sample.lastVisibleSourceRef) {
    throw new Error('last_visible_source_mismatch');
  }
  return sample;
}

/** Labels must not be inferable from an empty or differently sized source catalog. */
export function validateWatcherCohort(input: unknown): WatcherCase[] {
  if (!Array.isArray(input) || !input.length || input.length > 50) throw new Error('expected_one_to_fifty_cases');
  const cases = input.map(validateWatcherCase);
  if (new Set(cases.map((item) => item.id)).size !== cases.length) throw new Error('duplicate_case_id');
  const real = cases.filter((item) => item.group !== 'synthetic');
  if (real.some((item) => item.sources.length === 0 || item.sources.length !== real[0].sources.length)) {
    throw new Error('catalog_parity_required');
  }
  return cases;
}

/** Cohort labels, expected answers and source bodies are not initial model input. */
export function watcherInput(sample: WatcherCase, reads: readonly WatcherSource[] = []) {
  return {
    cutoffAt: sample.cutoffAt,
    goal: sample.goal,
    observations: sample.observations.map(({ occurredAt, text }) => ({ occurredAt, text })),
    catalog: sample.sources.map(({ id, title }) => ({ id, title })),
    materials: reads.map(({ id, sourceRef, revision, text }) => ({ id, sourceRef, revision, text })),
  };
}
