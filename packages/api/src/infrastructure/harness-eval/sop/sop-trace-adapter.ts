/**
 * F192 E-sop AC-E17: SOP Trace Adapter.
 *
 * Builds a structured SopTrace from session commands, env snapshot, git state,
 * and handle assignments. The trace is the input to the predicate evaluator.
 *
 * NOTE: This adapter accepts pre-structured data. Integration with F153 raw
 * telemetry is a future concern — the adapter boundary is the SopTraceInput
 * interface, not raw event streams.
 */

import { z } from 'zod';

const sopTraceOrderSchema = z.object({
  eventNo: z.number().int().min(0).optional(),
  timestamp: z.number().finite().optional(),
});

const sopTraceCommandSchema = z
  .object({
    command: z.string().min(1),
    cwd: z.string().optional(),
    exitCode: z.number().int().optional(),
    stdout: z.string().optional(),
    summary: z.record(z.unknown()).optional(),
  })
  .merge(sopTraceOrderSchema);

const sopTraceChangedFileEventSchema = z
  .object({
    path: z.string().min(1),
  })
  .merge(sopTraceOrderSchema)
  .refine((event) => event.eventNo !== undefined || event.timestamp !== undefined, {
    message: 'changedFileEvents require eventNo or timestamp',
  });

const sopTraceGitStateSchema = z.object({
  branch: z.string().min(1),
  ahead: z.number().int().min(0),
  behind: z.number().int().min(0),
  clean: z.boolean(),
  worktreeRoot: z.string().optional(),
});

const sopTraceHandlesSchema = z.object({
  author: z.string().optional(),
  reviewer: z.string().optional(),
  guardian: z.string().optional(),
});

const gitShaSchema = z.string().regex(/^[0-9a-f]{40}$/, 'must be a full 40-character Git SHA');

const sopTraceDiffContextSchema = z.object({
  baseSha: gitShaSchema,
  headSha: gitShaSchema,
  files: z.array(
    z.object({
      path: z.string().min(1),
      addedLines: z.array(z.string()),
    }),
  ),
});

const designGateRiskClaimSchema = z.object({
  id: z.string(),
  kind: z.enum(['consumer_delta', 'authority_delta', 'preservation_boundary_delta']),
  summary: z.string(),
  canonicalSource: z.string(),
  consumerEvidence: z.string(),
  claimGuard: z.object({
    command: z.string(),
    redWhen: z.string(),
  }),
});

const designGateReviewPacketSchema = z.object({
  exactHeadSha: gitShaSchema,
  riskClaims: z.array(designGateRiskClaimSchema),
  targetedSelfCheckReceipts: z.array(
    z.object({
      claimId: z.string(),
      headSha: gitShaSchema,
      command: z.string(),
      exitCode: z.number().int(),
    }),
  ),
});

const sopTraceInputSchema = z
  .object({
    sessionId: z.string().min(1),
    sopDefinitionId: z.string().min(1),
    observedStage: z.string().min(1),
    commands: z.array(sopTraceCommandSchema),
    changedFiles: z.array(z.string().min(1)),
    changedFileEvents: z.array(sopTraceChangedFileEventSchema).optional(),
    envSnapshot: z.record(z.string().or(z.undefined())),
    gitState: sopTraceGitStateSchema,
    handles: sopTraceHandlesSchema,
    shaContext: z.record(z.string()),
    diffContext: sopTraceDiffContextSchema.optional(),
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
  });

function validateDesignGateTrace(
  trace: {
    changedFiles: string[];
    diffContext?: z.infer<typeof sopTraceDiffContextSchema>;
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

  const changedFiles = sortedUnique(trace.changedFiles);
  const diffPaths = diffContext.files.map((file) => file.path);
  if (new Set(diffPaths).size !== diffPaths.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['diffContext', 'files'],
      message: 'diffContext file paths must be unique',
    });
  }
  if (!sameStrings(changedFiles, sortedUnique(diffPaths))) {
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

function isConventionGraphCodeConsumers(command: string): boolean {
  return /\b(?:pnpm\s+convention-graph:code-consumers|cat-cafe-convention-graph\s+code-consumers)\b/.test(command);
}

function hasSharedOrderCoordinate(
  command: z.infer<typeof sopTraceCommandSchema>,
  changedFileEvent: z.infer<typeof sopTraceChangedFileEventSchema>,
): boolean {
  return (
    (command.eventNo !== undefined && changedFileEvent.eventNo !== undefined) ||
    (command.timestamp !== undefined && changedFileEvent.timestamp !== undefined)
  );
}

export type SopTraceCommand = z.infer<typeof sopTraceCommandSchema>;
export type SopTraceGitState = z.infer<typeof sopTraceGitStateSchema>;
export type SopTraceHandles = z.infer<typeof sopTraceHandlesSchema>;
export type SopTraceDiffContext = z.infer<typeof sopTraceDiffContextSchema>;
export type DesignGateReviewPacket = z.infer<typeof designGateReviewPacketSchema>;
export type SopTraceInput = z.infer<typeof sopTraceInputSchema>;

export interface SopTrace {
  readonly sessionId: string;
  readonly sopDefinitionId: string;
  readonly observedStage: string;
  readonly commands: readonly SopTraceCommand[];
  readonly changedFiles: readonly string[];
  readonly changedFileEvents: readonly z.infer<typeof sopTraceChangedFileEventSchema>[];
  readonly envSnapshot: Readonly<Record<string, string | undefined>>;
  readonly gitState: SopTraceGitState;
  readonly handles: SopTraceHandles;
  readonly shaContext: Readonly<Record<string, string>>;
  readonly diffContext?: SopTraceDiffContext;
  readonly designGateReviewPacket?: DesignGateReviewPacket;
}

export function validateSopTraceInput(input: unknown): string | null {
  const result = sopTraceInputSchema.safeParse(input);
  if (result.success) return null;
  return result.error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `trace.${issue.path.join('.')}` : 'trace';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

export function buildSopTrace(input: SopTraceInput): SopTrace {
  const validated = sopTraceInputSchema.parse(input);
  return {
    sessionId: validated.sessionId,
    sopDefinitionId: validated.sopDefinitionId,
    observedStage: validated.observedStage,
    commands: validated.commands,
    changedFiles: validated.changedFiles,
    changedFileEvents: validated.changedFileEvents ?? [],
    envSnapshot: validated.envSnapshot,
    gitState: validated.gitState,
    handles: validated.handles,
    shaContext: validated.shaContext,
    diffContext: validated.diffContext,
    designGateReviewPacket: validated.designGateReviewPacket,
  };
}
