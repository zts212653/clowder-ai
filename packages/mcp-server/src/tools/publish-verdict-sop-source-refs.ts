import { z } from 'zod';

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
  };
};
