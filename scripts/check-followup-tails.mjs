#!/usr/bin/env node

/**
 * F177 — Follow-up tail guard.
 * Raw wording is a review clue; structured CloseGateReport state is the gate.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseCloseGateReportYaml, validateCloseGateReport } from './lib/close-gate-report.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

const CLUE_PATTERNS = [
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
  /^Merge\b/i,
  /^docs\(F\d+\):\s*(add\s+feature\s+spec|spec\s+follow[\s-]?up|fold\b.*\bspec\b)/i,
  /^docs\(F\d+\):\s*(update|expand|refine)\s+spec\b/i,
  /\[red\]/i,
];

const SEMANTIC_EXEMPTIONS = [
  /\bdeferred\b[\s\w-]{0,40}\b(catch[\s-]?up|initialization|load|loading|fetch|spawn|callback|fire|hook|event|task|operation|promise)\b/i,
  /\bdeferred\s*[≠!=<>]{1,2}\s*\w+/i,
  /\bstub\b.*\b(snowball|stemmer|stemmers|py[-_]rust|fastembed|module|package|compat|shim|wheel|dep|dependency)/i,
  /\b(create|pre[-_]?create|write|add|register|install)\s+[\w-]+\s*stub\b/i,
  /\bstub\s+\w+\s+for\s+\w+/i,
];

function scanText(text, source) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (SEMANTIC_EXEMPTIONS.some((pattern) => pattern.test(line))) continue;
    for (const pattern of CLUE_PATTERNS) {
      const match = line.match(pattern);
      if (match) {
        hits.push({ source, line: index + 1, text: line.trim(), keyword: match[0] });
      }
    }
  }
  return hits;
}

function getCommitMessages() {
  if (process.argv.includes('--no-commits')) return '';
  try {
    return execFileSync('git', ['log', '--format=%s', 'origin/main..HEAD'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 10_000,
    });
  } catch {
    return '';
  }
}

function getPrBody() {
  if (process.env.PR_BODY_FILE) {
    try {
      return readFileSync(process.env.PR_BODY_FILE, 'utf-8');
    } catch {
      return '';
    }
  }
  return process.env.PR_BODY ?? '';
}

function extractStructuredCandidates(text) {
  if (!text.includes('close_gate_report')) return [];

  const fenced = [];
  for (const match of text.matchAll(/```(?:ya?ml)?\s*\n([\s\S]*?)```/gi)) {
    if (match[1].includes('close_gate_report')) fenced.push(match[1]);
  }
  if (fenced.length > 0) return fenced;

  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*close_gate_report\s*:/.test(line));
  if (start < 0) return [];
  const nextHeading = lines.findIndex((line, index) => index > start && /^#{1,6}\s+/.test(line));
  return [lines.slice(start, nextHeading < 0 ? undefined : nextHeading).join('\n')];
}

function validateStructuredText(text, source) {
  const blockers = [];
  for (const candidate of extractStructuredCandidates(text)) {
    try {
      const report = parseCloseGateReportYaml(candidate);
      blockers.push(...validateCloseGateReport(report, source));
    } catch (error) {
      blockers.push(`[${source}] cannot parse close_gate_report: ${error.message}`);
    }
  }
  return blockers;
}

function main() {
  const clueHits = [];
  const semanticBlockers = [];
  const inputs = [];

  const commits = getCommitMessages().split('\n').filter(Boolean);
  for (const commit of commits) {
    if (!EXEMPT_PREFIXES.some((pattern) => pattern.test(commit))) {
      inputs.push({ text: commit, source: 'commit' });
    }
  }
  const prBody = getPrBody();
  if (prBody) inputs.push({ text: prBody, source: 'pr-body' });
  if (process.argv.includes('--stdin')) {
    inputs.push({ text: readFileSync(0, 'utf-8'), source: 'stdin' });
  }

  for (const input of inputs) {
    clueHits.push(...scanText(input.text, input.source));
    semanticBlockers.push(...validateStructuredText(input.text, input.source));
  }

  if (semanticBlockers.length > 0) {
    console.error('❌ CloseGateReport semantic blockers detected:\n');
    for (const blocker of semanticBlockers) console.error(`  ${blocker}`);
    console.error('\nSchema: cat-cafe-skills/refs/close-gate.md');
    process.exit(1);
  }

  if (clueHits.length > 0) {
    console.log('⚠️ Follow-up wording candidates require semantic review; wording alone does not block:\n');
    for (const hit of clueHits) {
      console.log(`  [${hit.source}] L${hit.line}: "${hit.keyword}" in: ${hit.text}`);
    }
    console.log('\nOnly unresolved structured CloseGateReport state blocks close/merge.');
    return;
  }

  console.log('✅ No follow-up tails detected.');
}

main();
