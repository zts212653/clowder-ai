#!/usr/bin/env node
// brand-dictionary-helper.mjs — Parse assets/brand-dictionary.yaml and provide
// path classification + term lists for bash scripts and Node consumers.
//
// F238 Phase C: single source of truth for inbound classification.
//
// CLI usage (from bash):
//   node scripts/brand-dictionary-helper.mjs --classify-path <path>
//   node scripts/brand-dictionary-helper.mjs --manual-port-patterns
//   node scripts/brand-dictionary-helper.mjs --brand-sensitive-patterns
//   node scripts/brand-dictionary-helper.mjs --home-terms
//   node scripts/brand-dictionary-helper.mjs --public-terms
//
// Module usage (from Node):
//   import { classifyPath, getHomeTerms, getPublicTerms, getBrandSensitivePatterns } from './brand-dictionary-helper.mjs';

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import jsYaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DICTIONARY_PATH = resolve(__dirname, '..', 'assets', 'brand-dictionary.yaml');

let _cached = null;

function loadDictionary() {
  if (_cached) return _cached;
  const raw = readFileSync(DICTIONARY_PATH, 'utf-8');
  _cached = jsYaml.load(raw);
  return _cached;
}

/**
 * Convert a dictionary glob pattern to a regex.
 * Supports: ** (any depth), * (single segment chars), exact match.
 */
function globToRegex(pattern) {
  // Escape regex special chars except * and **
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<GLOBSTAR>>>/g, '.*');
  return new RegExp(`^${re}$`);
}

/**
 * Classify a file path according to dictionary path_policies.
 * Returns { classification, risk, reason }.
 */
export function classifyPath(filePath) {
  const dict = loadDictionary();
  const policies = dict.path_policies || [];

  for (const policy of policies) {
    const re = globToRegex(policy.pattern);
    if (re.test(filePath)) {
      const inbound = policy.inbound || 'safe-cherry-pick';
      return {
        classification: inbound,
        risk: policy.risk || null,
        reason: policy.reason || null,
      };
    }
  }

  return { classification: 'safe-cherry-pick', risk: null, reason: null };
}

/**
 * Get all home-only terms for brand validation.
 * Returns [{ id, severity, homePatterns: string[] }].
 */
export function getHomeTerms() {
  const dict = loadDictionary();
  const terms = dict.terms || [];

  return terms.map((t) => ({
    id: t.id,
    severity: t.severity || 'P3',
    termClass: t.class,
    homePatterns: [...(t.home?.variants || []), ...(t.home?.canonical ? [t.home.canonical] : [])].filter(
      (v, i, a) => a.indexOf(v) === i,
    ), // dedupe
  }));
}

/**
 * Get public-side terms for inbound contamination detection.
 * Returns [{ id, severity, publicPatterns: string[] }].
 */
export function getPublicTerms() {
  const dict = loadDictionary();
  const terms = dict.terms || [];

  return terms
    .filter((t) => t.public)
    .map((t) => ({
      id: t.id,
      severity: t.severity || 'P3',
      termClass: t.class,
      publicPatterns: [...(t.public?.variants || []), ...(t.public?.canonical ? [t.public.canonical] : [])].filter(
        (v, i, a) => a.indexOf(v) === i,
      ), // dedupe
    }));
}

/**
 * Get glob patterns for brand-sensitive paths.
 */
export function getBrandSensitivePatterns() {
  const dict = loadDictionary();
  const policies = dict.path_policies || [];
  return policies.filter((p) => p.inbound === 'brand-sensitive').map((p) => p.pattern);
}

/**
 * Get glob patterns for manual-port paths.
 */
export function getManualPortPatterns() {
  const dict = loadDictionary();
  const policies = dict.path_policies || [];
  return policies.filter((p) => p.inbound === 'manual-port').map((p) => p.pattern);
}

// ── CLI interface ──
const args = process.argv.slice(2);

if (args[0] === '--classify-path' && args[1]) {
  const result = classifyPath(args[1]);
  console.log(JSON.stringify(result));
} else if (args[0] === '--manual-port-patterns') {
  for (const p of getManualPortPatterns()) console.log(p);
} else if (args[0] === '--brand-sensitive-patterns') {
  for (const p of getBrandSensitivePatterns()) console.log(p);
} else if (args[0] === '--home-terms') {
  console.log(JSON.stringify(getHomeTerms(), null, 2));
} else if (args[0] === '--public-terms') {
  console.log(JSON.stringify(getPublicTerms(), null, 2));
}
