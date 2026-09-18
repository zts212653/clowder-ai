#!/usr/bin/env node
/**
 * Print one field of desktop/runtime-manifest.json.
 *
 * Build scripts use this so a version has exactly one home:
 *   node desktop/scripts/lib/read-runtime-manifest.mjs redis.darwin.version
 *
 * Exits non-zero with an actionable message when the field is absent, so a
 * build fails closed instead of substituting a default.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getByPath, validateRuntimeManifest } from './runtime-manifest.mjs';

const manifestPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'runtime-manifest.json');

const dottedPath = process.argv[2];
if (!dottedPath) {
  process.stderr.write('Usage: read-runtime-manifest.mjs <dotted.path>\n');
  process.exit(2);
}

let manifest;
try {
  manifest = validateRuntimeManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

const value = getByPath(manifest, dottedPath);
if (value === undefined || value === null || value === '') {
  process.stderr.write(
    `No value at "${dottedPath}" in ${manifestPath}.\n` +
      '  fix: check the field name against desktop/runtime-manifest.json.\n',
  );
  process.exit(1);
}

process.stdout.write(String(value));
