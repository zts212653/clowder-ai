import { z } from 'zod';
import {
  requestReviewHarnessStoryV3Schema,
  validateRequestReviewHarnessStoryV3,
} from './request-review-harness-lineage-v3-schema.js';

const nonempty = z.string().trim().min(1);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const exactVersion = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const memberNames = z.array(nonempty).min(1).max(32);
const commitSchema = z
  .object({
    sha,
    authoredAt: z.string().datetime({ offset: true }),
    subject: nonempty,
    members: memberNames,
  })
  .strict();
const releaseSchema = z
  .object({
    id: z.string().regex(/^H\d{2}$/),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    parent: z
      .string()
      .regex(/^H\d{2}$/)
      .nullable(),
    version: exactVersion,
    members: memberNames,
    commits: z.array(commitSchema).min(1).max(64),
  })
  .strict();
const relationSchema = z.enum([
  'citation_only',
  'discussed_delivery',
  'method_reference',
  'preserved_delivery',
  'documented_delivery',
  'later_disposition',
  'later_method_reference',
]);
const citedCommitSchema = z
  .object({
    sha: z.string().regex(/^[a-f0-9]{10}$/),
    fullSha: sha,
    authoredAt: z.string().datetime({ offset: true }),
    subject: nonempty,
    members: memberNames,
    relation: relationSchema,
  })
  .strict();
const caseSchema = z
  .object({
    caseId: nonempty.optional(),
    documentedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    occurredWindow: z.object({ start: nonempty, end: nonempty }).strict().optional(),
    kind: z.enum(['incident', 'delivery-window']),
    summary: nonempty,
    link: nonempty.nullable().optional(),
    browsingBucket: z
      .string()
      .regex(/^H\d{2}$/)
      .nullable(),
    actualUseStatus: z.literal('unconfirmed'),
    sourceTextSha256: sha256,
    citedMemberCommits: z.array(citedCommitSchema).max(32),
  })
  .strict();

// Legacy indices stay fail-closed. V3 strips extensions from the same machine skeleton and records
// their JSON Pointer paths in the publication receipt before this parser runs.
const v3ReleaseSchema = releaseSchema.extend({ commits: z.array(commitSchema.strip()).min(1).max(64) }).strip();
const v3CaseSchema = caseSchema
  .extend({
    occurredWindow: z.object({ start: nonempty, end: nonempty }).strip().optional(),
    citedMemberCommits: z.array(citedCommitSchema.strip()).max(32),
  })
  .strip();

