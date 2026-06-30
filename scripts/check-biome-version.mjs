#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_LOCKFILE_PATH = path.join(REPO_ROOT, 'pnpm-lock.yaml');
const DEFAULT_INSTALLED_PACKAGE_PATH = path.join(REPO_ROOT, 'node_modules', '@biomejs', 'biome', 'package.json');

function getLockedBiomeVersion(lockfilePath = DEFAULT_LOCKFILE_PATH) {
  const lockfile = readFileSync(lockfilePath, 'utf8');
  const matches = [...lockfile.matchAll(/['"]?@biomejs\/biome@([^'":\s]+)['"]?:/g)].map((match) => match[1]);
  const uniqueVersions = [...new Set(matches)];

  if (uniqueVersions.length === 0) {
    throw new Error(`Could not find @biomejs/biome in ${lockfilePath}`);
  }

  if (uniqueVersions.length > 1) {
    throw new Error(
      `Expected exactly one locked @biomejs/biome version in ${lockfilePath}, found: ${uniqueVersions.join(', ')}`,
    );
  }

  return uniqueVersions[0];
}

function readInstalledBiomeVersion(installedPackagePath = DEFAULT_INSTALLED_PACKAGE_PATH) {
  if (!existsSync(installedPackagePath)) {
    return null;
  }

  const pkg = JSON.parse(readFileSync(installedPackagePath, 'utf8'));
  return typeof pkg.version === 'string' ? pkg.version : null;
}

function verifyBiomeVersion({
  lockfilePath = DEFAULT_LOCKFILE_PATH,
  installedPackagePath = DEFAULT_INSTALLED_PACKAGE_PATH,
} = {}) {
  const lockedVersion = getLockedBiomeVersion(lockfilePath);
  const installedVersion = readInstalledBiomeVersion(installedPackagePath);

  if (!installedVersion) {
    return {
      ok: false,
      lockedVersion,
      installedVersion: null,
      message:
        `Biome ${lockedVersion} is required by pnpm-lock.yaml but is not installed locally. ` +
        'Run `env -u NODE_ENV pnpm install --frozen-lockfile` to refresh this worktree.',
    };
  }

  if (installedVersion !== lockedVersion) {
    return {
      ok: false,
      lockedVersion,
      installedVersion,
      message:
        `Biome version mismatch: expected ${lockedVersion} from pnpm-lock.yaml, found ${installedVersion} in node_modules. ` +
        'Run `env -u NODE_ENV pnpm install --frozen-lockfile` before trusting local Biome results.',
    };
  }

  return {
    ok: true,
    lockedVersion,
    installedVersion,
    message: `Biome version OK (${installedVersion})`,
  };
}

function main() {
  try {
    const result = verifyBiomeVersion();
    if (!result.ok) {
      console.error(result.message);
      process.exit(1);
    }

    console.log(result.message);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const isEntryPoint = process.argv[1] && new URL(process.argv[1], 'file://').href === import.meta.url;
if (isEntryPoint) {
  main();
}

export { getLockedBiomeVersion, verifyBiomeVersion };
