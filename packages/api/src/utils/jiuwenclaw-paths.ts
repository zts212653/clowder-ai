import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LEGACY_JIUWENCLAW_APP_DIR = '/usr/code/relay-claw';

function resolveRepoRoot(): string {
  const fileDir = dirname(fileURLToPath(import.meta.url));
  return resolve(fileDir, '../../../../');
}

export function resolveVendoredJiuwenClawAppDir(): string {
  return resolve(resolveRepoRoot(), 'vendor/jiuwenclaw');
}

export function resolveJiuwenClawAppDir(explicitAppDir?: string): string {
  const configured = explicitAppDir?.trim() || process.env.CAT_CAFE_RELAYCLAW_APP_DIR?.trim();
  if (configured) return configured;

  const vendored = resolveVendoredJiuwenClawAppDir();
  if (existsSync(join(vendored, 'jiuwenclaw', 'app.py'))) return vendored;

  return LEGACY_JIUWENCLAW_APP_DIR;
}

export function resolveJiuwenClawPythonBin(explicitPython?: string, appDir?: string): string {
  const configured = explicitPython?.trim() || process.env.CAT_CAFE_RELAYCLAW_PYTHON?.trim();
  if (configured) return configured;

  const resolvedAppDir = resolveJiuwenClawAppDir(appDir);
  const vendoredCandidate = join(resolvedAppDir, '.venv', 'bin', 'python');
  if (existsSync(vendoredCandidate)) return vendoredCandidate;

  const legacyCandidate = join(LEGACY_JIUWENCLAW_APP_DIR, '.venv', 'bin', 'python');
  if (existsSync(legacyCandidate)) return legacyCandidate;

  return vendoredCandidate;
}

export function jiuwenClawBundleAvailable(): boolean {
  const appDir = resolveJiuwenClawAppDir();
  const pythonBin = resolveJiuwenClawPythonBin(undefined, appDir);
  return existsSync(join(appDir, 'jiuwenclaw', 'app.py')) && existsSync(pythonBin);
}
