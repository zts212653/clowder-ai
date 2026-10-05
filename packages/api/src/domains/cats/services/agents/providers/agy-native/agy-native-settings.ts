import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { buildAgyNativePolicy } from './agy-native-policy.js';

export interface AgyNativeSettingsInput {
  readonly profileHome: string;
  readonly model: string;
  readonly policy: ReturnType<typeof buildAgyNativePolicy>;
}

const PROFILE_SETTING_KEYS = new Set(['modelProvider', 'model', 'trustedWorkspaces', 'colorScheme']);
const HOST_POLICY_KEYS = new Set(['permissions', 'toolPermission', 'enableTerminalSandbox', 'allowNonWorkspaceAccess']);

function requireSafeDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`AGY native profile path must not be a symlink: ${path}`);
  if (!stat.isDirectory()) throw new Error(`AGY native profile path must be a directory: ${path}`);
}

function readExistingSettings(path: string): Record<string, unknown> {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error('AGY native settings file must not be a symlink');
  if (!stat.isFile()) throw new Error('AGY native settings path must be a file');
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AGY native settings must contain a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** Replace legacy permissions with one task policy in a dedicated, already authenticated HOME. */
export function materializeAgyNativeSettings(input: AgyNativeSettingsInput): string {
  const suppliedHome = resolve(input.profileHome);
  requireSafeDirectory(suppliedHome);
  const home = realpathSync(suppliedHome);
  if (home === realpathSync(homedir())) throw new Error('AGY native settings require an isolated HOME');
  if (!/^[A-Za-z0-9._-]+$/.test(input.model)) throw new Error('Invalid AGY native model selector');
  const gemini = join(home, '.gemini');
  const settingsDir = join(gemini, 'antigravity-cli');
  requireSafeDirectory(gemini);
  requireSafeDirectory(settingsDir);
  const settingsPath = join(settingsDir, 'settings.json');
  const existing = readExistingSettings(settingsPath);
  if (existing.modelProvider != null) {
    throw new Error('AGY native OAuth profile cannot select an API-key modelProvider');
  }
  for (const key of Object.keys(existing)) {
    if (!PROFILE_SETTING_KEYS.has(key) && !HOST_POLICY_KEYS.has(key)) {
      throw new Error(`Unsupported AGY native profile setting: ${key}`);
    }
  }
  const retained = Object.fromEntries(Object.entries(existing).filter(([key]) => PROFILE_SETTING_KEYS.has(key)));
  const next = {
    ...retained,
    model: input.model,
    trustedWorkspaces: [input.policy.workspaceRoot],
    ...input.policy.settings,
  };
  const temp = join(settingsDir, `.settings-${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    renameSync(temp, settingsPath);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return settingsPath;
}
