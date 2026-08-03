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
  })
  .superRefine((trace, ctx) => {
    const changedFileEvents = trace.changedFileEvents ?? [];
    if (changedFileEvents.length === 0) return;

    const graphCommands = trace.commands.filter((command) => isConventionGraphCodeConsumers(command.command));
    if (graphCommands.length === 0) return;
    for (const [index, changedFileEvent] of changedFileEvents.entries()) {
      if (graphCommands.some((command) => hasSharedOrderCoordinate(command, changedFileEvent))) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['changedFileEvents', index],
        message: 'convention graph commands and changedFileEvents require shared eventNo or timestamp',
      });
    }
  });

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
  };
}
