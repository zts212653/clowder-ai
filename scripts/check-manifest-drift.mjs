#!/usr/bin/env node
/**
 * F237 Manifest Drift Check
 *
 * Ensures `@segment ID` annotations in source code match the IDs declared in
 * `assets/prompt-injection-manifest.yaml`. Run as CI lint step.
 *
 * Exit 0 = aligned, Exit 1 = drift detected.
 *
 * Scan scope: all files listed as sources in the manifest YAML.
 * Also scans SystemPromptBuilder.ts for @segment comments.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const MANIFEST_PATH = join(ROOT, 'assets', 'prompt-injection-manifest.yaml');
const TEMPLATE_LOADER_PATH = join(ROOT, 'packages/api/src/domains/cats/services/context/prompt-template-loader.ts');

// ── 1. Load manifest ──────────────────────────────────────────

if (!existsSync(MANIFEST_PATH)) {
  console.error('ERROR: Manifest file not found at', MANIFEST_PATH);
  process.exit(1);
}

const raw = readFileSync(MANIFEST_PATH, 'utf-8');
const manifest = YAML.parse(raw);

if (!manifest?.segments || !Array.isArray(manifest.segments)) {
  console.error('ERROR: Invalid manifest — missing segments array');
  process.exit(1);
}

const manifestIds = new Set(manifest.segments.map((s) => s.id));
const activeIds = new Set(manifest.segments.filter((s) => !s._status?.startsWith('legacy')).map((s) => s.id));

// ── 2. Scan source files for @segment annotations ─────────────

const SEGMENT_PATTERN = /@segment\s+([A-Z]\d+)/g;

/**
 * Collects all `@segment XX` IDs found in a file.
 */
function extractSegmentIds(filePath) {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf-8');
  const ids = [];
  let match = SEGMENT_PATTERN.exec(content);
  while (match !== null) {
    ids.push(match[1]);
    match = SEGMENT_PATTERN.exec(content);
  }
  return ids;
}

// Gather unique source files from manifest
const sourceFiles = new Set();
for (const seg of manifest.segments) {
  if (seg.source?.endsWith('.ts')) {
    sourceFiles.add(join(ROOT, seg.source));
  }
}

// Also always scan the main SystemPromptBuilder
const builderPath = join(ROOT, 'packages/api/src/domains/cats/services/context/SystemPromptBuilder.ts');
sourceFiles.add(builderPath);

const codeIds = new Set();
for (const file of sourceFiles) {
  for (const id of extractSegmentIds(file)) {
    codeIds.add(id);
  }
}

// ── 3b. Extract template local-overlay registry from prompt-template-loader ──

function extractTemplateFileInfo() {
  if (!existsSync(TEMPLATE_LOADER_PATH)) return new Map();
  const loaderSource = readFileSync(TEMPLATE_LOADER_PATH, 'utf-8');
  const entries = new Map();
  const pattern = /([A-Z]\d+(?:_[a-z]+)?)\s*:\s*\{\s*base:\s*['"]([^'"]+)['"]\s*,\s*local:\s*['"]([^'"]*)['"]\s*\}/g;
  let match = pattern.exec(loaderSource);
  while (match !== null) {
    entries.set(match[1], { base: match[2], local: match[3] });
    match = pattern.exec(loaderSource);
  }
  return entries;
}

const templateFileInfo = extractTemplateFileInfo();

// ── 3. Compare ────────────────────────────────────────────────

const errors = [];

// IDs in manifest but missing @segment annotation in code
// Only check IDs whose source is a .ts file (hooks/L0 don't need code annotations)
const annotationRequired = new Set(manifest.segments.filter((s) => s.source?.endsWith('.ts')).map((s) => s.id));

for (const id of annotationRequired) {
  if (!codeIds.has(id)) {
    errors.push(`MISSING in code: @segment ${id} declared in manifest but no annotation found in source files`);
  }
}

// IDs found in code but not in manifest
for (const id of codeIds) {
  if (!manifestIds.has(id)) {
    errors.push(`ORPHAN in code: @segment ${id} found in source but not declared in manifest`);
  }
}

// ── 4. Validate manifest schema completeness ──────────────────

const REQUIRED_FIELDS = [
  'id',
  'name',
  'category',
  'lifecycleStage',
  'source',
  'sourceType',
  'trigger',
  'purpose',
  'userExplanation',
  'priority',
  'safetyTier',
  'transparencyTier',
  'governanceTier',
  'allowLocalOverride',
  'disableable',
  'consumer',
];

for (const seg of manifest.segments) {
  for (const field of REQUIRED_FIELDS) {
    if (seg[field] === undefined || seg[field] === null) {
      errors.push(`SCHEMA: segment ${seg.id} missing required field '${field}'`);
    }
  }
  // Safety constraint: readonly segments must have allowLocalOverride=false
  if (seg.safetyTier === 'readonly' && seg.allowLocalOverride !== false) {
    errors.push(`SAFETY: segment ${seg.id} is readonly but allowLocalOverride is not false`);
  }
  const loaderInfo = templateFileInfo.get(seg.id);
  if (loaderInfo) {
    const loaderAllowsLocalOverride = !!loaderInfo.local;
    if (loaderAllowsLocalOverride !== !!seg.allowLocalOverride) {
      errors.push(
        `LOCAL-OVERRIDE-DRIFT: segment ${seg.id} loader local=${loaderAllowsLocalOverride} but manifest allowLocalOverride=${seg.allowLocalOverride}`,
      );
    }
  }
}

for (const [id, info] of templateFileInfo.entries()) {
  if (!id.includes('_') && info.local && !manifestIds.has(id)) {
    errors.push(`LOCAL-OVERRIDE-DRIFT: loader segment ${id} has local overlay but is missing from manifest`);
  }
}

// ── 5. Validate template source files exist ──────────────────

for (const seg of manifest.segments) {
  if (seg.sourceType === 'template' && seg.source) {
    const tplPath = join(ROOT, seg.source);
    if (!existsSync(tplPath)) {
      errors.push(`TEMPLATE: segment ${seg.id} source file not found: ${seg.source}`);
    }
  }
}

// ── 6. Report ─────────────────────────────────────────────────

console.log(`F237 Manifest Drift Check`);
console.log(`  Manifest segments: ${manifestIds.size} (${activeIds.size} active)`);
console.log(`  Code annotations:  ${codeIds.size}`);
console.log(`  .ts sources scanned: ${sourceFiles.size}`);
console.log(`  Template registry: ${templateFileInfo.size}`);

if (errors.length === 0) {
  console.log('\n  All aligned. No drift detected.');
  process.exit(0);
} else {
  console.error(`\n  ${errors.length} issue(s) found:\n`);
  for (const err of errors) {
    console.error(`    - ${err}`);
  }
  process.exit(1);
}
