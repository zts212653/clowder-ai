/**
 * check:env-example — CI gate for .env.example ↔ env-registry consistency.
 *
 * Two checks:
 *   1. Every key in .env.example must be in registry OR in the example-allowlist.
 *   2. Every registry entry with `exampleRecommended: true` must appear in .env.example.
 *
 * Run: `node --test scripts/check-env-example.test.mjs`
 * Wire: `pnpm check:env-example` in root package.json
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');

// ── Allowlist: vars in .env.example that are NOT in env-registry ──
// (e.g. consumed by scripts/docker-compose, not by TypeScript code)
const EXAMPLE_ALLOWLIST = new Map([
  ['QUOTA_BROWSER_MODE', 'Consumed by quota browser scripts, not TypeScript'],
  ['QUOTA_BROWSER_CDP_PORT', 'Consumed by quota browser scripts, not TypeScript'],
  ['QUOTA_BROWSER_PROFILE_DIR', 'Consumed by quota browser scripts, not TypeScript'],
  ['QUOTA_BROWSER_HEADLESS', 'Consumed by quota browser scripts, not TypeScript'],
  ['QUOTA_BROWSER_AUTO_START', 'Consumed by quota browser scripts, not TypeScript'],
  ['QUOTA_BROWSER_AUTO_RESTART', 'Consumed by quota browser scripts, not TypeScript'],
  ['CAT_OPUS_MODEL', 'Dynamic per-cat model override (pattern: CAT_{ID}_MODEL)'],
  ['CAT_CODEX_MODEL', 'Dynamic per-cat model override (pattern: CAT_{ID}_MODEL)'],
  ['CAT_GEMINI_MODEL', 'Dynamic per-cat model override (pattern: CAT_{ID}_MODEL)'],
  ['NEXT_PUBLIC_BRAND_NAME', 'Consumed by Next.js frontend at build time, not TypeScript API'],
  ['REDIS_PORT', 'Consumed by Docker Compose / shell scripts, not TypeScript API directly'],
  ['ASR_ENABLED', 'Voice service toggle consumed by Python sidecar, not TypeScript API'],
  ['TTS_ENABLED', 'Voice service toggle consumed by Python sidecar, not TypeScript API'],
  ['LLM_POSTPROCESS_ENABLED', 'Voice service toggle consumed by Python sidecar, not TypeScript API'],
]);

// ── Parse .env.example keys ──
function parseExampleKeys() {
  const content = readFileSync(join(ROOT, '.env.example'), 'utf-8');
  const keys = new Set();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Active assignment: VAR_NAME=value
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match) {
      keys.add(match[1]);
      continue;
    }
    // Commented-out assignment: # VAR_NAME=value
    const commentedMatch = trimmed.match(/^#\s*([A-Za-z_][A-Za-z0-9_]*)=/);
    if (commentedMatch) keys.add(commentedMatch[1]);
  }
  return keys;
}

// ── Extract registered names + exampleRecommended from env-registry.ts ──
function loadRegistryInfo() {
  const src = readFileSync(join(ROOT, 'packages/api/src/config/env-registry.ts'), 'utf-8');
  const allNames = new Set();
  const recommended = new Set();

  // Parse each { ... } object in ENV_VARS (both single-line and multi-line)
  const objPattern = /\{([^}]+)\}/gs;
  for (const block of src.matchAll(objPattern)) {
    const body = block[1];
    const nameMatch = body.match(/name:\s*['"]([A-Z_][A-Z0-9_]*)['"]/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    allNames.add(name);
    if (/exampleRecommended:\s*true/.test(body)) {
      recommended.add(name);
    }
  }

  return { allNames, recommended };
}

// ── Tests ──
describe('.env.example ↔ env-registry consistency', () => {
  const exampleKeys = parseExampleKeys();
  const { allNames, recommended } = loadRegistryInfo();

  it('every .env.example key is in registry or example-allowlist', () => {
    const orphans = [];
    for (const key of exampleKeys) {
      if (!allNames.has(key) && !EXAMPLE_ALLOWLIST.has(key)) {
        orphans.push(key);
      }
    }
    if (orphans.length > 0) {
      assert.fail(
        `${orphans.length} key(s) in .env.example not found in env-registry.ts:\n` +
          orphans.map((k) => `  ${k}`).join('\n') +
          '\n\nFix: register in env-registry.ts, or add to EXAMPLE_ALLOWLIST in this script with a reason.',
      );
    }
  });

  it('every exampleRecommended registry entry appears in .env.example', () => {
    const missing = [];
    for (const name of recommended) {
      if (!exampleKeys.has(name)) {
        missing.push(name);
      }
    }
    if (missing.length > 0) {
      assert.fail(
        `${missing.length} env var(s) marked exampleRecommended but missing from .env.example:\n` +
          missing.map((k) => `  ${k}`).join('\n') +
          '\n\nFix: add to .env.example (as assignment or commented placeholder).',
      );
    }
  });

  it('every example-allowlist entry has a non-empty reason', () => {
    for (const [name, reason] of EXAMPLE_ALLOWLIST) {
      assert.ok(reason && reason.length > 0, `EXAMPLE_ALLOWLIST entry "${name}" has no reason`);
    }
  });

  it('no example-allowlist entry that is actually registered (redundant)', () => {
    const redundant = [];
    for (const name of EXAMPLE_ALLOWLIST.keys()) {
      if (allNames.has(name)) {
        redundant.push(name);
      }
    }
    if (redundant.length > 0) {
      assert.fail(
        `These EXAMPLE_ALLOWLIST entries are already in env-registry (remove from allowlist): ${redundant.join(', ')}`,
      );
    }
  });
});
