import { existsSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCliProcessOwnerDirectory } from './cli-process-ownership.js';

const CLI_SUPERVISOR_ENV_FILE_FLAGS = new Set(['--env-file', '--env-file-if-exists']);

function sanitizeCliSupervisorExecArgv(execArgv: string[]): string[] {
  const safeArgs: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const arg = execArgv[index];
    if (CLI_SUPERVISOR_ENV_FILE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('--env-file=') || arg.startsWith('--env-file-if-exists=')) continue;
    safeArgs.push(arg);
  }
  return safeArgs;
}

export function resolveCliSupervisorNodeArgs(moduleUrl = import.meta.url, execArgv = process.execArgv): string[] {
  const jsPath = fileURLToPath(new URL('./cli-supervisor.js', moduleUrl));
  if (existsSync(jsPath)) return [jsPath];

  const tsPath = fileURLToPath(new URL('./cli-supervisor.ts', moduleUrl));
  if (existsSync(tsPath)) return [...sanitizeCliSupervisorExecArgv(execArgv), tsPath];

  return [jsPath];
}

export interface UnixSupervisedSpawnPlanOptions {
  env?: NodeJS.ProcessEnv;
  killGraceMs: number;
  parentPid?: number;
  socketDirectory?: string;
}

export interface UnixSupervisedSpawnPlan {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * Wrap a Unix child in the Clowder AI lifecycle supervisor.
 *
 * All production-owned CLI/host processes use this same seam so API death,
 * graceful close, and forced close terminate the complete descendant tree.
 */
export function buildUnixSupervisedSpawnPlan(
  command: string,
  args: readonly string[],
  options: UnixSupervisedSpawnPlanOptions,
): UnixSupervisedSpawnPlan {
  const env = { ...options.env };
  if (env.CAT_CAFE_DATA_DIR) {
    env.CAT_CAFE_DATA_DIR = dirname(resolveCliProcessOwnerDirectory(env.CAT_CAFE_DATA_DIR));
  }
  if (isAbsolute(command)) {
    const binDir = dirname(command);
    env.PATH = env.PATH ? `${binDir}:${env.PATH}` : binDir;
  }

  return {
    command: process.execPath,
    args: [...resolveCliSupervisorNodeArgs(), '--', command, ...args],
    env: {
      ...env,
      CAT_CAFE_SUPERVISOR_PARENT_PID: String(options.parentPid ?? process.pid),
      CAT_CAFE_SUPERVISOR_KILL_GRACE_MS: String(Math.max(1, options.killGraceMs)),
      ...(options.socketDirectory ? { CAT_CAFE_SUPERVISOR_SOCKET_DIR: options.socketDirectory } : {}),
    },
  };
}
