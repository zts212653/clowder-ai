import { z } from 'zod';

/** F257 Harness Ledger snapshot-first selector; keep aligned with API validation. */
export const harnessLedgerSourceRefsShape = z
  .object({
    kind: z.literal('prompt-segments'),
    windowStartMs: z.number().finite().describe('Exact inclusive epoch-ms start from the frozen snapshot.'),
    windowEndMs: z.number().finite().describe('Exact exclusive epoch-ms end from the frozen snapshot.'),
    evalRunId: z.string().regex(/^hlr-\d+-[a-f0-9]{8}$/, 'Expected hlr-<timestamp>-<hex8> snapshot identifier.'),
    guardId: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => !/[\r\n]/.test(value), 'guardId must not contain newlines')
      .optional(),
  })
  .refine((selector) => selector.windowEndMs > selector.windowStartMs, {
    message: 'windowEndMs must be greater than windowStartMs',
    path: ['windowEndMs'],
  })
  .describe('eval:harness-ledger sourceRefs — exact snapshot-first prompt-segments selector.');