const legacyStorySchema = z
  .object({
    updated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    overview: nonempty.max(1000).optional(),
    sources: z
      .array(
        z
          .object({
            id: nonempty,
            label: nonempty,
            path: z
              .string()
              .regex(/^(docs|cat-cafe-skills)\/[A-Za-z0-9_./#-]+$/)
              .refine((value) => !value.split('/').includes('..')),
          })
          .strict(),
      )
      .min(1)
      .max(128),
    nodes: z
      .array(
        z
          .object({
            id: nonempty,
            title: nonempty.max(240),
            when: nonempty.max(80),
            summary: nonempty.max(4000),
            parents: z
              .array(z.object({ nodeId: nonempty, sourceId: nonempty, reason: nonempty.max(2000) }).strict())
              .max(16),
            changes: z
              .array(z.object({ label: nonempty.max(240), detail: nonempty.max(2000), sourceId: nonempty }).strict())
              .max(16),
          })
          .strict(),
      )
      .min(1)
      .max(64),
    cases: z
      .array(
        z
          .object({
            caseId: nonempty,
            nodeId: nonempty,
            title: nonempty.max(80).optional(),
            problem: nonempty.max(2000),
            response: nonempty.max(2000),
            outcome: nonempty.max(400),
            sourceIds: z.array(nonempty).min(1).max(12),
          })
          .strict(),
      )
      .min(1)
      .max(128),
  })
  .strict();

function validateLegacyStory(
  story: z.infer<typeof legacyStorySchema>,
  archiveCases: z.infer<typeof caseSchema>[],
  ctx: z.RefinementCtx,
): void {
  const sources = new Set(story.sources.map((source) => source.id));
  const nodes = new Map(story.nodes.map((node) => [node.id, node]));
  const cases = new Set(archiveCases.map((entry) => entry.caseId));
  const narratives = new Set(story.cases.map((entry) => entry.caseId));
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', path: ['story'], message });
  if (sources.size !== story.sources.length || nodes.size !== story.nodes.length) invalid('duplicate story identity');
  if (
    cases.has(undefined) ||
    cases.size !== archiveCases.length ||
    narratives.size !== story.cases.length ||
    cases.size !== narratives.size ||
    [...cases].some((id) => !id || !narratives.has(id))
  )
    invalid('every archived case must have exactly one narrative');
  for (const entry of story.cases) {
    if (!nodes.has(entry.nodeId) || entry.sourceIds.some((id) => !sources.has(id)))
      invalid('case story source missing');
  }
  const completed = new Set<string>();
  const visiting = new Set<string>();
  function visit(id: string): void {
    if (completed.has(id)) return;
    if (visiting.has(id)) {
      invalid('story relationships form a cycle');
      return;
    }
    const node = nodes.get(id);
    if (!node) {
      invalid('story parent missing');
      return;
    }
    visiting.add(id);
    if (node.changes.some((change) => !sources.has(change.sourceId))) invalid('change source missing');
    for (const parent of node.parents) {
      if (!sources.has(parent.sourceId)) invalid('relationship source missing');
      visit(parent.nodeId);
    }
    visiting.delete(id);
    completed.add(id);
  }
  for (const node of story.nodes) visit(node.id);
}

const commonIndexShape = {
  status: z.enum(['owner-reviewed-source-index', 'source-backed-evolution-story']),
  snapshotCommit: sha,
  ownerReviewCommit: sha,
  ownerReviewRef: nonempty,
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  members: z.record(nonempty, z.array(nonempty).min(1).max(32)),
  releases: z.array(releaseSchema).min(1).max(128),
  cases: z.array(caseSchema).min(1).max(128),
};

const legacyIndexSchema = z
  .object({
    ...commonIndexShape,
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    story: legacyStorySchema.optional(),
  })
  .strict();

const v3IndexSchema = z
  .object({
    ...commonIndexShape,
    releases: z.array(v3ReleaseSchema).min(1).max(128),
    cases: z.array(v3CaseSchema).min(1).max(128),
    schemaVersion: z.literal(3),
    status: z.literal('source-backed-evolution-story'),
    story: requestReviewHarnessStoryV3Schema,
  })
  .strip();

export const requestReviewHarnessLineageIndexSchema = z
  .union([legacyIndexSchema, v3IndexSchema])
  .superRefine((index, ctx) => {
    const releases = new Map(index.releases.map((release) => [release.id, release]));
    if (releases.size !== index.releases.length) ctx.addIssue({ code: 'custom', message: 'duplicate history release' });
    index.releases.forEach((release, position) => {
      if (release.parent !== null)
        ctx.addIssue({
          code: 'custom',
          path: ['releases', position, 'parent'],
          message: 'calendar browsing buckets cannot claim version ancestry',
        });
    });
    index.cases.forEach((entry, position) => {
      if (!entry.browsingBucket || !releases.has(entry.browsingBucket))
        ctx.addIssue({ code: 'custom', path: ['cases', position, 'browsingBucket'], message: 'case bucket missing' });
    });
    if (index.schemaVersion === 1) {
      if (index.story || index.status !== 'owner-reviewed-source-index')
        ctx.addIssue({ code: 'custom', message: 'legacy history cannot claim a story publication' });
      return;
    }
    if (index.schemaVersion === 2) {
      if (!index.story || index.status !== 'source-backed-evolution-story') {
        ctx.addIssue({ code: 'custom', message: 'story publication missing' });
        return;
      }
      validateLegacyStory(index.story, index.cases, ctx);
      return;
    }
    const v3Story = requestReviewHarnessStoryV3Schema.safeParse(index.story);
    if (!v3Story.success) {
      ctx.addIssue({ code: 'custom', message: 'v3 story publication missing' });
      return;
    }
    validateRequestReviewHarnessStoryV3(v3Story.data, index.cases, ctx);
  });

export type RequestReviewHarnessLineageIndex = z.infer<typeof requestReviewHarnessLineageIndexSchema>;
export type RequestReviewHarnessLineageIndexLegacy = z.infer<typeof legacyIndexSchema>;
export type RequestReviewHarnessLineageIndexV3 = z.infer<typeof v3IndexSchema>;
