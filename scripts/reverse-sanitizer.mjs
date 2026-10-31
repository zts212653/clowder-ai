#!/usr/bin/env node
// reverse-sanitizer.mjs — F238 Phase D: detect-only reverse sanitizer.
//
// Scans files for boundary term violations:
//   outbound: home-only terms that shouldn't appear in public exports
//   inbound:  public-only terms that shouldn't appear in cat-cafe paths
//
// Usage:
//   node scripts/reverse-sanitizer.mjs --direction outbound file1 file2 ...
//   node scripts/reverse-sanitizer.mjs --direction inbound file1 file2 ...
//
// Output: one JSON line per finding on stdout; summary on stderr.
// Exit: 0 = clean, 1 = P0/P1 found, 2 = P2-only found.

import { readFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DICTIONARY_PATH = resolve(__dirname, '..', 'assets', 'brand-dictionary.yaml');

// ── Load dictionary ──

function loadDictionary() {
  const raw = readFileSync(DICTIONARY_PATH, 'utf-8');
  return YAML.parse(raw);
}

// ── Build term matchers from dictionary ──

/**
 * Build a list of { termId, severity, termClass, pattern (RegExp), canonical,
 *   suggestion, exceptions[] } for the given direction.
 *
 * outbound → scan for home terms (replace with public canonical)
 * inbound  → scan for public terms (replace with home canonical)
 */
function buildMatchers(dict, direction) {
  const terms = dict.terms || [];
  const topExceptions = dict.exceptions || [];
  const matchers = [];

  for (const term of terms) {
    const severity = term.severity || 'P3';
    const termClass = term.class;

    // Collect search patterns based on direction
    const srcSide = direction === 'outbound' ? term.home : term.public;
    const tgtSide = direction === 'outbound' ? term.public : term.home;

    const searchVariants = dedupeArray([
      ...(srcSide?.variants || []),
      ...(srcSide?.canonical ? [srcSide.canonical] : []),
    ]);

    if (searchVariants.length === 0) continue;

    // Collect per-term exceptions
    const termExceptions = (term.exceptions || []).map((e) => e.pattern);

    // Collect top-level exceptions that apply to this term's class
    for (const ex of topExceptions) {
      if (ex.class === termClass || ex.class === 'code_identifier') {
        termExceptions.push(...(ex.patterns || []));
      }
    }

    // Sort variants longest-first for deterministic iteration order;
    // actual overlap suppression happens in dedupeFindings()
    searchVariants.sort((a, b) => b.length - a.length);

    // Per-variant suggestion mapping (R3 + R4 fixes).
    //
    // Two cases determined by whether the target side has a canonical:
    //
    // 1. Target has canonical (e.g. role.co_creator: home.canonical = "co-creator"):
    //    All source variants are synonyms for the same concept → always suggest
    //    the canonical. Index mapping would be wrong because variant lists are
    //    NOT parallel (3 public variants vs 7 home variants).
    //
    // 2. Target has NO canonical (e.g. persona.private_nicknames):
    //    Variant lists are parallel by position → use index-based mapping.
    //    [Ragdoll, Maine Coon, Siamese] ↔ [宪宪, 砚砚, 烁烁]
    const srcVariants = srcSide?.variants || [];
    const tgtVariants = tgtSide?.variants || [];
    const tgtCanonical = tgtSide?.canonical || '';
    const defaultSuggestion = tgtCanonical || tgtVariants[0] || '';

    for (const variant of searchVariants) {
      let suggestion;
      if (tgtCanonical) {
        // Case 1: target has canonical — always use it
        suggestion = tgtCanonical;
      } else {
        // Case 2: no canonical — index-based parallel mapping
        const idx = srcVariants.indexOf(variant);
        suggestion = idx !== -1 && idx < tgtVariants.length ? tgtVariants[idx] : defaultSuggestion;
      }

      matchers.push({
        termId: term.id,
        severity,
        termClass,
        pattern: variant,
        regex: buildTermRegex(variant),
        suggestion,
        exceptions: termExceptions,
      });
    }
  }

  return matchers;
}

/**
 * Escape regex special chars, then wrap with context-aware boundaries.
 *
 * - If the first char is an ASCII word char ([A-Za-z0-9_]), prepend \b
 * - If the last char is an ASCII word char, append \b
 * - CJK and symbol-prefixed terms (e.g. @co-creator, co-creator) get no \b since
 *   CJK chars are \W and \b would mismatch.
 *
 * R1 fix: prevents substring false positives like "operatorId" → "operator".
 */
function buildTermRegex(variant) {
  const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const isAsciiWord = /[A-Za-z0-9_]/;
  const leading = isAsciiWord.test(variant[0]) ? '\\b' : '';
  const trailing = isAsciiWord.test(variant[variant.length - 1]) ? '\\b' : '';
  return new RegExp(`${leading}${escaped}${trailing}`, 'g');
}

function dedupeArray(arr) {
  return arr.filter((v, i, a) => a.indexOf(v) === i);
}

// ── Exception checking ──

/** Check if a matched string falls within an exception pattern. */
function isExcepted(matched, exceptions) {
  for (const exPattern of exceptions) {
    // Simple glob → check if matched text contains the exception core
    // e.g., "@cat-cafe/*" excepts any text containing "@cat-cafe/"
    const core = exPattern.replace(/\*/g, '').replace(/\/$/, '');
    if (core && matched.includes(core)) return true;

    // Also check if the matched text IS the exception pattern (minus globs)
    const exactCore = exPattern.replace(/\*+/g, '').trim();
    if (exactCore && matched.includes(exactCore)) return true;
  }
  return false;
}

// ── File scanners ──

/**
 * Scan a structured data object (parsed JSON/YAML) for term violations.
 * Returns findings with field-path locations (e.g., "$.app.title").
 */
function scanStructured(obj, matchers, filePath, direction, prefix = '$', stats = null) {
  const findings = [];

  if (typeof obj === 'string') {
    for (const m of matchers) {
      m.regex.lastIndex = 0;
      let match;
      while ((match = m.regex.exec(obj)) !== null) {
        if (!isExcepted(match[0], m.exceptions)) {
          findings.push({
            severity: m.severity,
            direction,
            file: filePath,
            location: prefix,
            termId: m.termId,
            termClass: m.termClass,
            matched: match[0],
            suggestion: m.suggestion,
          });
        } else if (stats) {
          stats.exceptionsConsumed++;
        }
      }
    }
  } else if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      findings.push(...scanStructured(obj[i], matchers, filePath, direction, `${prefix}[${i}]`, stats));
    }
  } else if (obj && typeof obj === 'object') {
    for (const [key, val] of Object.entries(obj)) {
      findings.push(...scanStructured(val, matchers, filePath, direction, `${prefix}.${key}`, stats));
    }
  }

  return findings;
}

