import { execFile } from 'node:child_process';
import { buildChildEnv } from '../utils/cli-spawn.js';
import { resolveWindowsSpawnPlan } from '../utils/cli-spawn-win.js';
import { hasNativeClaudeApiConfig } from './native-claude-api-config.js';
import { nativeKimiLoginCommand } from './native-kimi-login.js';
import { probeCodexLogin } from './runtime-codex-discovery.js';

export type NativeReadiness = {
  status: 'login_required' | 'configured' | 'unknown' | 'not_installed';
  checkedAt: number;
  loginCommand?: string;
  loginShell?: 'powershell' | 'sh';
};
type Target = { id: string; installed: boolean; command?: string };
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

/** Login evidence only. It cannot prove quota, reachability, or a successful model invocation. */
export function nativeAuthenticationStatus(kind: string, value: unknown): NativeReadiness['status'] {
  const observed = record(value);
  if (kind === 'claude') {
    if (observed.loggedIn === true) return 'configured';
    if (observed.loggedIn === false) return 'login_required';
  }
  if (kind === 'codex' && Object.hasOwn(observed, 'account')) {
    if (['chatgpt', 'apiKey'].includes(String(record(observed.account).type))) return 'configured';
    if (observed.account === null) return observed.requiresOpenaiAuth === false ? 'configured' : 'login_required';
  }
  return 'unknown';
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
const cache = new Map<string, { at: number; value: NativeReadiness }>();
const pending = new Map<string, Promise<NativeReadiness>>();
export async function nativeRuntimeReadiness(target: Target, cwd: string, refresh = false): Promise<NativeReadiness> {
  if (!target.installed) return { status: 'not_installed', checkedAt: Date.now() };
  // Kimi 2.2 exposes login, provider config and doctor, but no read-only auth status.
  // Local config/credential existence cannot establish that a copied grant remains valid.
  if (target.id === 'kimi' && target.command)
    return {
      status: 'unknown',
      checkedAt: Date.now(),
      loginCommand: nativeKimiLoginCommand(target.command),
      loginShell: process.platform === 'win32' ? 'powershell' : 'sh',
    };
  if (!target.command || !['codex', 'claude'].includes(target.id)) return { status: 'unknown', checkedAt: Date.now() };
  if (target.id === 'claude' && hasNativeClaudeApiConfig()) return { status: 'configured', checkedAt: Date.now() };
  const key = JSON.stringify([
    target.id,
    target.command,
    cwd,
    process.env.CODEX_HOME,
    process.env.CLAUDE_CONFIG_DIR,
    process.env.HOME,
    process.env.USERPROFILE,
  ]);
  const previous = cache.get(key);
  if (!refresh && previous && Date.now() - previous.at < 15_000) return previous.value;
  const running = pending.get(key);
  if (running) return running;
  if (pending.size >= 3) return { status: 'unknown', checkedAt: Date.now() };
  const probe = target.id === 'claude' ? claudeLogin : probeCodexLogin;
  const promise = probe(target.command, cwd)
    .catch(() => null)
    .then((observed) => {
      const value: NativeReadiness = {
        status: nativeAuthenticationStatus(target.id, observed),
        checkedAt: Date.now(),
        loginCommand: target.id === 'claude' ? 'claude auth login' : 'codex login',
      };
      const oldestKey = cache.keys().next().value;
      if (cache.size >= 64 && oldestKey !== undefined) cache.delete(oldestKey);
      cache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}
