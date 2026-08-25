#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ensureMeasurementBundleCensusFile } from '../packages/api/dist/infrastructure/harness-eval/measurement/measurement-bundle-census-file.js';

function parseArgs(argv) {
  const options = { repoRoot: process.cwd(), generatedAt: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--repo-root' && value) {
      options.repoRoot = resolve(value);
      index += 1;
      continue;
    }
    if (arg === '--generated-at' && value) {
      options.generatedAt = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return options;
}

function resolveGeneratedAt(repoRoot, explicit) {
  if (explicit) return explicit;
  const provenancePath = resolve(repoRoot, '.sync-provenance.json');
  if (existsSync(provenancePath)) {
    const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
    if (typeof provenance.synced_at === 'string' && provenance.synced_at.length > 0) {
      return provenance.synced_at;
    }
  }
  return new Date().toISOString();
}

const options = parseArgs(process.argv.slice(2));
const result = ensureMeasurementBundleCensusFile(
  options.repoRoot,
  resolveGeneratedAt(options.repoRoot, options.generatedAt),
);
console.log(
  `[measurement-census] ${result.created ? 'bootstrapped' : result.reconciled ? 'reconciled' : 'validated'} ${result.path}`,
);
