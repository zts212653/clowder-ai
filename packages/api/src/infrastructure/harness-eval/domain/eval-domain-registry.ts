import { z } from 'zod';

export const evalDomainIdSchema = z
  .string()
  .regex(/^eval:[a-z0-9][a-z0-9-]*$/, 'domainId must match eval:<lowercase-slug>');

const sourceAdapterSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'sourceAdapter must be a lowercase slug-like id');

const sourceRefsKindSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'sourceRefsKind must be a lowercase slug-like id');

const metricGlossaryKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'metric glossary keys must be lowercase metric ids');

const metricGlossaryEntrySchema = z.object({
  label: z.string().min(1),
  means: z.string().min(1),
  goodDirection: z.enum(['higher', 'lower', 'neutral']),
  category: z.enum(['activation', 'friction', 'derived', 'context']).optional(),
  component: z.string().min(1).optional(),
  badWhen: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  ownerHint: z.string().min(1).optional(),
});

const metricGlossarySchema = z.record(metricGlossaryKeySchema, metricGlossaryEntrySchema);

const evalDomainFixtureSchema = z.object({
  id: z.string().min(1),
  featureId: z.string().regex(/^F\d{3}$/, 'featureId must match F followed by 3 digits'),
  path: z.string().min(1),
  skill: z.string().min(1).optional(),
  signal: z.string().min(1).optional(),
});

const evalDomainRegistryEntrySchema = z.object({
  domainId: evalDomainIdSchema,
  displayName: z.string().min(1),
  /**
   * F248 Phase A — one-line human-readable explanation of what this eval
   * domain observes, surfaced in the Eval Hub so the human (not just cats/
   * tools) can read it.
   *
   * OPTIONAL at the schema level on purpose: this is a display-surface field,
   * not a functional constraint. Making it parse-required would couple every
   * registry fixture — including description-irrelevant functional tests — to
   * this field (23 such tests broke when it was required). Production
   * completeness is enforced instead by a focused guard test over the shipped
   * `docs/harness-feedback/eval-domains/*.yaml` (ADR-031 hard layer, scoped to
   * production), not by failing unrelated unit fixtures.
   */
  descriptionForHuman: z.string().min(1).optional(),
  metricGlossary: metricGlossarySchema.optional(),
  metricGlossaryRef: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*\.metrics\.yaml$/, 'metricGlossaryRef must be a local *.metrics.yaml filename')
    .optional(),
  systemThreadId: z.string().min(1, 'systemThreadId is required'),
  evalCat: z.object({
    catId: z.string().min(1),
    handle: z.string().min(1),
    model: z.string().min(1),
  }),
  frequency: z.union([
    z.enum(['daily', 'weekly']),
    z
      .string()
      .regex(/^every-[1-9]\d*d$/, 'N-day frequency must match every-{N}d with N >= 1 (e.g. every-3d, every-7d)'),
  ]),
  sourceAdapter: sourceAdapterSchema,
  sourceRefsKind: sourceRefsKindSchema,
  threadPolicy: z.object({
    role: z.literal('working-home'),
    stateSot: z.literal('registry'),
    allowedContent: z.array(z.enum(['longitudinal-analysis', 'verdict-discussion', 'handoff-drafts'])).min(1),
  }),
  legacyScheduledTaskIds: z.array(z.string().min(1)),
  handoffTargetResolver: z.object({
    featureId: z.string().regex(/^F\d{3}$/, 'featureId must match F followed by 3 digits'),
    ownerCatId: z.string().min(1),
    threadLookup: z.literal('feature-thread'),
  }),
  sla: z.object({
    acknowledgeHours: z.number().int().positive('acknowledgeHours must be positive'),
    reevalWithinHours: z.number().int().positive('reevalWithinHours must be positive'),
  }),
  fixtures: z.array(evalDomainFixtureSchema).default([]),
  /**
   * Sunset flag. When `false`, `loadRegisteredDomains` skips this domain
   * from scheduled eval cron pickup (no invocation message lands in the
   * domain thread). Default `true`.
   *
   * Use this to silently retire a domain's auto-schedule without deleting
   * the registry entry — preserves SLA / handoffTargetResolver / threadPolicy
   * config for future re-enable (just remove the field or set `true`).
   *
   * Set to `false` when:
   * - The domain's verdict generator isn't wired (cron fires would produce
   *   empty invocations with no verdict — silent-broken).
   * - The domain is being intentionally paused while rules / wiring are reworked.
   *
   * Set on 2026-06-06 for `eval:sop` (silent-fire root cause: missing
   * sourceAdapter trace producer + missing publish_verdict generator wiring
   * — F192 doc §323 "需先加 file-writer 层 ~100-150 行"). Re-enable when
   * those gaps are closed.
   */
  enabled: z.boolean().default(true),
});

export type EvalDomainRegistryEntry = z.infer<typeof evalDomainRegistryEntrySchema>;
export type EvalMetricGlossary = z.infer<typeof metricGlossarySchema>;

export function isEvalDomainRegistryYamlFile(filename: string): boolean {
  return filename.endsWith('.yaml') && !filename.endsWith('.metrics.yaml');
}

/**
 * Single source of truth for the set of registered eval domain ids.
 * Derived from the registry schema — consumers (scheduler opts, manual trigger
 * casts, wired-publish sets) should reference THIS type instead of hand-writing
 * a union. Domain registration stays Y-lite: registry admits syntactically
 * valid ids, while runtime wiring stays explicit and fail-closed elsewhere.
 */
export type EvalDomainId = EvalDomainRegistryEntry['domainId'];

export function parseEvalDomainRegistryEntry(input: unknown): EvalDomainRegistryEntry {
  return evalDomainRegistryEntrySchema.parse(input);
}

export function parseEvalDomainRegistryFile(input: unknown): EvalDomainRegistryEntry {
  return parseEvalDomainRegistryEntry(input);
}

export function parseEvalMetricGlossary(input: unknown): EvalMetricGlossary {
  return metricGlossarySchema.parse(input);
}
