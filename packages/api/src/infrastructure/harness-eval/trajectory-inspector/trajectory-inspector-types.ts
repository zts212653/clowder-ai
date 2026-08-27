import { z } from 'zod';

export const trajectoryInspectorCanonicalEvidenceRefSchema = z
  .string()
  .regex(/^(inv|thread|session|snapshot|attribution):[^\r\n\0]+$/, 'unsupported canonical evidence ref');

export const trajectoryInspectorOutcomeSchema = z.enum(['accepted', 'unresolved', 'not_taken', 'wrong_ref']);

export const trajectoryInspectorEpisodeSchema = z
  .object({
    episodeId: z.string().regex(/^trajectory:[^\r\n\0]+$/),
    invocationId: z.string().min(1),
    threadId: z.string().min(1),
    sessionId: z.string().min(1),
    eligibleAtMs: z.number().int().nonnegative(),
    eligibility: z.array(z.enum(['terminal_anomaly', 'f192_invocation_finding'])).min(1),
    anomalyKind: z.enum(['error', 'cancelled', 'timeout', 'finding']),
    model: z.string().min(1).optional(),
    runtime: z.string().min(1).optional(),
    firstAcceptedEvidenceAtMs: z.number().int().nonnegative().nullable(),
    evidenceOutcome: trajectoryInspectorOutcomeSchema,
    rawOrJsonlFallback: z.boolean(),
    reviewerAgreement: z.enum(['agreed', 'disagreed', 'unreviewed']),
    sourceRefs: z.array(trajectoryInspectorCanonicalEvidenceRefSchema).min(1),
  })
  .strict()
  .superRefine((episode, ctx) => {
    if (episode.episodeId !== `trajectory:${episode.invocationId}`) {
      ctx.addIssue({ code: 'custom', path: ['episodeId'], message: 'episodeId must derive from invocationId' });
    }
    if (episode.evidenceOutcome === 'accepted' && episode.firstAcceptedEvidenceAtMs === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['firstAcceptedEvidenceAtMs'],
        message: 'accepted evidence requires a timestamp',
      });
    }
    if (episode.evidenceOutcome !== 'accepted' && episode.firstAcceptedEvidenceAtMs !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['firstAcceptedEvidenceAtMs'],
        message: 'only accepted evidence may carry a timestamp',
      });
    }
    if (episode.firstAcceptedEvidenceAtMs !== null && episode.firstAcceptedEvidenceAtMs < episode.eligibleAtMs) {
      ctx.addIssue({
        code: 'custom',
        path: ['firstAcceptedEvidenceAtMs'],
        message: 'accepted evidence must not precede eligibility',
      });
    }
  });

export type TrajectoryInspectorOutcome = z.infer<typeof trajectoryInspectorOutcomeSchema>;
export type TrajectoryInspectorEpisode = z.infer<typeof trajectoryInspectorEpisodeSchema>;

const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1_000;

export const trajectoryInspectorWindowSelectorSchema = z
  .object({
    kind: z.literal('trajectory-inspector-window'),
    windowStartMs: z.number().int().nonnegative(),
    windowEndMs: z.number().int().positive(),
  })
  .strict()
  .superRefine((selector, ctx) => {
    if (selector.windowEndMs <= selector.windowStartMs) {
      ctx.addIssue({ code: 'custom', path: ['windowEndMs'], message: 'windowEndMs must exceed windowStartMs' });
    }
    if (selector.windowEndMs - selector.windowStartMs > MAX_WINDOW_MS) {
      ctx.addIssue({ code: 'custom', path: ['windowEndMs'], message: 'window must not exceed 31 days' });
    }
  });

export type TrajectoryInspectorWindowSelector = z.infer<typeof trajectoryInspectorWindowSelectorSchema>;

export function validateTrajectoryInspectorWindowSelector(input: unknown): string | null {
  const parsed = trajectoryInspectorWindowSelectorSchema.safeParse(input);
  return parsed.success
    ? null
    : parsed.error.issues.map((issue) => `${issue.path.join('.') || 'selector'}: ${issue.message}`).join('; ');
}

export const trajectoryInspectorSourceHealthSchema = z
  .object({
    canonicalResolvedEpisodes: z.number().int().nonnegative(),
    canonicalCandidateEpisodes: z.number().int().nonnegative(),
    significantModelRuntimeDrift: z.boolean(),
    comparableBaseline: z.boolean(),
  })
  .strict()
  .superRefine((health, ctx) => {
    if (health.canonicalResolvedEpisodes > health.canonicalCandidateEpisodes) {
      ctx.addIssue({
        code: 'custom',
        path: ['canonicalResolvedEpisodes'],
        message: 'resolved canonical episodes cannot exceed candidates',
      });
    }
  });

export type TrajectoryInspectorSourceHealth = z.infer<typeof trajectoryInspectorSourceHealthSchema>;

export interface TrajectoryInspectorVector {
  eligibleEpisodes: number;
  accepted: number;
  unresolved: number;
  notTaken: number;
  wrongRef: number;
  timeToFirstAcceptedEvidenceMs: number[];
  rawOrJsonlFallbackCount: number;
}

export interface TrajectoryInspectorReduction {
  episodes: TrajectoryInspectorEpisode[];
  vector: TrajectoryInspectorVector;
  validity: {
    status: 'usable' | 'calibration_only' | 'invalid';
    reasons: string[];
    canonicalCoverage: number;
    reviewerDisagreementRate: number | null;
  };
  stopUtilityConclusion: boolean;
}

export interface TrajectoryInspectorSourceHealthDetail extends TrajectoryInspectorSourceHealth {
  missingTranscriptSessions: number;
  modelRuntimeFingerprints: string[];
}

export interface TrajectoryInspectorEpisodeBundle extends TrajectoryInspectorReduction {
  selector: TrajectoryInspectorWindowSelector;
  sourceHealth: TrajectoryInspectorSourceHealthDetail;
}
