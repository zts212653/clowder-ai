#!/usr/bin/env node
/**
 * F056 Phase F - DESIGN.md gate.
 *
 * Lints the repo-root DESIGN.md through the `@google/design.md` programmatic
 * linter and fails on any error or warning. We start at zero, so the gate is
 * strict: a new warning means a token/prose drift and must be fixed, not
 * accumulated.
 *
 * The linter is imported, never spawned: the package ships two bin aliases and
 * the dotted one collides with Markdown file associations on Windows, so a
 * spawned bin would make the exported public `check` chain platform-dependent.
 *
 * Usage: node scripts/check-design-md.mjs [path/to/DESIGN.md]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lint } from '@google/design.md/linter';

export function lintDesignMd(file) {
  const report = lint(readFileSync(file, 'utf8'));
  if (!Array.isArray(report.findings)) {
    throw new Error(`design.md lint report has no "findings" array (keys: ${Object.keys(report).join(', ')})`);
  }
  const diagnostics = report.findings.filter((d) => d.severity === 'error' || d.severity === 'warning');
  return { ok: diagnostics.length === 0, diagnostics, summary: report.summary ?? {} };
}

function main() {
  const file = resolve(process.argv[2] ?? 'DESIGN.md');
  const { ok, diagnostics, summary } = lintDesignMd(file);
  if (ok) {
    console.log(`design.md gate: ${file} clean (errors=0 warnings=0)`);
    return 0;
  }
  console.error(`design.md gate: ${file} has ${diagnostics.length} finding(s) (summary: ${JSON.stringify(summary)})`);
  for (const d of diagnostics) console.error(`  [${d.severity}] ${d.rule}: ${d.message}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
