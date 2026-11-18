import type { AgentAccessDiscoveryHost } from '@clowder-ai/agent-contract';
import { hasNativeClaudeApiConfig } from './native-claude-api-config.js';
import { nativeKimiLoginCommand } from './native-kimi-login.js';

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

const cache = new Map<string, { at: number; value: NativeReadiness }>();
const pending = new Map<string, Promise<NativeReadiness>>();
export async function nativeRuntimeReadiness(
  target: Target,
  cwd: string,
  refresh = false,
  inspectNativeLogin: AgentAccessDiscoveryHost['inspectNativeLogin'],
): Promise<NativeReadiness> {
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
  if (!target.command || (target.id !== 'codex' && target.id !== 'claude'))
    return { status: 'unknown', checkedAt: Date.now() };
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

  const promise = inspectNativeLogin(target.id, target.command)
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
