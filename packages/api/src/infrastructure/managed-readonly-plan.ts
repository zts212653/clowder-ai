import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { admitCodexNativeCapability } from './codex-native-compat/admission.js';

export const READONLY_MAX_TIMEOUT_MS = 60_000;
export const READONLY_OUTPUT_BYTES = 64 * 1024;
const EXECUTION_PATH = [
  ...new Set([dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']),
];

export function readonlyEnvironment(home: string, cwd: string): Record<string, string> {
  return {
    PATH: EXECUTION_PATH.join(':'),
    HOME: homedir(),
    CODEX_HOME: home,
    TMPDIR: home,
    PWD: cwd,
    LANG: 'C',
    LC_ALL: 'C',
  };
}

/**
 * A capability is admitted for the tested platform and a measured version, never inferred from a
 * policy name: the installed version must have passed the credential-free readOnly sandbox probe.
 */
export async function readonlyCodexExecutable(environment: NodeJS.ProcessEnv): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('readonly_capability_unavailable:platform');
  const configured = process.env.CODEX_BIN;
  if (configured && !isAbsolute(configured)) throw new Error('readonly_capability_unavailable:relative_executable');
  const executable = configured ?? EXECUTION_PATH.map((directory) => join(directory, 'codex')).find(existsSync);
  if (!executable) throw new Error('readonly_capability_unavailable:codex_missing');
  const resolved = realpathSync(executable);
  await admitCodexNativeCapability(
    resolved,
    'readonly_sandbox',
    environment,
    'readonly_capability_unavailable:version',
  );
  return resolved;
}

export function readonlyCommandPlan(command: string, cwd: string, home: string, timeoutMs: number, processId: string) {
  if (!isAbsolute(cwd)) throw new Error('readonly_cwd_must_be_absolute');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > READONLY_MAX_TIMEOUT_MS)
    throw new Error('readonly_timeout_out_of_bounds');
  const directory = realpathSync(cwd);
  return Object.freeze({
    command: Object.freeze(['/bin/bash', '--noprofile', '--norc', '-c', command]),
    cwd: directory,
    env: Object.freeze(readonlyEnvironment(home, directory)),
    sandboxPolicy: Object.freeze({ type: 'readOnly', networkAccess: false }),
    timeoutMs,
    outputBytesCap: READONLY_OUTPUT_BYTES,
    processId,
  });
}
