import { nativeRuntimeReadiness as probeReadiness } from '@clowder-ai/agent-access/discovery/native-runtime-readiness';

export type { NativeReadiness } from '@clowder-ai/agent-access/discovery/native-runtime-readiness';
export { nativeAuthenticationStatus } from '@clowder-ai/agent-access/discovery/native-runtime-readiness';

import { execFile } from 'node:child_process';
import { buildChildEnv } from '../utils/cli-spawn.js';
import { resolveWindowsSpawnPlan } from '../utils/cli-spawn-win.js';
import { probeCodexLogin } from './runtime-codex-discovery.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};

function parseClaudeLoginOutput(
  stdout: string,
  stderr: string,
  error: { code?: string | number | null } | null,
): unknown {
  const candidates = [
    stdout.trim(),
    ...`${stdout}\n${stderr}`
      .split(/\r?\n/)
      .reverse()
      .map((line) => line.trim()),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      const ordinaryMissingLogin = record(value).loggedIn === false && error?.code === 1;
      return error && !ordinaryMissingLogin ? null : value;
    } catch {
      // CLI warnings may precede the JSON status; try the next line.
    }
  }
  return null;
}

async function claudeLogin(command: string, cwd: string): Promise<unknown> {
  const args = ['auth', 'status', '--json'];
  const plan = process.platform === 'win32' ? resolveWindowsSpawnPlan(command, args) : { command, args };
  return new Promise((resolve) => {
    execFile(
      plan.command,
      plan.args,
      {
        cwd,
        env: buildChildEnv(undefined, { workingDirectory: cwd }),
        shell: 'shell' in plan ? plan.shell : false,
        windowsHide: true,
        timeout: 6_000,
        maxBuffer: 256_000,
      },
      (error, stdout, stderr) => resolve(parseClaudeLoginOutput(stdout, stderr, error)),
    );
  });
}
export async function inspectNativeLogin(client: 'codex' | 'claude', command: string, cwd: string): Promise<unknown> {
  if (client === 'codex') return probeCodexLogin(command, cwd);
  const result = record(await claudeLogin(command, cwd));
  return typeof result.loggedIn === 'boolean' ? { loggedIn: result.loggedIn } : null;
}

export function nativeRuntimeReadiness(
  target: { id: string; installed: boolean; command?: string },
  cwd: string,
  refresh = false,
) {
  return probeReadiness(target, cwd, refresh, (client, command) => inspectNativeLogin(client, command, cwd));
}
