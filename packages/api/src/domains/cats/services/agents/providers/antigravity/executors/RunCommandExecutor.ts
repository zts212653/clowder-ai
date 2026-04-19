import type { TrajectoryStep } from '../AntigravityBridge.js';
import type { AntigravityToolExecutor, ExecutorContext, ExecutorResult } from './AntigravityToolExecutor.js';
import { resolveToolName } from './ExecutorRegistry.js';

export interface RunCommandInput {
  commandLine: string;
  cwd: string;
}

interface RunCommandResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

type RpcFn = (
  method: 'RunCommand',
  payload: { command: string; args?: string[]; cwd: string },
) => Promise<RunCommandResponse>;

const REDIS_SANCTUM_REASON = 'Redis 6399 is user sanctum (read-only by rule)';
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /-p\s*6399\b/i, reason: REDIS_SANCTUM_REASON },
  { pattern: /--port[=\s]+6399\b/i, reason: REDIS_SANCTUM_REASON },
  { pattern: /rediss?:\/\/[^\s"']*:6399\b/i, reason: REDIS_SANCTUM_REASON },
  { pattern: /\bport\s*:\s*6399\b/i, reason: REDIS_SANCTUM_REASON },
  { pattern: /\brm\s+-rf\s+\/(\s|$)/i, reason: 'rm -rf / is always refused' },
  { pattern: /:\(\)\{\s*:\|:/i, reason: 'fork bomb pattern refused' },
];

export class RunCommandExecutor implements AntigravityToolExecutor<RunCommandInput, { exitCode: number }> {
  readonly toolName = 'run_command';

  constructor(private readonly deps: { rpc: RpcFn }) {}

  canHandle(step: TrajectoryStep): boolean {
    return resolveToolName(step) === this.toolName;
  }

  async execute(input: RunCommandInput, ctx: ExecutorContext): Promise<ExecutorResult<{ exitCode: number }>> {
    for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
      if (pattern.test(input.commandLine)) {
        const refused: ExecutorResult<{ exitCode: number }> = { status: 'refused', reason };
        await ctx.audit.record({
          tool: this.toolName,
          cascadeId: ctx.cascadeId,
          stepIndex: ctx.stepIndex,
          input,
          result: refused,
          timestamp: new Date(),
        });
        return refused;
      }
    }

    const t0 = Date.now();
    try {
      const resp = await this.deps.rpc('RunCommand', {
        command: '/bin/sh',
        args: ['-c', input.commandLine],
        cwd: input.cwd,
      });
      const durationMs = Date.now() - t0;
      const exitCode = resp.exitCode ?? 0;
      const result: ExecutorResult<{ exitCode: number }> = {
        status: 'success',
        output: { exitCode },
        stdout: resp.stdout,
        stderr: resp.stderr,
        exitCode,
        durationMs,
      };
      await ctx.audit.record({
        tool: this.toolName,
        cascadeId: ctx.cascadeId,
        stepIndex: ctx.stepIndex,
        input,
        result,
        timestamp: new Date(),
      });
      return result;
    } catch (err) {
      const result: ExecutorResult<{ exitCode: number }> = {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t0,
      };
      await ctx.audit.record({
        tool: this.toolName,
        cascadeId: ctx.cascadeId,
        stepIndex: ctx.stepIndex,
        input,
        result,
        timestamp: new Date(),
      });
      return result;
    }
  }
}
