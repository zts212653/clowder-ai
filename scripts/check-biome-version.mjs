#!/usr/bin/env node
/**
 * check-biome-version.mjs — Verify installed Biome matches package.json spec.
 *
 * Called by .githooks/pre-commit BIOME GUARD to detect stale local installs.
 * Exit 0 = OK, exit 1 = version mismatch or biome not installed.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Read the spec from package.json devDependencies
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const spec = pkg.devDependencies?.['@biomejs/biome'];
if (!spec) {
  console.error('check-biome-version: @biomejs/biome not in devDependencies');
  process.exit(1);
}

// Get installed version
let installed;
try {
  installed = execSync('pnpm exec biome --version', { cwd: root, encoding: 'utf-8' })
    .trim()
    .replace(/^Version:\s*/i, '');
} catch {
  console.error('check-biome-version: biome not installed — run pnpm install');
  process.exit(1);
}

// Simple semver range check: strip ^ or ~ prefix and compare major.minor
const specClean = spec.replace(/^[\^~>=<\s]+/, '');
const [specMajor, specMinor] = specClean.split('.').map(Number);
const [instMajor, instMinor] = installed.split('.').map(Number);

if (specMajor !== instMajor) {
  console.error(`check-biome-version: major mismatch — spec ${spec} vs installed ${installed}. Run pnpm install.`);
  process.exit(1);
}

// For ^ range: minor must be >= spec minor
if (spec.startsWith('^') && instMinor < specMinor) {
  console.error(`check-biome-version: minor too low — spec ${spec} vs installed ${installed}. Run pnpm install.`);
  process.exit(1);
}

// OK
process.exit(0);
