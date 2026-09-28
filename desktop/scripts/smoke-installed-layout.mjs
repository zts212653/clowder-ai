#!/usr/bin/env node
/**
 * Smoke-test an INSTALLED desktop tree.
 *
 * Checks three things a source-level test cannot:
 *   1. the installer produced every path it promises
 *   2. the install metadata parses
 *   3. the BUNDLED Node / Redis actually execute, and the native modules load
 *      under the bundled Node (the ABI class of bug this work exists to stop)
 *
 * Usage:
 *   node desktop/scripts/smoke-installed-layout.mjs --root "C:\\Program Files\\ClowderAI"
 *   node desktop/scripts/smoke-installed-layout.mjs --root "/Applications/Clowder AI.app" --platform darwin
 *
 * Exit codes: 0 = usable install, 1 = problems found (listed), 2 = bad usage.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkDesktopConfig,
  checkInstalledLayout,
  evaluateToolchainResults,
  toolchainChecks,
} from './lib/installed-layout.mjs';
import { requiredNodeMajor, validateRuntimeManifest } from './lib/runtime-manifest.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.resolve(SCRIPT_DIR, '..', 'runtime-manifest.json');

function fail(message, code) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { root: null, platform: process.platform };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') args.root = argv[++i];
    else if (argv[i] === '--platform') args.platform = argv[++i];
    else fail(`Unknown flag: ${argv[i]}`, 2);
  }
  if (!args.root) fail('Usage: smoke-installed-layout.mjs --root <install root> [--platform win32|darwin]', 2);
  return args;
}

function runCheck(check) {
  try {
    const stdout = execFileSync(check.cmd, check.args, {
      cwd: check.cwd,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
    return { id: check.id, code: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      id: check.id,
      code: typeof error?.status === 'number' ? error.status : 1,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? error?.message ?? ''),
    };
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root);

  if (!fs.existsSync(root)) fail(`Install root not found: ${root}`, 2);

  let floor;
  try {
    floor = requiredNodeMajor(validateRuntimeManifest(JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))));
  } catch (error) {
    fail(`Could not read the Node floor from ${MANIFEST_PATH}: ${error.message}`, 2);
  }

  process.stdout.write(`Smoke-testing installed tree: ${root} (${args.platform}, Node floor v${floor})\n`);

  const layout = checkInstalledLayout({
    platform: args.platform,
    root: root.split(path.sep).join('/'),
    exists: (target) => fs.existsSync(target),
  });

  const problems = [];
  if (layout.ok) {
    process.stdout.write(`  [OK] layout: all ${layout.checked} expected paths present\n`);
  } else {
    for (const entry of layout.missing) {
      problems.push(`missing ${entry.path} — ${entry.why}`);
    }
  }

  const configPath = path.join(root, '.cat-cafe', 'desktop-config.json');
  const config = checkDesktopConfig(fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null);
  if (config.ok) {
    process.stdout.write(
      `  [OK] metadata: installType=${config.config.installType} version=${config.config.version}\n`,
    );
  } else {
    problems.push(`metadata: ${config.reason}`);
  }

  const checks = toolchainChecks({ root: root.split(path.sep).join('/') });
  const results = checks.map((check) => {
    process.stdout.write(`  .. running ${check.id}\n`);
    return runCheck(check);
  });

  const toolchain = evaluateToolchainResults(results, { nodeMajorFloor: floor });
  for (const failure of toolchain.failures) {
    problems.push(`${failure.id} — ${failure.reason}`);
  }
  if (toolchain.ok) {
    process.stdout.write(`  [OK] toolchain: ${checks.length} bundled-runtime checks passed\n`);
  }

  if (problems.length > 0) {
    process.stderr.write(`\nInstalled tree is NOT usable (${problems.length} problem(s)):\n`);
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    process.exit(1);
  }

  process.stdout.write('\nInstalled tree verified: layout, metadata and bundled toolchain all good.\n');
}

main();