/**
 * Scan a text file line by line for term violations.
 * Returns findings with line-number locations (e.g., "line:42").
 */
function scanText(content, matchers, filePath, direction, stats = null) {
  const findings = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const m of matchers) {
      m.regex.lastIndex = 0;
      let match;
      while ((match = m.regex.exec(line)) !== null) {
        if (!isExcepted(match[0], m.exceptions)) {
          findings.push({
            severity: m.severity,
            direction,
            file: filePath,
            location: `line:${i + 1}`,
            termId: m.termId,
            termClass: m.termClass,
            matched: match[0],
            suggestion: m.suggestion,
          });
        } else if (stats) {
          stats.exceptionsConsumed++;
        }
      }
    }
  }

  return findings;
}

/**
 * Scan a single file. Dispatches to structured or text scanner based on extension.
 */
function scanFile(filePath, matchers, direction, stats = null) {
  const content = readFileSync(filePath, 'utf-8');
  const ext = extname(filePath).toLowerCase();
  const relPath = relative(process.cwd(), filePath);

  if (ext === '.json') {
    try {
      const obj = JSON.parse(content);
      return scanStructured(obj, matchers, relPath, direction, '$', stats);
    } catch {
      // Fall back to text scanning if JSON parse fails
      return scanText(content, matchers, relPath, direction, stats);
    }
  }

  if (ext === '.yaml' || ext === '.yml') {
    try {
      const obj = YAML.parse(content);
      return scanStructured(obj, matchers, relPath, direction, '$', stats);
    } catch {
      return scanText(content, matchers, relPath, direction, stats);
    }
  }

  return scanText(content, matchers, relPath, direction, stats);
}

// ── Deduplicate findings ──

