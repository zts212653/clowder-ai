/**
 * Project env loader — reapplies Hub-persisted app settings at API boot.
 *
 * Problem this solves: owner-set defaults (default cat, bubble display
 * defaults, ...) are persisted by Hub routes to the *config-root* .env
 * (resolveActiveProjectRoot()/.env). But the runtime process is launched by
 * shell scripts that source the *install* .env, and nothing ever loads the
 * config-root file into the process. So every Hub setting silently reverts on
 * restart — the default cat falls back to breeds[0], and bubble defaults fall
 * back to the code constant.
 *
 * This loader closes the loop: at boot it applies the app-setting keys found
 * in the config-root .env into process.env, using only-if-unset semantics so
 * the launcher/install env always wins.
 *
 * Security boundary: eligibility is the explicit fail-closed allowlist in
 * `config/app-settings.ts` — the same list routes/config.ts uses before it
 * persists a PATCH. Capability/permission keys such as
 * CONNECTOR_GATEWAY_AUTOSTART, CAT_CODEX_SANDBOX_MODE, CAT_CODEX_APPROVAL_POLICY
 * and CODEX_AUTH_MODE are deliberately excluded: the startup script owns those,
 * and re-applying a revoked capability from a project file would cross the
 * privilege boundary the launcher restores after dotenv. Read the allowlist
 * before assuming a hot-updatable key is restorable.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { appSettingEnvKeys } from './app-settings.js';

export interface ProjectEnvLoadResult {
  /** Absolute path of the config-root .env, or null when absent. */
  envFile: string | null;
  /** Keys applied (they were unset in the process). */
  applied: string[];
  /** Keys skipped because the process already carried a value. */
  skipped: string[];
}

/**
 * Parse KEY=VALUE lines from .env content. Mirrors the parsing used by the
 * shell startup scripts and by applyEnvUpdatesToFile on the write side:
 * comments and blank lines are ignored, surrounding quotes are stripped.
 */
export function parseEnvFileContents(contents: string): Array<{ name: string; value: string }> {
  const entries: Array<{ name: string; value: string }> = [];
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf('=');
    if (sep < 0) continue;
    const name = line.slice(0, sep).trim();
    if (!name) continue;
    const value = line
      .slice(sep + 1)
      .trim()
      .replace(/^["']+|["']+$/g, '');
    entries.push({ name, value });
  }
  return entries;
}

/**
 * Load app-setting keys from the config-root .env into `env`, only if unset.
 * Meant to be called once at boot. Never throws: an unreadable file is
 * reported as an empty result and the caller logs it.
 */
export function loadProjectEnvIntoProcess(env: NodeJS.ProcessEnv = process.env): ProjectEnvLoadResult {
  const envFile = resolve(resolveActiveProjectRoot(), '.env');
  if (!existsSync(envFile)) return { envFile: null, applied: [], skipped: [] };

  const eligible = appSettingEnvKeys();
  const applied: string[] = [];
  const skipped: string[] = [];
  let contents: string;
  try {
    contents = readFileSync(envFile, 'utf8');
  } catch {
    return { envFile, applied, skipped };
  }

  for (const { name, value } of parseEnvFileContents(contents)) {
    if (!eligible.has(name)) continue;
    const existing = env[name];
    if (existing !== undefined && existing !== '') {
      skipped.push(name);
      continue;
    }
    env[name] = value;
    applied.push(name);
  }
  return { envFile, applied, skipped };
}
