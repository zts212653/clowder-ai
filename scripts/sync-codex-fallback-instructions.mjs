#!/usr/bin/env node
/**
 * Sync the pinned Codex fallback-instructions snapshot with an upstream release.
 *
 * The catalog entry must carry the CLI's base instructions because a custom
 * `model_catalog_json` replaces the built-in catalog and the parser rejects an
 * entry without `model_messages.instructions_template`. `codex debug models
 * --bundled` does not expose the fallback template, so this script fetches the
 * exact upstream source instead of re-capturing a request through a proxy.
 *
 * Usage:
 *   node scripts/sync-codex-fallback-instructions.mjs --version 0.163.0
 *   node scripts/sync-codex-fallback-instructions.mjs --version 0.163.0 --write
 *
 * Without --write it only reports whether the checked-in snapshot matches.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const targetPath = join(
  repoRoot,
  'packages/api/src/domains/cats/services/agents/providers/codex-model-catalog-instructions.ts',
);
const startMarker = 'export const CODEX_FALLBACK_MODEL_INSTRUCTIONS: string = [';
const endMarker = '\n].join(';

function parseArgs(argv) {
  const options = { version: null, write: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--write') options.write = true;
    else if (argv[i] === '--version' && argv[i + 1]) options.version = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/sync-codex-fallback-instructions.mjs [--version <v>] [--write]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return options;
}

function detectVersion() {
  const output = execFileSync('codex', ['--version'], { encoding: 'utf8' });
  const match = output.match(/codex-cli\s+(\S+)/);
  if (!match) throw new Error(`Could not parse codex version from: ${output.trim()}`);
  return match[1];
}

function currentText(source) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('Could not locate the instructions array');
  const body = source.slice(start + startMarker.length, end);
  return (
    body
      .split('\n')
      .map((line) => line.trim().replace(/,$/, ''))
      .filter(Boolean)
      // The checked-in array uses TypeScript single-quoted string literals, so
      // evaluate each literal instead of assuming JSON.
      .map((line) => new Function(`return ${line};`)())
      .join('\n')
  );
}

function renderArray(text) {
  return text
    .split('\n')
    .map((line) => `  ${JSON.stringify(line)},`)
    .join('\n');
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const options = parseArgs(process.argv.slice(2));
const version = options.version ?? detectVersion();
const url = `https://raw.githubusercontent.com/openai/codex/rust-v${version}/codex-rs/models-manager/prompt.md`;
const response = await fetch(url);
if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);

const upstream = (await response.text()).replace(/\r?\n$/, '');
const source = readFileSync(targetPath, 'utf8');
const current = currentText(source);
const matches = current === upstream;

console.log(`source: ${url}`);
console.log(`chars:  ${upstream.length}`);
console.log(`sha256: ${sha256(upstream)}`);
console.log(`match:  ${matches ? 'yes' : 'no'}`);

if (!matches && !options.write) {
  console.error('Snapshot differs from upstream; rerun with --write to update it.');
  process.exit(1);
}

if (options.write) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  const updated = `${source.slice(0, start + startMarker.length)}\n${renderArray(upstream)}${source.slice(end)}`;
  writeFileSync(targetPath, updated, 'utf8');
  console.log('updated:', targetPath);
  console.log('next: update the sha256 in the file header and test/codex-model-catalog.test.js');
}
