/**
 * F192 E-community AC-E14: Community Eval Domain schema + filesystem loader.
 *
 * Enables community projects to register custom eval domains via YAML without
 * forking Clowder AI core. Community domains use relaxed validation:
 * - domainId: any `eval:<lowercase-slug>` (not restricted to internal enum)
 * - sourceAdapter: must be `community-custom` (not internal adapter names)
 * - handoffTargetResolver: optional (community may not have Clowder AI feature threads)
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// ---- Schema ----

const communityEvalDomainEntrySchema = z.object({
  /** Domain identifier — must start with `eval:` followed by lowercase slug. */
  domainId: z
    .string()
    .regex(
      /^eval:[a-z][a-z0-9_-]*$/,
      'domainId must start with eval: followed by lowercase alphanumeric (hyphens/underscores allowed)',
    ),

  /** Human-readable domain name for UI display. */
  displayName: z.string().min(1),

  /** System thread ID for this domain's eval context. */
  systemThreadId: z.string().min(1),

  /** Assigned evaluator cat. */
  evalCat: z.object({
    catId: z.string().min(1),
    handle: z.string().min(1),
    model: z.string().min(1),
  }),

  /** Scheduling frequency. */
  frequency: z.enum(['daily', 'weekly']),

  /** Must be 'community-custom' — community domains don't use internal adapters. */
  sourceAdapter: z.literal('community-custom'),

  /** Thread policy (same structure as internal domains). */
  threadPolicy: z.object({
    role: z.literal('working-home'),
    stateSot: z.literal('registry'),
    allowedContent: z.array(z.string().min(1)).min(1),
  }),

  /** Legacy task IDs to sunset (typically empty for new community domains). */
  legacyScheduledTaskIds: z.array(z.string()).default([]),

  /** Optional: community domains may not have Clowder AI feature thread targets. */
  handoffTargetResolver: z
    .object({
      featureId: z.string().min(1),
      ownerCatId: z.string().min(1),
      threadLookup: z.literal('feature-thread'),
    })
    .optional(),

  /** SLA for acknowledge and reevaluation. */
  sla: z.object({
    acknowledgeHours: z.number().int().positive(),
    reevalWithinHours: z.number().int().positive(),
  }),
});

export type CommunityEvalDomainEntry = z.infer<typeof communityEvalDomainEntrySchema>;

// ---- Parse ----

export function parseCommunityEvalDomainEntry(input: unknown): CommunityEvalDomainEntry {
  return communityEvalDomainEntrySchema.parse(input);
}

// ---- Filesystem loader ----

/**
 * Reads all `.yaml` files from the given directory and validates each as a
 * CommunityEvalDomainEntry. Returns empty array if directory doesn't exist.
 *
 * Throws on invalid YAML content (fail-fast — community domain authors get
 * immediate feedback on schema violations).
 */
export function loadCommunityDomains(communityDomainsDir: string): CommunityEvalDomainEntry[] {
  if (!existsSync(communityDomainsDir)) return [];

  const entries = readdirSync(communityDomainsDir, { withFileTypes: true });
  const yamlFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.yaml'));

  if (yamlFiles.length === 0) return [];

  return yamlFiles.map((file) => {
    const content = readFileSync(join(communityDomainsDir, file.name), 'utf8');
    const raw = parseYaml(content);
    return parseCommunityEvalDomainEntry(raw);
  });
}
