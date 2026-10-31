import { z } from 'zod';

const gitShaSchema = z.string().regex(/^[0-9a-f]{40}$/, 'must be a full 40-character Git SHA');

const diffContextSchema = z.object({
  baseSha: gitShaSchema,
  headSha: gitShaSchema,
  files: z.array(
    z.object({
      path: z.string().min(1),
      addedLines: z.array(z.string()),
    }),
  ),
});

const designGateReviewPacketSchema = z.object({
  exactHeadSha: gitShaSchema,
  riskClaims: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['consumer_delta', 'authority_delta', 'preservation_boundary_delta']),
      summary: z.string(),
      canonicalSource: z.string(),
      consumerEvidence: z.string(),
      claimGuard: z.object({
        command: z.string(),
        redWhen: z.string(),
      }),
    }),
  ),
  targetedSelfCheckReceipts: z.array(
    z.object({
      claimId: z.string(),
      headSha: gitShaSchema,
      command: z.string(),
      exitCode: z.number().int(),
    }),
  ),
});

/**
 * F192 sop-wiring — replayable SOP trace selector. Eval cat builds the trace
 * from session observation; generator replays evaluation via predicate evaluator
 * and writes provenance artifacts. Trace is embedded (no persistent SOP trace
 * store yet), so the selector carries the full SopTraceInput.
 *
 * KEEP IN SYNC: packages/api/src/infrastructure/harness-eval/sop/sop-trace-adapter.ts sopTraceInputSchema.
 */
export const sopSourceRefsShape = z
  .object({
    kind: z.literal('sop-trace-eval'),
    sopDefinitionId: z
      .string()
      .min(1)
      .describe(
        'SOP definition to evaluate against (e.g. "development"). Must match a known definition in the catalog.',
      ),
    trace: z
      .object({
        sessionId: z.string().min(1),
        sopDefinitionId: z.string().min(1),
        observedStage: z.string().min(1),
        commands: z.array(
          z.object({
            command: z.string().min(1),
            cwd: z.string().optional(),
            exitCode: z.number().int().optional(),
            eventNo: z.number().int().min(0).optional(),
            timestamp: z.number().finite().optional(),
            stdout: z.string().optional(),
            summary: z.record(z.unknown()).optional(),
          }),
        ),
        changedFiles: z.array(z.string().min(1)),
        changedFileEvents: z
          .array(
            z
              .object({
                path: z.string().min(1),
                eventNo: z.number().int().min(0).optional(),
                timestamp: z.number().finite().optional(),
              })
              .refine((event) => event.eventNo !== undefined || event.timestamp !== undefined, {
                message: 'changedFileEvents require eventNo or timestamp',
              }),
          )
          .optional(),
        envSnapshot: z.record(z.string().or(z.undefined())),
        gitState: z.object({
          branch: z.string().min(1),
          ahead: z.number().int().min(0),
          behind: z.number().int().min(0),
          clean: z.boolean(),
          worktreeRoot: z.string().optional(),
        }),
        handles: z.object({
          author: z.string().optional(),
          reviewer: z.string().optional(),
          guardian: z.string().optional(),
        }),
        shaContext: z.record(z.string()),
        diffContext: diffContextSchema.optional(),
        designGateReviewPacket: designGateReviewPacketSchema.optional(),
      })
      .superRefine((trace, ctx) => {
        const changedFileEvents = trace.changedFileEvents ?? [];
        if (changedFileEvents.length > 0) {
          const graphCommands = trace.commands.filter((command) => isConventionGraphCodeConsumers(command.command));
          if (graphCommands.length > 0) {
            for (const [index, changedFileEvent] of changedFileEvents.entries()) {
              if (graphCommands.some((command) => hasSharedOrderCoordinate(command, changedFileEvent))) continue;
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['changedFileEvents', index],
                message: 'convention graph commands and changedFileEvents require shared eventNo or timestamp',
              });
            }
          }
        }

        validateDesignGateTrace(trace, ctx);
      })
      .describe('Full SopTrace data for deterministic replay. See eval cat invocation instructions for field details.'),
  })
  .describe('eval:sop sourceRefs — replayable SOP trace selector (sopDefinitionId + embedded trace).');

