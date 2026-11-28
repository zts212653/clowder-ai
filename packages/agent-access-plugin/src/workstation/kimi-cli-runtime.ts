import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveCliCommand } from './cli-resolve.js';

interface KimiCliRuntime {
  command: string;
}

/** Kimi Code is the supported runtime; never launch the retired kimi-cli shim. */
export function resolveKimiCliRuntime(commandFor: typeof resolveCliCommand = resolveCliCommand): KimiCliRuntime | null {
  const native = commandFor('kimi');
  return native ? { command: native } : null;
}

export interface KimiRuntimePaths {
  shareDir: string;
  configPath: string;
}

/** Host readers follow the selected CLI without changing the child environment. */
export function resolveKimiRuntimePaths(env: Record<string, string | undefined>, home?: string): KimiRuntimePaths {
  const effective = { ...process.env, ...env };
  const nativeHome = home ?? (process.platform === 'win32' ? effective.USERPROFILE : effective.HOME) ?? homedir();
  const shareDir = effective.KIMI_CODE_HOME || join(nativeHome, '.kimi-code');
  return { shareDir, configPath: join(shareDir, 'config.toml') };
}
