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

const sopTraceCommandSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  exitCode: z.number().int().optional(),
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

const sopTraceInputSchema = z.object({
  sessionId: z.string().min(1),
  sopDefinitionId: z.string().min(1),
  observedStage: z.string().min(1),
  commands: z.array(sopTraceCommandSchema),
  envSnapshot: z.record(z.string().or(z.undefined())),
  gitState: sopTraceGitStateSchema,
  handles: sopTraceHandlesSchema,
  shaContext: z.record(z.string()),
});

export type SopTraceCommand = z.infer<typeof sopTraceCommandSchema>;
export type SopTraceGitState = z.infer<typeof sopTraceGitStateSchema>;
export type SopTraceHandles = z.infer<typeof sopTraceHandlesSchema>;
export type SopTraceInput = z.infer<typeof sopTraceInputSchema>;

export interface SopTrace {
  readonly sessionId: string;
  readonly sopDefinitionId: string;
  readonly observedStage: string;
  readonly commands: readonly SopTraceCommand[];
  readonly envSnapshot: Readonly<Record<string, string | undefined>>;
  readonly gitState: SopTraceGitState;
  readonly handles: SopTraceHandles;
  readonly shaContext: Readonly<Record<string, string>>;
}

export function buildSopTrace(input: SopTraceInput): SopTrace {
  const validated = sopTraceInputSchema.parse(input);
  return {
    sessionId: validated.sessionId,
    sopDefinitionId: validated.sopDefinitionId,
    observedStage: validated.observedStage,
    commands: validated.commands,
    envSnapshot: validated.envSnapshot,
    gitState: validated.gitState,
    handles: validated.handles,
    shaContext: validated.shaContext,
  };
}
