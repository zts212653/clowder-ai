#!/usr/bin/env node
/**
 * F155: Generate guide catalog from YAML source files.
 *
 * Reads guides/registry.yaml + guides/flows/*.yaml and produces:
 *   packages/web/src/lib/guide-catalog.gen.ts
 *
 * Run: node scripts/gen-guide-catalog.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const GUIDES_DIR = resolve(ROOT, 'guides');
const REGISTRY_PATH = resolve(GUIDES_DIR, 'registry.yaml');
const VALID_ADVANCE_TYPES = new Set(['click', 'visible', 'input', 'confirm']);
/** Must match GUIDE_TARGET_RE in guide-registry-loader.ts */
const VALID_TARGET_RE = /^[a-zA-Z0-9._-]+$/;

function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) {
    throw new Error(`Registry not found: ${REGISTRY_PATH}`);
  }
  const raw = readFileSync(REGISTRY_PATH, 'utf-8');
  const parsed = YAML.parse(raw);
  if (!parsed?.guides || !Array.isArray(parsed.guides)) {
    throw new Error('Registry must contain a "guides" array');
  }
  return parsed.guides;
}

function loadFlow(flowFile) {
  const flowPath = resolve(GUIDES_DIR, flowFile);
  if (!existsSync(flowPath)) {
    throw new Error(`Flow file not found: ${flowPath}`);
  }
  const raw = readFileSync(flowPath, 'utf-8');
  return YAML.parse(raw);
}

/** Validate v2 OrchestrationFlow schema (tag-based engine). */
function validateFlow(flow) {
  const errors = [];
  if (!flow.id) errors.push('Missing flow.id');
  if (!flow.name) errors.push('Missing flow.name');
  if (!flow.steps || !Array.isArray(flow.steps)) {
    errors.push('Missing or invalid flow.steps');
    return errors;
  }
  const stepIds = new Set();
  for (const step of flow.steps) {
    if (!step.id) errors.push('Step missing id');
    if (stepIds.has(step.id)) errors.push(`Duplicate step id: ${step.id}`);
    stepIds.add(step.id);
    if (!step.target) {
      errors.push(`Step ${step.id}: missing target (data-guide-id)`);
    } else if (!VALID_TARGET_RE.test(step.target)) {
      errors.push(`Step ${step.id}: invalid target "${step.target}" (must match ${VALID_TARGET_RE})`);
    }
    if (!step.tips) errors.push(`Step ${step.id}: missing tips`);
    if (!step.advance) {
      errors.push(`Step ${step.id}: missing advance type`);
    } else if (!VALID_ADVANCE_TYPES.has(step.advance)) {
      errors.push(`Step ${step.id}: invalid advance type "${step.advance}"`);
    }
  }
  return errors;
}

/**
 * v2: No build-time TS generation — flows are fetched at runtime from API.
 * This script now only validates flow YAML schema integrity (CI gate).
 */

// Main — validate all registered flows
const registryEntries = loadRegistry();
let hasError = false;

for (const entry of registryEntries) {
  const flow = loadFlow(entry.flow_file);
  const errors = validateFlow(flow);
  if (errors.length > 0) {
    console.error(`\x1b[31m[F155] Flow ${entry.id} validation failed:\x1b[0m`);
    for (const e of errors) console.error(`  - ${e}`);
    hasError = true;
  } else {
    console.log(`  \x1b[32m✓\x1b[0m ${entry.id} (${flow.steps.length} steps)`);
  }
}

if (hasError) process.exit(1);
console.log(`\x1b[32m[F155] All ${registryEntries.length} guide flow(s) valid.\x1b[0m`);
