import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(testDir, '..', '..', '..');
const helperScript = resolve(repoRoot, 'scripts', 'install-auth-config.mjs');

/** Extract --project-dir from args to use as global config root for test isolation. */
function extractProjectDir(args) {
  const idx = args.indexOf('--project-dir');
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

export function runHelper(args) {
  const projectDir = extractProjectDir(args);
  return execFileSync('node', [helperScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...(projectDir ? { CAT_CAFE_GLOBAL_CONFIG_ROOT: projectDir } : {}) },
  });
}

export function runHelperResult(args) {
  const projectDir = extractProjectDir(args);
  return spawnSync('node', [helperScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...(projectDir ? { CAT_CAFE_GLOBAL_CONFIG_ROOT: projectDir } : {}) },
  });
}

export function runHelperWithEnv(args, env) {
  const projectDir = extractProjectDir(args);
  return execFileSync('node', [helperScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...(projectDir ? { CAT_CAFE_GLOBAL_CONFIG_ROOT: projectDir } : {}), ...env },
  });
}

/** Run installer WITHOUT CAT_CAFE_GLOBAL_CONFIG_ROOT — exercises _activeProjectDir fallback. */
export function runHelperNoGlobalOverride(args) {
  const { CAT_CAFE_GLOBAL_CONFIG_ROOT: _stripped, ...cleanEnv } = process.env;
  return spawnSync('node', [helperScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: cleanEnv,
  });
}
