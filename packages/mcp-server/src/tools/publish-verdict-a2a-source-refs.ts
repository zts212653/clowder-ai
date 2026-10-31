import { z } from 'zod';

/**
 * a2a sourceRefs: basenames of pre-sanitized snapshot/attribution YAML files.
 * `kind` is OPTIONAL for backward compat (eval:a2a cats publishing without kind
 * still routes correctly through the discriminated union default).
 */
export const a2aSourceRefsShape = z
  .object({
    kind: z.literal('a2a-snapshot-attribution').optional(),
    snapshotName: z
      .string()
      .min(1)
      .describe('Basename of sanitized eval snapshot YAML inside <harnessFeedbackRoot>/snapshots/.'),
    attributionName: z
      .string()
      .min(1)
      .describe('Basename of sanitized attribution YAML inside <harnessFeedbackRoot>/attributions/.'),
    source: z
      .object({
        kind: z.literal('designated-a2a-evaluator'),
        checkoutHeadSha: z.string().regex(/^[a-f0-9]{40}$/),
        snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
        attributionSha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional()
      .describe(
        'Opt-in to declared sibling cat-cafe-eval-a2a-current; exact Git HEAD and both raw SHA256 hashes required. Never copies into runtime.',
      ),
  })
  .describe(
    'eval:a2a sourceRefs — basenames plus optional pinned designated evaluator source; omitted source reads the live root.',
  );