/**
 * Dedupe findings in two phases:
 *
 * Phase 1 — exact dedup + substring overlap suppression (R1 fix):
 *   - Remove exact (file, location, termId, matched) duplicates
 *   - When "Clowder AI Hub" and "Clowder AI" both match at the same location,
 *     keep only the longer match (product.hub wins over product.primary)
 *
 * Phase 2 — same-token dedup (R2 fix):
 *   - When the exact same matched text at the same (file, location) triggers
 *     multiple termIds (e.g. "operator" → role.co_creator P1 + role.cvo P2),
 *     keep only the highest-severity finding. Fail-safe for detect-only: if a
 *     token COULD be P1, report it as P1.
 */
function dedupeFindings(findings) {
  // Phase 1: Sort longest matches first, exact dedup + substring overlap suppression
  const sorted = [...findings].sort((a, b) => b.matched.length - a.matched.length);

  const exactSeen = new Set();
  const locationMatches = new Map(); // key: "file|location" → Set<matched string>

  const phase1 = sorted.filter((f) => {
    const exactKey = `${f.file}|${f.location}|${f.termId}|${f.matched}`;
    if (exactSeen.has(exactKey)) return false;
    exactSeen.add(exactKey);

    const locKey = `${f.file}|${f.location}`;
    const existing = locationMatches.get(locKey);
    if (existing) {
      for (const prev of existing) {
        if (prev !== f.matched && prev.includes(f.matched)) return false;
      }
    }

    if (!locationMatches.has(locKey)) locationMatches.set(locKey, new Set());
    locationMatches.get(locKey).add(f.matched);
    return true;
  });

  // Phase 2: Same-token dedup — when multiple termIds match the exact same text
  // at the same (file, location), keep only the highest-severity finding.
  const SEVERITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const tokenBest = new Map(); // key: "file|location|matched" → best finding

  for (const f of phase1) {
    const tokenKey = `${f.file}|${f.location}|${f.matched}`;
    const existing = tokenBest.get(tokenKey);
    if (!existing || (SEVERITY_RANK[f.severity] ?? 4) < (SEVERITY_RANK[existing.severity] ?? 4)) {
      tokenBest.set(tokenKey, f);
    }
  }

  return [...tokenBest.values()];
}

// ── CLI ──

function main() {
  const args = process.argv.slice(2);
  const dirIdx = args.indexOf('--direction');

  if (dirIdx === -1 || !args[dirIdx + 1]) {
    process.stderr.write('Error: --direction outbound|inbound is required.\n');
    process.exit(3);
  }

  const direction = args[dirIdx + 1];
  if (direction !== 'outbound' && direction !== 'inbound') {
    process.stderr.write(`Error: --direction must be "outbound" or "inbound", got "${direction}".\n`);
    process.exit(3);
  }

  const summaryJson = args.includes('--summary-json');

  // File args = everything that's not a known flag or its value
  const files = args.filter((a, i) => i !== dirIdx && i !== dirIdx + 1 && a !== '--summary-json');
  if (files.length === 0) {
    process.stderr.write('Error: at least one file path is required.\n');
    process.exit(3);
  }

  const dict = loadDictionary();
  const matchers = buildMatchers(dict, direction);
  const stats = { exceptionsConsumed: 0 };

  let allFindings = [];
  for (const file of files) {
    allFindings.push(...scanFile(file, matchers, direction, stats));
  }

  allFindings = dedupeFindings(allFindings);

  // Output findings as NDJSON on stdout
  for (const f of allFindings) {
    process.stdout.write(`${JSON.stringify(f)}\n`);
  }

  // --summary-json: emit structured counters as final stdout line
  if (summaryJson) {
    const byTermClass = {};
    const bySeverity = {};
    for (const f of allFindings) {
      byTermClass[f.termClass] = (byTermClass[f.termClass] || 0) + 1;
      bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
    }
    process.stdout.write(
      `${JSON.stringify({
        _type: 'summary',
        totalFindings: allFindings.length,
        byTermClass,
        bySeverity,
        exceptionsConsumed: stats.exceptionsConsumed,
      })}\n`,
    );
  }

  // Summary on stderr
  const p1Count = allFindings.filter((f) => f.severity === 'P0' || f.severity === 'P1').length;
  const p2Count = allFindings.filter((f) => f.severity === 'P2').length;
  const total = allFindings.length;

  if (total > 0) {
    process.stderr.write(`${total} violation(s) found (${p1Count} P0/P1, ${p2Count} P2).\n`);
  }

  // Exit codes: 0 = clean, 1 = P0/P1, 2 = P2-only
  if (p1Count > 0) process.exit(1);
  if (p2Count > 0) process.exit(2);
  process.exit(0);
}

main();
