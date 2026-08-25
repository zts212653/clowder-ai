import { z } from 'zod';

const fullGitSha = z.string().regex(/^[0-9a-f]{40}$/);
const canonicalRef = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => !/[\r\n\0]/.test(value), 'invalid source ref');

export const designGateEpisodeSelectorSchema = z
  .object({
    kind: z.literal('design-gate-episode-source-map'),
    sourceMapId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
  })
  .strict();

export type DesignGateEpisodeSourceSelector = z.infer<typeof designGateEpisodeSelectorSchema>;

export const designGateEpisodeSourceMapSchema = z
  .object({
    kind: z.literal('f303-design-gate-episode-source-map'),
    schemaVersion: z.literal(1),
    sourceMapId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
    window: z
      .object({
        startMs: z.number().int().nonnegative(),
        endMs: z.number().int().positive(),
      })
      .strict()
      .refine((window) => window.endMs > window.startMs, 'window.endMs must be greater than window.startMs'),
    validityResultRef: canonicalRef.optional(),
    episodes: z
      .array(
        z
          .object({
            episodeId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/),
            featureId: z.literal('F303'),
            admissionRef: canonicalRef,
            triggerContractRef: canonicalRef,
            consumerBoundaryRefs: z.array(canonicalRef).min(1),
            pullRequestRef: canonicalRef,
            exactHeadRef: canonicalRef,
            gateReceiptRef: canonicalRef,
            reviewMessageRef: canonicalRef,
            reviewVerdictRef: canonicalRef,
            landedAlphaReceiptRef: canonicalRef,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type DesignGateEpisodeSourceMap = z.infer<typeof designGateEpisodeSourceMapSchema>;
export type DesignGateEpisodeSource = DesignGateEpisodeSourceMap['episodes'][number];

const alphaConsequenceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('alpha_no_escape'),
      evidenceRef: canonicalRef,
    })
    .strict(),
  z
    .object({
      kind: z.literal('escape_observed'),
      evidenceRef: canonicalRef,
      incidentRef: canonicalRef,
      fixAttributionRef: canonicalRef,
    })
    .strict(),
]);

export const landedAlphaReceiptSchema = z
  .object({
    kind: z.literal('f303-landed-alpha-receipt'),
    schemaVersion: z.literal(1),
    receiptId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/),
    observedAt: z.string().datetime(),
    channel: z.literal('alpha'),
    landedRevision: fullGitSha,
    includedMergeRevision: fullGitSha,
    earlierSelfCheckRef: canonicalRef,
    services: z
      .array(
        z
          .object({
            name: z.enum(['api', 'web']),
            endpoint: z.string().url(),
            statusCode: z.literal(200),
          })
          .strict(),
      )
      .min(2),
    redisPort: z.literal(6398),
    consequence: alphaConsequenceSchema,
  })
  .strict();

export type LandedAlphaReceipt = z.infer<typeof landedAlphaReceiptSchema>;

export interface DesignGatePullRequestEvidence {
  repoFullName: string;
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  headSha: string;
  mergeSha: string | null;
  body: string;
  changedFiles: string[];
}

export interface DesignGatePullRequestReader {
  resolve(ref: string): Promise<DesignGatePullRequestEvidence>;
}

export interface DesignGateReviewMessage {
  id: string;
  threadId: string;
  catId: string | null;
  content: string;
  extra?: { localReviewVerdict?: { verdict?: string } };
}

export interface DesignGateReviewMessageReader {
  getById(messageId: string): DesignGateReviewMessage | null | Promise<DesignGateReviewMessage | null>;
}

export interface DesignGateGitTruth {
  isOriginMainAncestor(revision: string): Promise<boolean>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
}

export interface DesignGateEpisodeMetricVector {
  eligibleEpisodes: number;
  preReviewUniqueCatches: number | null;
  postMergeDivergenceEscapes: number;
  falsePositiveBlocks: number | null;
  extraActiveMinutes: number | null;
  extraReviewRounds: number | null;
}

export interface ResolvedDesignGateEpisode {
  episodeId: string;
  featureId: 'F303';
  authorCatId: string | null;
  reviewerCatId: string | null;
  eligibility: { eligible: boolean; trigger: 'preservation_boundary_delta' | null };
  consequence: LandedAlphaReceipt['consequence'] | null;
  sourceRefs: string[];
  validation: { status: 'valid' | 'invalid'; reasons: string[] };
}

export interface DesignGateEpisodeBundle {
  selector: DesignGateEpisodeSourceSelector;
  sourceMapRef: string;
  window: DesignGateEpisodeSourceMap['window'];
  episodes: ResolvedDesignGateEpisode[];
  vector: DesignGateEpisodeMetricVector;
  validity: {
    status: 'usable' | 'insufficient' | 'invalid';
    resultRef: string | null;
    reasons: string[];
  };
  observation: {
    status: 'observing' | 'window_mature';
    mature: boolean;
    elapsedMs: number;
    eligibleEpisodeCount: number;
    maturityRule: 'four_weeks_or_twenty_episodes';
  };
}
