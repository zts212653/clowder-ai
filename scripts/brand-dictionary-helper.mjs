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

const __dirname = dirname(fileURLToPath(import.meta.url));
const DICTIONARY_PATH = resolve(__dirname, '..', 'assets', 'brand-dictionary.yaml');

let _cached = null;

function loadDictionary() {
  if (_cached) return _cached;
  const raw = readFileSync(DICTIONARY_PATH, 'utf-8');
  _cached = parseDictionary(raw);
  return _cached;
}

function stripYamlInlineComment(value) {
  let quote = null;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      if (char === quote && value[i - 1] !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && (i === 0 || /\s/.test(value[i - 1] ?? ''))) return value.slice(0, i);
  }
  return value;
}

function parseScalar(value) {
  const trimmed = stripYamlInlineComment(value).trim();
  if (trimmed === '') return '';
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitKeyValue(text) {
  const idx = text.indexOf(':');
  if (idx === -1) return null;
  return [text.slice(0, idx).trim(), parseScalar(text.slice(idx + 1))];
}

function sectionHeaderName(line) {
  if (!/^\S/.test(line) || line.trim().startsWith('#')) return null;
  const trimmed = stripYamlInlineComment(line).trim();
  if (!trimmed.endsWith(':')) return null;
  return trimmed.slice(0, -1).trim();
}

function sectionLines(lines, sectionName) {
  const start = lines.findIndex((line) => sectionHeaderName(line) === sectionName);
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (sectionHeaderName(line)) break;
    out.push(line);
  }
  return out;
}

function lineBodyAfterDash(trimmedLine) {
  return trimmedLine.slice(2).trim();
}

function assignPair(target, text) {
  const pair = splitKeyValue(text);
  if (!pair) return false;
  target[pair[0]] = pair[1];
  return true;
}

function startTerm(trimmedLine) {
  const term = {};
  assignPair(term, lineBodyAfterDash(trimmedLine));
  return term;
}

function applyTermField(term, trimmedLine) {
  const pair = splitKeyValue(trimmedLine);
  if (!pair) return null;
  const [key, value] = pair;
  if (key === 'home' || key === 'public') {
    term[key] = {};
    return term[key];
  }
  term[key] = value;
  return null;
}

function applyNestedField(nested, trimmedLine) {
  const pair = splitKeyValue(trimmedLine);
  if (!pair || !nested) return null;
  const [key, value] = pair;
  if (value !== '') {
    nested[key] = value;
    return null;
  }
  nested[key] = [];
  return nested[key];
}

function isTermFieldLine(line) {
  return line.startsWith('    ') && !line.startsWith('      ');
}

function isNestedFieldLine(line) {
  return line.startsWith('      ') && !line.startsWith('        ');
}

function readTermLine(terms, state, line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return state;

  if (line.startsWith('  - ')) {
    const current = startTerm(trimmed);
    terms.push(current);
    return { current, nested: null, listTarget: null };
  }
  if (!state.current) return state;

  if (isTermFieldLine(line)) {
    return { current: state.current, nested: applyTermField(state.current, trimmed), listTarget: null };
  }

  if (isNestedFieldLine(line)) {
    return { ...state, listTarget: applyNestedField(state.nested, trimmed) };
  }

  if (line.startsWith('        - ') && state.listTarget) {
    state.listTarget.push(parseScalar(lineBodyAfterDash(trimmed)));
  }
  return state;
}

function parseTerms(lines) {
  const terms = [];
  let state = { current: null, nested: null, listTarget: null };
  for (const line of lines) state = readTermLine(terms, state, line);

  return terms;
}

function parsePathPolicies(lines) {
  const pathPolicies = [];
  let current = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (line.startsWith('  - ')) {
      current = {};
      pathPolicies.push(current);
      assignPair(current, lineBodyAfterDash(trimmed));
      continue;
    }
    if (!current || !line.startsWith('    ') || line.startsWith('      ')) continue;
    assignPair(current, trimmed);
  }

  return pathPolicies;
}

function parseDictionary(raw) {
  const lines = raw.split(/\r?\n/);
  return {
    terms: parseTerms(sectionLines(lines, 'terms')),
    path_policies: parsePathPolicies(sectionLines(lines, 'path_policies')),
  };
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
