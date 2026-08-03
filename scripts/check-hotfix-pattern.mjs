#!/usr/bin/env node

// Detects hotfix patterns in commit messages AND PR titles.
// Used by quality-gate (AC-E4) and merge-gate (AC-E1/E2).
//
// Usage:
//   node scripts/check-hotfix-pattern.mjs                    # scan commits only
//   PR_NUMBER=1463 node scripts/check-hotfix-pattern.mjs     # also scan PR title
//   node scripts/check-hotfix-pattern.mjs --apply-label 1463 # detect + add label
//
// Exit codes: 0 = no hotfix, 2 = hotfix detected.
// Structured output: last line is JSON { hotfix: bool, autoLabel: bool }.

import { execSync } from 'node:child_process';

const HOTFIX_KEYWORDS = [
  /\bfix:/i,
  /\bhotfix:/i,
  /\bquick\s*fix\b/i,
  /\bminimal\s*fix\b/i,
  /\bband[- ]?aid\b/i,
  /\btemp(orary)?\s*(fix|patch|workaround|solution|hack)\b/i,
  /\bworkaround\b/i,
];

const MAX_SINGLE_FILE_LINES = 50;

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function matchesHotfix(text) {
  return HOTFIX_KEYWORDS.some((re) => re.test(text));
}

// --- Scan commit messages ---
const base = process.env.HOTFIX_BASE || 'origin/main';
const commits = run(`git log ${base}..HEAD --format="%s"`);
const commitLines = commits ? commits.split('\n') : [];
const hotfixCommits = commitLines.filter(matchesHotfix);

// --- Scan PR title (if PR_NUMBER or --apply-label provided) ---
const applyLabelIdx = process.argv.indexOf('--apply-label');
const prNumber = applyLabelIdx >= 0 ? process.argv[applyLabelIdx + 1] : process.env.PR_NUMBER;
let prTitleMatch = false;
if (prNumber) {
  const prTitle = run(`gh pr view ${prNumber} --json title --jq '.title'`);
  if (prTitle && matchesHotfix(prTitle)) {
    prTitleMatch = true;
  }
}

const isHotfix = hotfixCommits.length > 0 || prTitleMatch;

// --- Diff analysis for auto-label eligibility ---
const diffFiles = run(`git diff --name-only ${base}..HEAD`);
const fileList = diffFiles ? diffFiles.split('\n').filter(Boolean) : [];
const codeFiles = fileList.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f));

let totalAdditions = 0;
const numstat = run(`git diff ${base}..HEAD --numstat`);
if (numstat) {
  for (const line of numstat.split('\n')) {
    const [additions, , filePath] = line.split('\t');
    if (filePath && /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) {
      totalAdditions += Number.parseInt(additions, 10) || 0;
    }
  }
}

const isSingleFile = codeFiles.length === 1;
const isSmallChange = totalAdditions <= MAX_SINGLE_FILE_LINES;
const autoLabel = isHotfix && isSingleFile && isSmallChange;

// --- Output ---
console.log('--- Hotfix Pattern Analysis (F177 Phase E) ---');
console.log(`Hotfix keywords detected: ${isHotfix ? 'YES' : 'no'}`);
if (prTitleMatch) console.log('  PR title matches hotfix pattern');
if (hotfixCommits.length > 0) {
  console.log('  Matching commits:');
  for (const c of hotfixCommits) console.log(`    - ${c}`);
}
console.log(`Code files changed: ${codeFiles.length}`);
console.log(`Total additions: ${totalAdditions}`);
console.log(`Auto-label eligible (single file ≤${MAX_SINGLE_FILE_LINES} lines + keyword): ${autoLabel ? 'YES' : 'no'}`);

if (isHotfix) {
  console.log('\n⚠️  HOTFIX DETECTED — governance rules apply:');
  console.log('  1. Cross-cat review required (no self-merge)');
  console.log('  2. Author cannot self-validate quality-gate');
  console.log('  3. 2-week upgrade review cron will be registered on merge');
}

// --- Apply label (only when auto-label eligible: single file ≤50 lines + keyword) ---
let labelApplied = null;
let labelError = null;
if (applyLabelIdx >= 0 && prNumber && autoLabel) {
  try {
    execSync(`gh pr edit ${prNumber} --add-label hotfix`, { encoding: 'utf-8', stdio: 'pipe' });
    console.log('✅ hotfix label auto-added (single file ≤50 lines + keyword)');
    labelApplied = true;
  } catch (e) {
    labelApplied = false;
    labelError = (e.stderr || e.message).trim();
    console.error(`❌ Failed to add hotfix label to PR #${prNumber}: ${labelError}`);
  }
} else if (applyLabelIdx >= 0 && prNumber && isHotfix && !autoLabel) {
  console.log('ℹ️  Hotfix detected but NOT auto-labeling (multi-file or >50 lines). Cat/reviewer decides.');
}

if (process.env.F153_TELEMETRY === '1') {
  console.log(
    JSON.stringify({
      metric: 'hotfix_pattern',
      isHotfix,
      hotfixCommitCount: hotfixCommits.length,
      prTitleMatch,
      codeFileCount: codeFiles.length,
      totalAdditions,
      autoLabel,
      labelApplied,
      labelError,
    }),
  );
}

// --- Structured output (machine-readable, MUST be last stdout line) ---
console.log(JSON.stringify({ hotfix: isHotfix, autoLabel, labelApplied, labelError }));

process.exit(isHotfix ? 2 : 0);
