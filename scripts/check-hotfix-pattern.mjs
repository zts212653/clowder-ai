#!/usr/bin/env node

// Used by quality-gate (AC-E4) and merge-gate (AC-E1/E2).
// Local: node scripts/check-hotfix-pattern.mjs [--base REF] [--head REF]
// PR: PR_NUMBER=1463 node scripts/check-hotfix-pattern.mjs [1463]
// Write: node scripts/check-hotfix-pattern.mjs --apply-label 1463
// HOTFIX_BASE / HOTFIX_HEAD also select local revisions. With a PR they must
// resolve to that PR's exact base/head. PR selection always overrides cwd HEAD.
// Exit 0 = no hotfix, 2 = detected, 1 = failed/unknown (no analysis JSON).
// Successful analysis JSON is the last stdout line; label failures include labelError.

import { parseOptions, resolveTarget, run, verifyLabelTarget } from './lib/hotfix-target.mjs';

const HOTFIX_KEYWORDS = [
  /^(?:fix|hotfix)(?:\([^()\r\n]+\))?!?:/i,
  /\bquick\s*fix\b/i,
  /\bminimal\s*fix\b/i,
  /\bband[- ]?aid\b/i,
  /\btemp(orary)?\s*(fix|patch|workaround|solution|hack)\b/i,
  /\bworkaround\b/i,
];
const MAX_SINGLE_FILE_LINES = 50;
const isCode = (path) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path);
const matchesHotfix = (text) => HOTFIX_KEYWORDS.some((re) => re.test(text));

function analyzeDiff(scope) {
  const records = run('git', ['diff', '--numstat', '-z', scope.mergeBase, scope.head, '--']).split('\0');
  let codeFileCount = 0;
  let totalAdditions = 0;
  let binaryCode = false;
  for (let i = 0; i < records.length - 1; i++) {
    const record = records[i];
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (secondTab < 0) throw new Error('Invalid git numstat record');
    const additions = record.slice(0, firstTab);
    let path = record.slice(secondTab + 1);
    if (!path) {
      // -z encodes renamed/copied paths as two additional NUL fields.
      i++;
      path = records[++i];
      if (!path) throw new Error('Invalid git rename record');
    }
    if (!isCode(path)) continue;
    codeFileCount++;
    if (additions === '-') {
      binaryCode = true;
      continue;
    }
    if (!/^\d+$/.test(additions) || !Number.isSafeInteger(Number(additions)))
      throw new Error('Invalid git addition count');
    totalAdditions += Number(additions);
  }
  return { codeFileCount, totalAdditions, binaryCode };
}

function main() {
  const options = parseOptions(process.argv.slice(2), process.env);
  const target = resolveTarget(options);
  const { scope, snapshot } = target;
  const commits = run('git', ['log', `${scope.base}..${scope.head}`, '--format=%s']).trim();
  const commitLines = commits ? commits.split('\n') : [];
  const hotfixCommits = commitLines.filter(matchesHotfix);
  const prTitleMatch = snapshot ? matchesHotfix(snapshot.title) : false;
  const isHotfix = hotfixCommits.length > 0 || prTitleMatch;
  const { codeFileCount, totalAdditions, binaryCode } = analyzeDiff(scope);
  const autoLabel = isHotfix && codeFileCount === 1 && totalAdditions <= MAX_SINGLE_FILE_LINES && !binaryCode;
  let labelApplied = null;
  let labelError = null;
  if (options.applyLabel && autoLabel) {
    verifyLabelTarget(target);
    try {
      run('gh', ['pr', 'edit', scope.prNumber, '--repo', scope.repository, '--add-label', 'hotfix']);
      labelApplied = true;
    } catch (error) {
      labelApplied = false;
      labelError = String(error.stderr || error.message).trim();
    }
  }

  report(
    options,
    {
      scope,
      isHotfix,
      autoLabel,
      labelApplied,
      labelError,
      codeFileCount,
      totalAdditions,
      commitCount: commitLines.length,
    },
    hotfixCommits,
    prTitleMatch,
  );
  process.exitCode = labelError ? 1 : isHotfix ? 2 : 0;
}

function report(options, result, hotfixCommits, prTitleMatch) {
  const { scope, isHotfix, autoLabel, labelApplied, labelError, codeFileCount, totalAdditions, commitCount } = result;
  console.log('--- Hotfix Pattern Analysis (F177 Phase E) ---');
  console.log(
    `Scope: ${scope.kind === 'pr' ? `${scope.repository} PR #${scope.prNumber}` : 'local'} ${scope.base}..${scope.head}`,
  );
  console.log(`Commits analyzed: ${commitCount}`);
  console.log(`Hotfix keywords detected: ${isHotfix ? 'YES' : 'no'}`);
  if (prTitleMatch) console.log('  PR title matches hotfix pattern');
  if (hotfixCommits.length) {
    console.log('  Matching commits:');
    for (const commit of hotfixCommits) console.log(`    - ${commit}`);
  }
  console.log(`Code files changed: ${codeFileCount}`);
  console.log(`Total additions: ${totalAdditions}`);
  console.log(
    `Auto-label eligible (single file ≤${MAX_SINGLE_FILE_LINES} lines + keyword): ${autoLabel ? 'YES' : 'no'}`,
  );
  if (isHotfix) {
    console.log('\n⚠️  HOTFIX DETECTED — governance rules apply:');
    console.log('  1. Cross-cat review required (no self-merge)');
    console.log(
      '  2. Author self-checks quality-gate as usual; cross-cat review carries the risk (no second quality-gate run)',
    );
    console.log('  3. 2-week upgrade review cron will be registered on merge');
  }
  if (labelApplied) console.log('✅ hotfix label auto-added (single file ≤50 lines + keyword)');
  if (labelError) console.error(`❌ Failed to add hotfix label to PR #${scope.prNumber}: ${labelError}`);
  if (options.applyLabel && isHotfix && !autoLabel) {
    console.log(
      'ℹ️  Hotfix detected but NOT auto-labeling (multi-file, >50 lines or unknown line count). Cat/reviewer decides.',
    );
  }
  if (process.env.F153_TELEMETRY === '1') {
    console.log(
      JSON.stringify({
        metric: 'hotfix_pattern',
        isHotfix,
        hotfixCommitCount: hotfixCommits.length,
        prTitleMatch,
        codeFileCount,
        totalAdditions,
        autoLabel,
        labelApplied,
        labelError,
      }),
    );
  }
  console.log(
    JSON.stringify({
      hotfix: isHotfix,
      autoLabel,
      labelApplied,
      labelError,
      scope,
      commitCount,
      codeFileCount,
      totalAdditions,
    }),
  );
}

try {
  main();
} catch (error) {
  // merge-gate intentionally tolerates exit 2 and parses the last stdout line.
  // An unavailable analysis must therefore emit NO success-shaped JSON at all.
  console.error(`❌ Hotfix analysis failed: ${String(error.stderr || error.message).trim()}`);
  console.error('HOTFIX_ANALYSIS_UNAVAILABLE');
  process.exitCode = 1;
}
