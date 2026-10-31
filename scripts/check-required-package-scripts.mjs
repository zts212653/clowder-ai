#!/usr/bin/env node

/**
 * P1-B guard: script-presence gate for CI steps.
 *
 * `pnpm --filter <pkg> <script>` only *warns* ("None of the selected packages has
 * a ... script") and still exits 0 when the script is missing from package.json.
 * A merge that drops a first-run test script therefore turns its CI step into a
 * silent green light: the command never runs and the tests it owns are never
 * executed. This guard fails closed before CI invokes those scripts.
 *
 * Usage:
 *   node scripts/check-required-package-scripts.mjs
 *     Checks every package/script pair in REQUIRED_PACKAGE_SCRIPTS.
 *   node scripts/check-required-package-scripts.mjs --package packages/web --script test:first-run-onboarding
 *     Checks only the named package/scripts (--script may be repeated).
 *
 * Exit codes: 0 = every required script exists, 1 = missing scripts or unreadable
 * package.json, 2 = invalid invocation.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');

/** First-run onboarding scripts that CI and the release gate depend on. */
export const REQUIRED_PACKAGE_SCRIPTS = {
  'packages/web': [
    'test:first-run-onboarding',
    'test:first-run-entry:api',
    'test:first-run-entry:production',
    'test:onboarding:contracts',
    'test:onboarding:production-contracts',
    'test:onboarding:live',
    'test:onboarding:a2a',
  ],
};

/**
 * @param {unknown} packageJson parsed package.json content
 * @param {string[]} required script names that must exist and be non-empty
 * @returns {string[]} required names that are absent or empty
 */
export function findMissingScripts(packageJson, required) {
  const scripts =
    packageJson && typeof packageJson === 'object' && !Array.isArray(packageJson) ? packageJson.scripts : undefined;
  const entries = scripts && typeof scripts === 'object' && !Array.isArray(scripts) ? scripts : {};
  return required.filter((name) => {
    const command = entries[name];
    return typeof command !== 'string' || command.trim().length === 0;
  });
}

/**
 * @param {string} packageDir repository-relative package directory
 * @param {string[]} required required script names
 * @param {(path: string) => string} readText file reader (injectable for tests)
 * @returns {{ packageJson: unknown, missing: string[] }}
 */
export function checkPackageScripts(packageDir, required, readText = defaultReadText) {
  const packageJsonPath = resolve(REPO_ROOT, packageDir, 'package.json');
  let text;
  try {
    text = readText(packageJsonPath);
  } catch (error) {
    throw new Error(
      `cannot read ${packageDir}/package.json: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }

  let packageJson;
  try {
    packageJson = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `cannot parse ${packageDir}/package.json: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }

  return { packageJson, missing: findMissingScripts(packageJson, required) };
}

/** Reads a repository file as UTF-8 (kept separate so tests can inject a fake reader). */
export function defaultReadText(absolutePath) {
  return readFileSync(absolutePath, 'utf8');
}

/**
 * @param {string[]} argv CLI arguments after the script name
 * @returns {{ packages: Array<{ dir: string, scripts: string[] }> } | { error: string }}
 */
export function parseArgs(argv) {
  const packageDirs = [];
  const scripts = [];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== '--package' && flag !== '--script') return { error: `unknown argument: ${flag}` };
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.trim().length === 0 || value.startsWith('--')) {
      return { error: `missing value for ${flag}` };
    }
    if (flag === '--package') packageDirs.push(value.trim());
    else scripts.push(value.trim());
    index += 1;
  }

  if (!packageDirs.length && scripts.length) return { error: '--script requires --package' };
  if (packageDirs.length > 1 && scripts.length) {
    return { error: '--script requires exactly one --package' };
  }

  const targets = packageDirs.length ? packageDirs : Object.keys(REQUIRED_PACKAGE_SCRIPTS);
  return {
    packages: targets.map((dir) => ({
      dir,
      scripts: scripts.length ? scripts : (REQUIRED_PACKAGE_SCRIPTS[dir] ?? []),
    })),
  };
}

function main(argv) {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    console.error(`[check-required-package-scripts] FAIL — invalid invocation: ${parsed.error}`);
    process.exitCode = 2;
    return;
  }

  let failed = false;
  for (const target of parsed.packages) {
    if (!target.scripts.length) {
      console.error(`[check-required-package-scripts] FAIL — no required scripts declared for ${target.dir}`);
      failed = true;
      continue;
    }

    let result;
    try {
      result = checkPackageScripts(target.dir, target.scripts);
    } catch (error) {
      console.error(
        `[check-required-package-scripts] FAIL — ${error instanceof Error ? error.message : String(error)}`,
      );
      failed = true;
      continue;
    }

    if (result.missing.length) {
      console.error(`[check-required-package-scripts] FAIL — ${target.dir}/package.json is missing required scripts:`);
      for (const name of result.missing) console.error(`  - ${name}`);
      console.error('  A missing script makes `pnpm --filter <pkg> <script>` exit 0 without running anything.');
      failed = true;
      continue;
    }

    console.log(
      `[check-required-package-scripts] PASS — ${target.dir} declares ${target.scripts.length} required script(s)`,
    );
  }

  if (failed) process.exitCode = 1;
}

if (resolve(process.argv[1] ?? '') === SCRIPT_PATH) main(process.argv.slice(2));
