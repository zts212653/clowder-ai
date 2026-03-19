import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(testDir, '..', '..', '..');
const helperScript = resolve(repoRoot, 'scripts', 'install-auth-config.mjs');

export function runHelper(args) {
  return execFileSync('node', [helperScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

export function runHelperResult(args) {
  return spawnSync('node', [helperScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

export function runHelperWithEnv(args, env) {
  return execFileSync('node', [helperScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}
