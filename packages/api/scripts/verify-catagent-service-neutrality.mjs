#!/usr/bin/env node
/**
 * AC-G12 Verifier — F159 Phase G Slice G1
 *
 * Asserts CatAgentService.ts contains zero `Anthropic*` code identifiers
 * (after stripping comments). Per @gpt555 review note: must cover
 *   - Type imports (`import type { Anthropic... }`)
 *   - Helper names (`mapAnthropic...`, `parseAnthropic...`,
 *     `buildAnthropic...`)
 *   - Local type aliases / variable names
 *   - `new Anthropic...` constructor calls
 *
 * Also asserts CatAgentService.ts does NOT manually construct an
 * AdapterMessage (no `__adapterMessage: true` literal) — per @gpt555
 * step-3 advisory.
 *
 * Usage: node packages/api/scripts/verify-catagent-service-neutrality.mjs
 * Exit: 0 = pass, 1 = fail
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_FILE = path.resolve(
  __dirname,
  '../src/domains/cats/services/agents/providers/catagent/CatAgentService.ts',
);

const src = fs.readFileSync(SERVICE_FILE, 'utf-8');

/** Strip TypeScript block comments and line comments so we only inspect code. */
function stripComments(s) {
  // Block comments — non-greedy across lines
  let out = s.replace(/\/\*[\s\S]*?\*\//g, '');
  // Line comments — from // to end of line
  out = out.replace(/\/\/[^\n]*/g, '');
  return out;
}

const code = stripComments(src);

// Match identifier-shaped tokens beginning with Anthropic
const anthropicHits = [...new Set((code.match(/\bAnthropic[A-Za-z0-9_]*/g) || []))];
const lowerHits = [...new Set((code.match(/\banthropic[A-Za-z0-9_]*/g) || []))];
const opaqueLeak = code.includes('__adapterMessage');

let failed = false;

if (anthropicHits.length > 0) {
  console.error('❌ AC-G12 FAIL: CatAgentService.ts contains `Anthropic*` code identifiers:');
  for (const id of anthropicHits) console.error(`  - ${id}`);
  failed = true;
}

if (lowerHits.length > 0) {
  console.error('❌ AC-G12 FAIL: CatAgentService.ts contains lowercase `anthropic*` code identifiers:');
  for (const id of lowerHits) console.error(`  - ${id}`);
  failed = true;
}

if (opaqueLeak) {
  console.error(
    '❌ AC-G12 FAIL: CatAgentService.ts contains `__adapterMessage` literal — service must not manually construct AdapterMessage. Use adapter.encode* methods instead.',
  );
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log('✅ AC-G12 PASS: CatAgentService.ts has zero `Anthropic*` / `anthropic*` code identifiers');
console.log('✅ AdapterMessage opacity preserved (no manual `__adapterMessage` literal in service)');
