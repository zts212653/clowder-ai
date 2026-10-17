import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveCliCommand } from './cli-resolve.js';

interface KimiCliRuntime {
  command: string;
  flavor: 'legacy' | 'native';
}

/** Match dispatch precedence; directory existence is not evidence of CLI flavor. */
export function resolveKimiCliRuntime(commandFor: typeof resolveCliCommand = resolveCliCommand): KimiCliRuntime | null {
  const legacy = commandFor('kimi-cli');
  if (legacy) return { command: legacy, flavor: 'legacy' };
  const native = commandFor('kimi');
  return native ? { command: native, flavor: 'native' } : null;
}

export interface KimiRuntimePaths {
  shareDir: string;
  configPath: string;
}

/** Host readers follow the selected CLI without changing the child environment. */
export function resolveKimiRuntimePaths(
  runtime: KimiCliRuntime | null,
  env: Record<string, string | undefined>,
  home?: string,
): KimiRuntimePaths {
  const effective = { ...process.env, ...env };
  const nativeHome = home ?? (process.platform === 'win32' ? effective.USERPROFILE : effective.HOME) ?? homedir();
  const shareDir =
    runtime?.flavor === 'native'
      ? effective.KIMI_CODE_HOME || join(nativeHome, '.kimi-code')
      : effective.KIMI_SHARE_DIR || join(nativeHome, '.kimi');
  return {
    shareDir,
    configPath:
      runtime?.flavor !== 'native' && effective.KIMI_CONFIG_FILE
        ? effective.KIMI_CONFIG_FILE
        : join(shareDir, 'config.toml'),
  };
}
