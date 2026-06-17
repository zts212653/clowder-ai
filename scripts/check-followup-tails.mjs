#!/usr/bin/env node

/**
 * F177 Phase A — Follow-up tail scan for CI guard.
 * Scans commit messages and PR body for deferred-work keywords
 * that indicate unresolved ACs being disguised as "follow-up".
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

const BLOCKED_PATTERNS = [
  /\bfollow[\s-]?up\b/i,
  /\bdeferred\b/i,
  /\bnext\s+phase\b/i,
  /\bnext\s+PR\b/i,
  /\bP2\s+(后续|follow|later|next)/i,
  /\bstub\b/i,
  /\bwill\s+address\s+later\b/i,
  /\bTD\b/,
  /\bout of scope\b/i,
  /MVP\s*先上/,
  /留个尾巴/,
  /先这样/,
  /下次一定/,
  /回头(再|补|做|处理)/,
  /以后再/,
  /后续(优化|完善|补充|处理|再)/,
  /迭代再补/,
];

const EXEMPT_PREFIXES = [
  /^Merge\b/i, // Merge subjects often include branch names such as fix/foo-followup.
  /^docs\(F\d+\):\s*(add\s+feature\s+spec|spec\s+follow[\s-]?up|fold\b.*\bspec\b)/i,
  /^docs\(F\d+\):\s*(update|expand|refine)\s+spec\b/i,
  /\[red\]/i, // TDD red-phase commits — "stub" is placeholder for failing tests, not deferred work
];

// Semantic exemptions: keywords used as programming/implementation terms,
// NOT as procrastination signals. The blanket regexes above catch any
// "stub" / "deferred" but conflate "we wrote a stub to defer rust
// compilation" (implementation noun) with "stubbed out, will do later"
// (procrastination verb). Patterns below match the implementation
// senses — line is skipped if any matches.
const SEMANTIC_EXEMPTIONS = [
  // "deferred" used as adjective for async/lazy execution (programming term):
  // "deferred catch-up", "deferred load", "deferred init", and variants with
  // an intermediate noun: "deferred embed catch-up" / "deferred sidecar load".
  /\bdeferred\b[\s\w-]{0,40}\b(catch[\s-]?up|initialization|load|loading|fetch|spawn|callback|fire|hook|event|task|operation|promise)\b/i,
  // "stub" used to describe Python module compatibility shim — common for
  // Windows ARM64 fastembed cases (py_rust_stemmers stub before pip install).
  // Matches "stub <package-name>", "<verb> stub for <package>", etc.
  /\bstub\b.*\b(snowball|stemmer|stemmers|py[-_]rust|fastembed|module|package|compat|shim|wheel|dep|dependency)/i,
  /\b(create|pre[-_]?create|write|add|register|install)\s+[\w-]+\s*stub\b/i,
  // "stub <name> for <library>" — pattern of "implementing a stub to satisfy
  // import-time symbol resolution" (a real engineering decision, not laziness)
  /\bstub\s+\w+\s+for\s+\w+/i,
];

function scanText(text, source) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Semantic exemption: skip line if it uses the keyword in a
    // programming/implementation sense rather than a procrastination
    // sense (see SEMANTIC_EXEMPTIONS).
    if (SEMANTIC_EXEMPTIONS.some((p) => p.test(line))) continue;
    for (const pattern of BLOCKED_PATTERNS) {
      const match = line.match(pattern);
      if (match) {
        hits.push({ source, line: i + 1, text: line.trim(), keyword: match[0] });
      }
    }
  }
  return hits;
}

function getCommitMessages() {
  if (process.argv.includes('--no-commits')) return '';
  try {
    const out = execFileSync('git', ['log', '--format=%s', 'origin/main..HEAD'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 10_000,
    });
    return out;
  } catch {
    return '';
  }
}

function getPrBody() {
  const prBodyPath = process.env.PR_BODY_FILE;
  if (prBodyPath) {
    try {
      return readFileSync(prBodyPath, 'utf-8');
    } catch {
      return '';
    }
  }
  return process.env.PR_BODY ?? '';
}

function isExemptCommit(message) {
  return EXEMPT_PREFIXES.some((p) => p.test(message));
}

function main() {
  const allHits = [];

  const commitText = getCommitMessages();
  if (commitText) {
    const commits = commitText.split('\n').filter(Boolean);
    for (const commit of commits) {
      if (isExemptCommit(commit)) continue;
      allHits.push(...scanText(commit, 'commit'));
    }
  }

  const prBody = getPrBody();
  if (prBody) {
    allHits.push(...scanText(prBody, 'pr-body'));
  }

  if (process.argv.includes('--stdin')) {
    const stdinText = readFileSync(0, 'utf-8');
    allHits.push(...scanText(stdinText, 'stdin'));
  }

  if (allHits.length === 0) {
    console.log('✅ No follow-up tails detected.');
    process.exit(0);
  }

  console.error('❌ Follow-up tails detected — these must be resolved before close/merge:');
  console.error('');
  for (const hit of allHits) {
    console.error(`  [${hit.source}] L${hit.line}: "${hit.keyword}" in: ${hit.text}`);
  }
  console.error('');
  console.error('Resolution: for each hit, choose one of:');
  console.error('  1. immediate — do it now in this PR');
  console.error('  2. delete(why) — remove the AC with justification');
  console.error('  3. cvo_signoff — get operator explicit approval to defer');
  console.error('');
  console.error('Schema: cat-cafe-skills/refs/close-gate.md');
  process.exit(1);
}

main();
