import path from 'node:path';
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
  payload: { command: string; args?: string[]; cwd: string; timeoutMs?: number },
  options?: { signal?: AbortSignal },
) => Promise<RunCommandResponse>;

export const DEFAULT_RUN_COMMAND_TIMEOUT_MS = 600_000;
export const MAX_RUN_COMMAND_TIMEOUT_MS = 3_600_000;
const RUN_COMMAND_TIMEOUT_ENV = 'ANTIGRAVITY_RUN_COMMAND_TIMEOUT_MS';
const REDIS_SANCTUM_REASON = 'Redis 6399 is user sanctum (read-only by rule)';
const RM_RECURSIVE_ROOT_REASON = 'recursive root delete is always refused';
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /-p\s*6399\b/i, reason: REDIS_SANCTUM_REASON },
  { pattern: /--port[=\s]+6399\b/i, reason: REDIS_SANCTUM_REASON },
  { pattern: /rediss?:\/\/[^\s"']*:6399\b/i, reason: REDIS_SANCTUM_REASON },
  { pattern: /\bport\s*:\s*6399\b/i, reason: REDIS_SANCTUM_REASON },
  { pattern: /:\(\)\{\s*:\|:/i, reason: 'fork bomb pattern refused' },
];
// Any shell control syntax makes the command unsafe for automatic replay.
// Keep these guards more explicit than the whitelist itself: if we are unsure
// whether the shell will evaluate something dynamically, we do not treat it as
// read-only.
const SHELL_CONTROL_PATTERN = /[><|;&]/;
const SHELL_SUBSTITUTION_PATTERN = /[`]/;
const SHELL_NEWLINE_PATTERN = /[\n\r]/;
const SHELL_VARIABLE_EXPANSION_PATTERN = /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[^}]+\})/;
const READ_ONLY_PATTERNS: RegExp[] = [
  /^\s*pwd(?:\s|$)/i,
  /^\s*ls(?:\s|$)/i,
  /^\s*cat\s+[^><|;&]+$/i,
  // Keep the git whitelist intentionally narrow: `git branch` is excluded
  // because flags like -d/-m/-c mutate refs, and we only auto-retry commands
  // we can prove are read-only.
  /^\s*git\s+(log|status|rev-parse)(?:\s|$)/i,
  /^\s*git\s+diff(?:\s|$)/i,
  /^\s*git\s+show(?:\s|$)/i,
];

function tokenizeShellLike(segment: string): string[] {
  const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g);
  if (!tokens) return [];
  return tokens.map((token) => {
    if (token.startsWith('"') && token.endsWith('"')) return token.slice(1, -1);
    if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1);
    return token;
  });
}

function isRmRecursiveForceFlag(token: string): { recursive: boolean; force: boolean } {
  if (!/^-[A-Za-z]+$/.test(token)) return { recursive: false, force: false };
  return {
    recursive: /[rR]/.test(token),
    force: /f/.test(token),
  };
}

function isRootDeleteTarget(token: string): boolean {
  const withoutTrailingGlob = token.endsWith('/*') ? token.slice(0, -1) : token;
  return path.posix.normalize(withoutTrailingGlob) === '/';
}

function isRmCommandToken(token: string): boolean {
  return path.posix.basename(token.replaceAll('\\', '/')).toLowerCase() === 'rm';
}

function hasRecursiveRootDelete(commandLine: string): boolean {
  const segments = commandLine.split(/[;&|\n\r]+/);
  for (const segment of segments) {
    const tokens = tokenizeShellLike(segment);
    for (let i = 0; i < tokens.length; i += 1) {
      if (!isRmCommandToken(tokens[i])) continue;
      let hasRecursive = false;
      let hasForce = false;
      for (const token of tokens.slice(i + 1)) {
        if (token.startsWith('--')) continue;
        const flag = isRmRecursiveForceFlag(token);
        if (flag.recursive) {
          hasRecursive = true;
        }
        if (flag.force) {
          hasForce = true;
        }
        if (flag.recursive) {
          continue;
        }
        if (flag.force) {
          continue;
        }
        if (hasRecursive && hasForce && isRootDeleteTarget(token)) return true;
      }
    }
  }
  return false;
}

export function getRunCommandRefusalReason(commandLine: string): string | null {
  if (hasRecursiveRootDelete(commandLine)) return RM_RECURSIVE_ROOT_REASON;
  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    if (pattern.test(commandLine)) return reason;
  }
  return null;
}

export function isReadOnlyRunCommand(commandLine: string): boolean {
  if (getRunCommandRefusalReason(commandLine)) return false;
  if (SHELL_CONTROL_PATTERN.test(commandLine)) return false;
  if (SHELL_SUBSTITUTION_PATTERN.test(commandLine)) return false;
  if (SHELL_NEWLINE_PATTERN.test(commandLine)) return false;
  if (SHELL_VARIABLE_EXPANSION_PATTERN.test(commandLine)) return false;
  if (commandLine.includes('$(')) return false;
  if (/\bgit\b/i.test(commandLine) && /(^|[\s'"]+)--output(?:=|\s|['"])/.test(commandLine)) return false;
  return READ_ONLY_PATTERNS.some((pattern) => pattern.test(commandLine.trim()));
}

export function runCommandTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[RUN_COMMAND_TIMEOUT_ENV];
  if (!raw) return DEFAULT_RUN_COMMAND_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_RUN_COMMAND_TIMEOUT_MS;
  if (parsed <= 0) return DEFAULT_RUN_COMMAND_TIMEOUT_MS;
  if (parsed > MAX_RUN_COMMAND_TIMEOUT_MS) return DEFAULT_RUN_COMMAND_TIMEOUT_MS;
  return parsed;
}

function timeoutError(timeoutMs: number): Error {
  return new Error(`RunCommand timed out after ${timeoutMs}ms`);
}

async function withRunCommandTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  timeoutHandle = setTimeout(() => controller.abort(timeoutError(timeoutMs)), timeoutMs);
  timeoutHandle.unref?.();
  try {
    return await run(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      throw reason instanceof Error ? reason : timeoutError(timeoutMs);
    }
    throw err;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export class RunCommandExecutor implements AntigravityToolExecutor<RunCommandInput, { exitCode: number }> {
  readonly toolName = 'run_command';

  constructor(private readonly deps: { rpc: RpcFn }) {}

  canHandle(step: TrajectoryStep): boolean {
    return resolveToolName(step) === this.toolName;
  }

  async execute(input: RunCommandInput, ctx: ExecutorContext): Promise<ExecutorResult<{ exitCode: number }>> {
    const refusalReason = getRunCommandRefusalReason(input.commandLine);
    if (refusalReason) {
      const refused: ExecutorResult<{ exitCode: number }> = { status: 'refused', reason: refusalReason };
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

    const t0 = Date.now();
    try {
      const timeoutMs = runCommandTimeoutMs();
      // Antigravity LS RunCommand joins `command + args` with spaces and passes
      // to an outer shell. Sending `{ command: '/bin/sh', args: ['-c', cmd] }`
      // causes the outer shell to parse "sh -c cmd" only consuming the first
      // word of cmd — all flags/extra args get discarded. Pass the full command
      // line directly as `command` with no args so the outer shell handles it
      // verbatim (pipes, redirects, chained `&&` all work).
      const resp = await withRunCommandTimeout(
        (signal) =>
          this.deps.rpc(
            'RunCommand',
            {
              command: input.commandLine,
              cwd: input.cwd,
              timeoutMs,
            },
            { signal },
          ),
        timeoutMs,
      );
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
