#!/usr/bin/env node

/**
 * F177 Phase D — Fallback layer detection for quality-gate / PR review.
 * Scans git diff for fallback-pattern growth per file.
 * Exits 0 (info only) — this is a diagnostic tool, not a hard gate.
 * The quality-gate skill decides whether to block based on output.
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

const FALLBACK_PATTERNS = [
  { pattern: /\bcatch\s*(\(|{)/, label: 'try/catch' },
  { pattern: /\?\?\s/, label: '?? nullish coalesce' },
  { pattern: /\|\|\s/, label: '|| fallback' },
  { pattern: /\belse\s+if\b/, label: 'else if' },
  { pattern: /\bcatch\b.*\bfallback\b/i, label: 'catch+fallback' },
  { pattern: /\bdefault\s*:/, label: 'switch default' },
];

const CODE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function parseDiffFiles(out) {
  const fields = out.split('\0').filter(Boolean);
  const files = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (!status) throw new Error('git diff emitted a path without a status');
    const statusCode = status.at(0);
    const pathCount = /^[RC]$/.test(statusCode) ? 2 : 1;
    const paths = fields.slice(index, index + pathCount);
    if (paths.length !== pathCount) throw new Error(`git diff ${status} omitted a path`);
    index += pathCount;
    const currentPath = paths.at(-1);
    if (!currentPath) throw new Error(`git diff ${status} emitted an empty path`);
    if (statusCode !== 'D' && CODE_EXTENSIONS.test(currentPath)) files.push(currentPath);
  }
  return files;
}

function getDiffFiles() {
  const base = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'origin/main';
  try {
    const out = execFileSync('git', ['diff', '--name-status', '-z', '-M', `${base}...HEAD`], {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 10_000,
    });
    return parseDiffFiles(out);
  } catch (err) {
    console.error(`⚠️ git diff failed: ${err.message ?? err}`);
    process.exit(1);
  }
}

function getDiffContent(file) {
  try {
    const base = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'origin/main';
    return execFileSync('git', ['diff', `${base}...HEAD`, '--', file], {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 10_000,
    });
  } catch (err) {
    console.error(`⚠️ git diff failed for ${file}: ${err.message ?? err}`);
    process.exit(1);
  }
}

function countFallbacksInFile(file) {
  try {
    const content = execFileSync('git', ['show', `HEAD:${file}`], {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let total = 0;
    for (const line of content.split('\n')) {
      for (const { pattern } of FALLBACK_PATTERNS) {
        if (pattern.test(line)) {
          total++;
        }
      }
    }
    return total;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`⚠️ git show failed for current path ${file}: ${detail}`);
    process.exit(1);
  }
}

function countFallbacksInDiff(diff) {
  const added = [];
  const removed = [];

  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const content = line.slice(1);
      for (const { pattern, label } of FALLBACK_PATTERNS) {
        if (pattern.test(content)) {
          added.push({ label, line: content.trim() });
        }
      }
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      const content = line.slice(1);
      for (const { pattern, label } of FALLBACK_PATTERNS) {
        if (pattern.test(content)) {
          removed.push({ label, line: content.trim() });
        }
      }
    }
  }

  return { added: added.length, removed: removed.length, net: added.length - removed.length, details: added };
}

function main() {
  const files = getDiffFiles();
  if (files.length === 0) {
    console.log('ℹ️ No code files changed in diff.');
    process.exit(0);
  }

  const results = [];
  let totalNet = 0;

  for (const file of files) {
    const diff = getDiffContent(file);
    if (!diff) continue;
    const counts = countFallbacksInDiff(diff);
    if (counts.added > 0 || counts.removed > 0) {
      results.push({ file, ...counts });
      totalNet += counts.net;
    }
  }

  if (results.length === 0) {
    console.log('✅ No fallback pattern changes detected.');
    process.exit(0);
  }

  const NEW_LAYER_THRESHOLD = 3;
  const CUMULATIVE_THRESHOLD = 5;
  const warnings = results.filter((r) => r.added >= NEW_LAYER_THRESHOLD);

  const cumulativeWarnings = [];
  for (const r of results) {
    const total = countFallbacksInFile(r.file);
    r.totalInFile = total;
    if (total >= CUMULATIVE_THRESHOLD && !warnings.some((w) => w.file === r.file)) {
      cumulativeWarnings.push(r);
    }
  }

  console.log(`📊 Fallback layer analysis (${results.length} files with changes):`);
  console.log('');
  for (const r of results) {
    const perFileHit = r.added >= NEW_LAYER_THRESHOLD;
    const cumulativeHit = (r.totalInFile ?? 0) >= CUMULATIVE_THRESHOLD;
    const flag = perFileHit ? '⚠️ ' : cumulativeHit ? '⚡ ' : '  ';
    const totalTag = r.totalInFile != null ? ` [total=${r.totalInFile}]` : '';
    console.log(`${flag}${r.file}: +${r.added} -${r.removed} (net ${r.net >= 0 ? '+' : ''}${r.net})${totalTag}`);
    if (perFileHit || cumulativeHit) {
      for (const d of r.details.slice(0, 5)) {
        console.log(`     [${d.label}] ${d.line.slice(0, 80)}`);
      }
    }
  }
  console.log('');
  console.log(`Total net fallback change: ${totalNet >= 0 ? '+' : ''}${totalNet}`);

  if (warnings.length > 0 || cumulativeWarnings.length > 0) {
    console.log('');
    console.log('⚠️ Coordinate-system self-check triggered:');
    if (warnings.length > 0)
      console.log(`  Per-file threshold: ${warnings.length} file(s) added ≥${NEW_LAYER_THRESHOLD} layers`);
    if (cumulativeWarnings.length > 0)
      console.log(
        `  Cumulative threshold: ${cumulativeWarnings.length} file(s) have ≥${CUMULATIVE_THRESHOLD} total layers`,
      );
    console.log('  1. Is this fix repairing the coordinate system, or patching the wrong one?');
    console.log('  2. Could a coordinate transform (different problem decomposition) eliminate these layers?');
    console.log('  3. For each layer: why can it not be removed?');
  }

  if (process.env.F153_TELEMETRY === '1') {
    const metric = {
      event: 'fallback_layer_check',
      timestamp: new Date().toISOString(),
      totalFiles: files.length,
      filesWithChanges: results.length,
      totalNet,
      warnings: warnings.length,
      cumulativeWarnings: cumulativeWarnings.length,
      details: results.map((r) => ({ file: r.file, added: r.added, removed: r.removed, net: r.net })),
    };
    console.log('');
    console.log(`[telemetry] ${JSON.stringify(metric)}`);
  }

  process.exit(0);
}

main();
