import { z } from 'zod';

const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1_000;

export const trajectoryInspectorSourceRefsShape = z
  .object({
    kind: z.literal('trajectory-inspector-window'),
    windowStartMs: z.number().int().nonnegative().describe('Inclusive owner-scoped transcript window start.'),
    windowEndMs: z.number().int().positive().describe('Exclusive owner-scoped transcript window end.'),
  })
  .strict()
  .superRefine((selector, ctx) => {
    if (selector.windowEndMs <= selector.windowStartMs) {
      ctx.addIssue({ code: 'custom', path: ['windowEndMs'], message: 'windowEndMs must exceed windowStartMs' });
    }
    if (selector.windowEndMs - selector.windowStartMs > MAX_WINDOW_MS) {
      ctx.addIssue({ code: 'custom', path: ['windowEndMs'], message: 'window must not exceed 31 days' });
    }
  })
  .describe(
    'eval:trajectory-inspector sourceRefs — bounded server-resolved transcript window; caller-authored episodes are forbidden.',
  );
