import { createRequire } from 'node:module';
import { delimiter, dirname } from 'node:path';
import { MCP_CALLBACK_ENV_KEYS, MCP_SESSION_ENV_KEYS } from '../config/capabilities/mcp-constants.js';
import { CLI_PROCESS_CONTEXT_ENV, CLI_PROCESS_OWNER_ENV } from '../utils/cli-process-environment.js';
import { RUNTIME_ONLY_LIFECYCLE_ENV_KEYS } from '../utils/runtime-only-env.js';

const require = createRequire(import.meta.url);

function resolveBundledRipgrepDirectory(): string | null {
  try {
    const module = require('@vscode/ripgrep') as { rgPath?: unknown };
    return typeof module.rgPath === 'string' && module.rgPath.length > 0 ? dirname(module.rgPath) : null;
  } catch {
    // Unsupported platforms retain the inherited PATH rather than failing API startup.
    return null;
  }
}

export function buildManagedRunnerEnvironment(inheritedEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...inheritedEnv };
  // wakeWhen is owned by the API-side managed runner, not by the requesting cat CLI.
  delete environment[CLI_PROCESS_OWNER_ENV];
  delete environment[CLI_PROCESS_CONTEXT_ENV];
  for (const key of [...MCP_CALLBACK_ENV_KEYS, ...MCP_SESSION_ENV_KEYS, 'CAT_CAFE_CREDENTIAL_FILE'])
    delete environment[key];
  // Only the validated job descriptor can supply its own checkout provenance.
  delete environment.CAT_CAFE_WORKTREE_ORIGIN;
  // The API process that hosts this runner is usually the live runtime; its lifecycle
  // opt-ins must not reach a command that may start a worktree dev server.
  for (const key of RUNTIME_ONLY_LIFECYCLE_ENV_KEYS) delete environment[key];

  const bundledRipgrepDirectory = resolveBundledRipgrepDirectory();
  if (bundledRipgrepDirectory === null) {
    return environment;
  }

  const entries = [bundledRipgrepDirectory, ...(environment.PATH?.split(delimiter) ?? [])].filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  );

  return { ...environment, PATH: [...new Set(entries)].join(delimiter) };
}

/**
 * How the managed runner starts a cat's shell command.
 *
 * Long cat commands (renders, engine builds, whole-repo sync) used to share the
 * API's CPU and disk at equal priority. On macOS they start one step lower for
 * CPU (nice 10) and disk (utility I/O tier, inherited by every child). An idle
 * machine still runs them at full speed on all cores; they only yield while the
 * Hub API competes for the same CPU or disk.
 *
 * Used for ordinary durable wakeWhen commands; gates keep standard priority.
 * taskpolicy and nice exec in place, so the pid, process group, start time and
 * environment (including the attempt token) belong to the `/bin/sh -c` that runs
 * the command, exactly as with `shell: true`.
 */
export const MANAGED_COMMAND_NICE = 10;

export function managedShellInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[]; shell: boolean } {
  if (platform === 'darwin') {
    return {
      file: '/usr/sbin/taskpolicy',
      args: ['-d', 'utility', '/usr/bin/nice', '-n', String(MANAGED_COMMAND_NICE), '/bin/sh', '-c', command],
      shell: false,
    };
  }
  return { file: command, args: [], shell: true };
}