function isConventionGraphCodeConsumers(command: string): boolean {
  return /\b(?:pnpm\s+convention-graph:code-consumers|cat-cafe-convention-graph\s+code-consumers)\b/.test(command);
}

function hasSharedOrderCoordinate(
  command: { eventNo?: number; timestamp?: number },
  changedFileEvent: { eventNo?: number; timestamp?: number },
): boolean {
  return (
    (command.eventNo !== undefined && changedFileEvent.eventNo !== undefined) ||
    (command.timestamp !== undefined && changedFileEvent.timestamp !== undefined)
  );
}

function validateDesignGateTrace(
  trace: {
    changedFiles: string[];
    diffContext?: z.infer<typeof diffContextSchema>;
    designGateReviewPacket?: z.infer<typeof designGateReviewPacketSchema>;
  },
  ctx: z.RefinementCtx,
): void {
  const diffContext = trace.diffContext;
  const packet = trace.designGateReviewPacket;
  if (!diffContext) {
    if (packet) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['designGateReviewPacket'],
        message: 'designGateReviewPacket requires diffContext exact HEAD evidence',
      });
    }
    return;
  }

  if (diffContext.baseSha === diffContext.headSha) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['diffContext', 'headSha'],
      message: 'diffContext baseSha and headSha must differ',
    });
  }

  const diffPaths = diffContext.files.map((file) => file.path);
  if (new Set(diffPaths).size !== diffPaths.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['diffContext', 'files'],
      message: 'diffContext file paths must be unique',
    });
  }
  if (!sameStrings(sortedUnique(trace.changedFiles), sortedUnique(diffPaths))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['diffContext', 'files'],
      message: 'diffContext files and changedFiles must describe the same path set',
    });
  }

  if (!packet) return;
  if (packet.exactHeadSha !== diffContext.headSha) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['designGateReviewPacket', 'exactHeadSha'],
      message: 'designGateReviewPacket exactHeadSha must match diffContext headSha exact HEAD',
    });
  }
  const claimIds = packet.riskClaims.map((claim) => claim.id);
  if (new Set(claimIds).size !== claimIds.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['designGateReviewPacket', 'riskClaims'],
      message: 'design-gate risk claim ids must be unique',
    });
  }
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export type SopTraceEvalSourceRefs = {
  kind: 'sop-trace-eval';
  sopDefinitionId: string;
  trace: {
    sessionId: string;
    sopDefinitionId: string;
    observedStage: string;
    commands: Array<{
      command: string;
      cwd?: string;
      exitCode?: number;
      eventNo?: number;
      timestamp?: number;
      stdout?: string;
      summary?: Record<string, unknown>;
    }>;
    changedFiles: string[];
    changedFileEvents?: Array<{ path: string; eventNo?: number; timestamp?: number }>;
    envSnapshot: Record<string, string | undefined>;
    gitState: { branch: string; ahead: number; behind: number; clean: boolean; worktreeRoot?: string };
    handles: { author?: string; reviewer?: string; guardian?: string };
    shaContext: Record<string, string>;
    diffContext?: {
      baseSha: string;
      headSha: string;
      files: Array<{ path: string; addedLines: string[] }>;
    };
    designGateReviewPacket?: {
      exactHeadSha: string;
      riskClaims: Array<{
        id: string;
        kind: 'consumer_delta' | 'authority_delta' | 'preservation_boundary_delta';
        summary: string;
        canonicalSource: string;
        consumerEvidence: string;
        claimGuard: { command: string; redWhen: string };
      }>;
      targetedSelfCheckReceipts: Array<{
        claimId: string;
        headSha: string;
        command: string;
        exitCode: number;
      }>;
    };
  };
};
