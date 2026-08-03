#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkReviewEntryMode, evaluateReviewEntryFixtureScenario, reviewModeFor } from './review-entry-mode.mjs';
import { checkReviewContinuityLanguage, checkReviewRoutingSurfaces } from './review-routing-surface-guard.mjs';

export { checkReviewContinuityLanguage };

const EXTERNAL_REVIEW = /(?:external|外部).{0,20}(?:pull request|pr|review|复审)|github.{0,20}(?:review|复审)/is;
const VERDICT = /\b(?:approve|approved|block|blocked|changes.requested|p[012])\b|放行|退回|结论/is;
const GITHUB_PROOF =
  /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:pull\/\d+(?:\/files)?#(?:pullrequestreview-|discussion_r|issuecomment-|r)\d+|issues\/\d+#issuecomment-\d+)/i;
const PENDING_CUSTODY = /pending_delivery[\s\S]*owner\s*=[^\s;]+[\s\S]*reason\s*=[^\n;]+/i;
const COMPLETE_CLAIM = /\b(?:complete|completed|done|finished|closed)\b|已完成|完成态|已闭环|闭环完成/is;
const LOCAL_HANDOFF_SOURCES = new Set(['mention', 'cross_thread']);
const EXACT_REVISION = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const BIRTH_CERTIFICATE_FIELDS = [
  'utilityClaim',
  'estimator',
  'validityBounds',
  'consumer',
  'calibrationPlan',
  'repeatabilityContract',
  'sunsetPolicy',
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Intent is provenance-owned. Repository names and shared GitHub logins are
 * deliberately absent: neither says who authored the work or who holds review custody.
 */
export function classifyReviewCompletionIntent(input) {
  if (!isRecord(input) || !isRecord(input.author)) return 'unknown';
  const authorKind = input.author.kind;
  const custody = input.custody;
  const handoffSource = input.handoffSource;
  if (custody === 'external_subject' || authorKind === 'external') return 'external';
  if (authorKind === 'local_cat' && custody === 'local_cat_handoff' && LOCAL_HANDOFF_SOURCES.has(handoffSource)) {
    return 'local_cat';
  }
  return 'unknown';
}

function checkExactRevision(target) {
  const errors = [];
  if (!nonEmptyString(target.revision.kind) || !EXACT_REVISION.test(target.revision.value ?? '')) {
    errors.push('Review completion requires a canonical 40- or 64-character exact revision digest.');
  }
  if (target.kind === 'pull_request' && target.revision.kind !== 'head_sha') {
    errors.push('Pull request completion must bind an exact head_sha.');
  }
  if (target.kind === 'issue' && target.revision.kind !== 'body_sha') {
    errors.push('Issue completion must bind an exact body_sha.');
  }
  if (
    ['pull_request', 'issue'].includes(target.kind) &&
    (!/^[^/\s]+\/[^/\s]+$/.test(target.repository ?? '') || !Number.isInteger(target.number) || target.number < 1)
  ) {
    errors.push('GitHub review completion requires an exact repository and positive subject number.');
  }
  return errors;
}

function checkExactTarget(target, evidenceRefs) {
  if (!isRecord(target) || !isRecord(target.revision)) {
    return ['Review completion requires an exact target revision.'];
  }

  const errors = checkExactRevision(target);
  if (!['pull_request', 'issue', 'commit', 'document'].includes(target.kind)) {
    errors.push('Review completion target kind is unsupported.');
  }
  if (
    !Array.isArray(evidenceRefs) ||
    !evidenceRefs.some((ref) => nonEmptyString(ref) && ref.includes(target.revision.value ?? ''))
  ) {
    errors.push('Review completion evidence must bind the exact target revision.');
  }
  return errors;
}

export function checkReviewEntry(input) {
  return checkReviewEntryMode(input, {
    classifyIntent: classifyReviewCompletionIntent,
    checkExactTarget,
  });
}

function isSameTargetGitHubArtifact(urlText, target) {
  if (!isRecord(target) || !['pull_request', 'issue'].includes(target.kind)) return false;
  try {
    const url = new URL(urlText);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return false;
    const repository = target.repository.toLowerCase();
    const path = url.pathname.replace(/\/+$/, '').toLowerCase();
    if (target.kind === 'pull_request') {
      const expected = `/${repository}/pull/${target.number}`;
      if (path !== expected && path !== `${expected}/files`) return false;
      return /^#(?:pullrequestreview-|discussion_r|issuecomment-|r)\d+$/.test(url.hash.toLowerCase());
    }
    return path === `/${repository}/issues/${target.number}` && /^#issuecomment-\d+$/.test(url.hash.toLowerCase());
  } catch {
    return false;
  }
}

function checkExternalCompletionRoute(route, target) {
  if (
    isRecord(route) &&
    route.kind === 'github_artifact' &&
    nonEmptyString(route.url) &&
    isSameTargetGitHubArtifact(route.url, target)
  ) {
    return [];
  }
  return ['External review completion requires a same-target GitHub artifact URL.'];
}

function checkLocalCompletionRoute(input, route) {
  const errors = [];
  const authorCatId = input.author.catId;
  const reviewerCatId = isRecord(input.reviewer) ? input.reviewer.catId : undefined;
  if (!nonEmptyString(authorCatId) || !nonEmptyString(reviewerCatId) || authorCatId === reviewerCatId) {
    errors.push('Local review independence requires distinct catIds; a shared GitHub login is not identity.');
  }

  const validCarrier = isRecord(route) && ['mention', 'cross_thread'].includes(route.carrier);
  const validCrossThread = route?.carrier !== 'cross_thread' || nonEmptyString(route.threadId);
  if (
    !isRecord(route) ||
    route.kind !== 'cat_handoff' ||
    route.targetCatId !== authorCatId ||
    !validCarrier ||
    !validCrossThread
  ) {
    errors.push('Local review completion requires a legal author cat route by mention or cross-thread handoff.');
  }
  return errors;
}

export function checkReviewCompletion(input) {
  const errors = [];
  const intent = classifyReviewCompletionIntent(input);
  if (!isRecord(input) || !isRecord(input.completion)) {
    return { ok: false, intent, errors: ['Review completion payload is missing.'] };
  }
  if (input.completion.status !== 'complete') {
    errors.push('Only a complete review may enter the completion guard.');
  }
  const mode = reviewModeFor(input);
  if (mode === 'unknown') {
    errors.push('Review completion mode must be formal or advisory_read_only.');
  }
  if (mode === 'advisory_read_only') {
    errors.push('advisory_read_only may not enter review-complete state.');
  }
  errors.push(...checkExactTarget(input.target, input.completion.evidenceRefs));

  const route = input.completion.route;
  if (intent === 'external') {
    errors.push(...checkExternalCompletionRoute(route, input.target));
  } else if (intent === 'local_cat') {
    errors.push(...checkLocalCompletionRoute(input, route));
  } else {
    errors.push('Review completion provenance is contradictory or insufficient; intent must fail closed.');
  }
  return { ok: errors.length === 0, intent, errors };
}

function evaluateFixtureScenario(pair, variant) {
  const scenario = isRecord(pair) ? pair[variant] : null;
  const pairId = pair?.id ?? 'unknown';
  if (!isRecord(scenario)) {
    return {
      scenarios: 0,
      intentMismatches: 0,
      completionMismatches: 0,
      failures: [`${pairId}.${variant} is missing.`],
    };
  }

  const result = checkReviewCompletion(scenario.input);
  const intentMatches = result.intent === scenario.expectedIntent;
  const completionMatches = result.ok === scenario.expectedOk;
  const failures = [];
  if (!intentMatches) {
    failures.push(`${pairId}.${variant}: expected intent ${scenario.expectedIntent}, received ${result.intent}.`);
  }
  if (!completionMatches) {
    failures.push(
      `${pairId}.${variant}: expected ok=${scenario.expectedOk}, received ok=${result.ok}: ${result.errors.join(' ')}`,
    );
  }
  return {
    scenarios: 1,
    intentMismatches: intentMatches ? 0 : 1,
    completionMismatches: completionMatches ? 0 : 1,
    failures,
  };
}

export function evaluateReviewCompletionRoutingFixture(fixture) {
  const failures = [];
  const certificate = isRecord(fixture) ? fixture.metricBirthCertificate : null;
  for (const field of BIRTH_CERTIFICATE_FIELDS) {
    if (!isRecord(certificate) || !nonEmptyString(certificate[field])) {
      failures.push(`metricBirthCertificate.${field} is required.`);
    }
  }

  const metrics = { scenarios: 0, intentMismatches: 0, entryMismatches: 0, completionMismatches: 0 };
  for (const pair of Array.isArray(fixture?.entryPairs) ? fixture.entryPairs : []) {
    for (const variant of ['positive', 'counterfactual']) {
      const result = evaluateReviewEntryFixtureScenario(pair, variant, checkReviewEntry);
      metrics.scenarios += result.scenarios;
      metrics.intentMismatches += result.intentMismatches;
      metrics.entryMismatches += result.entryMismatches;
      failures.push(...result.failures);
    }
  }
  for (const pair of Array.isArray(fixture?.pairs) ? fixture.pairs : []) {
    for (const variant of ['positive', 'counterfactual']) {
      const result = evaluateFixtureScenario(pair, variant);
      metrics.scenarios += result.scenarios;
      metrics.intentMismatches += result.intentMismatches;
      metrics.completionMismatches += result.completionMismatches;
      failures.push(...result.failures);
    }
  }
  if (metrics.scenarios === 0) failures.push('Review completion routing fixture has no scenarios.');
  return {
    verdict: failures.length === 0 ? 'pass' : 'fix',
    metrics,
    failures,
  };
}

export function checkExternalReviewHandoffText(text) {
  const errors = [];
  if (!EXTERNAL_REVIEW.test(text) || !VERDICT.test(text)) return { ok: true, errors };
  const hasDeliveredProof = GITHUB_PROOF.test(text);
  const hasPendingCustody = PENDING_CUSTODY.test(text) && /callback\s+(?:recorded|已记录)|回写已记录/i.test(text);
  if (COMPLETE_CLAIM.test(text) && !hasDeliveredProof) {
    errors.push('Completed external review requires a same-subject GitHub artifact URL; pending custody is not done.');
    return { ok: false, errors };
  }
  if (!hasDeliveredProof && !hasPendingCustody) {
    errors.push(
      'External review verdict requires a same-subject GitHub delivery proof or callback-recorded pending_delivery owner/reason.',
    );
  }
  return { ok: errors.length === 0, errors };
}

export function checkExternalReviewSourceBoundary({ outcomeSource, deliveryPolicySource, setupNoiseSource }) {
  const errors = [];
  const executableDeliveryPolicy = deliveryPolicySource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const token of ["kind: 'delivered'", "kind: 'pending_delivery'", 'ownerCatId', 'reason']) {
    if (!outcomeSource.includes(token)) errors.push(`ReviewDeliveryOutcome is missing ${token}.`);
  }
  if (/endsWith\(\s*['"]\[bot\]['"]\s*\)/.test(executableDeliveryPolicy)) {
    errors.push('Exact-identity boundary violated: broad bot suppression by [bot] suffix is forbidden.');
  }
  if (
    /OWNER[\s\S]{0,160}MEMBER[\s\S]{0,240}silent-log|silent-log[\s\S]{0,240}OWNER[\s\S]{0,160}MEMBER/.test(
      executableDeliveryPolicy,
    )
  ) {
    errors.push('Exact-identity boundary violated: broad OWNER/MEMBER suppression is forbidden.');
  }
  if (!/\.has\(c\.author\)/.test(setupNoiseSource)) {
    errors.push('Setup-noise suppression must require an exact author allowlist match.');
  }
  if (!/(?:c\.body|SETUP_GUIDANCE|setupSentence)/.test(setupNoiseSource)) {
    errors.push('Setup-noise suppression must correlate the comment body with the known setup template.');
  }
  if (!/(?:commentType|conversation)/.test(setupNoiseSource)) {
    errors.push('Setup-noise suppression must be scoped to the correlated conversation comment type.');
  }
  return { ok: errors.length === 0, errors };
}

export function runExternalReviewClosureCheck(root = process.cwd()) {
  const read = (path) => readFileSync(resolve(root, path), 'utf8');
  const readIfPresent = (path) => (existsSync(resolve(root, path)) ? read(path) : '');
  const boundary = checkExternalReviewSourceBoundary({
    outcomeSource: read('packages/shared/src/types/community-event.ts'),
    deliveryPolicySource: [
      read('packages/api/src/domains/community/community-delivery-policy.ts'),
      read('packages/api/src/infrastructure/email/IssueCommentTaskSpec.ts'),
    ].join('\n'),
    setupNoiseSource: read('packages/api/src/infrastructure/email/setup-noise-filter.ts'),
  });
  const skill = read('cat-cafe-skills/cross-cat-handoff/SKILL.md');
  const requestReviewSkill = read('cat-cafe-skills/request-review/SKILL.md');
  const receiveReviewSkill = read('cat-cafe-skills/receive-review/SKILL.md');
  const errors = [
    ...boundary.errors,
    ...checkReviewRoutingSurfaces({
      handoffSkill: skill,
      requestReviewSkill,
      receiveReviewSkill,
      mergeGateSkill: read('cat-cafe-skills/merge-gate/SKILL.md'),
      ironLaw: read('assets/prompt-templates/l4-iron-laws.md'),
      // The inbound maintainer playbook is deliberately home-only. Keep checking
      // it in cat-cafe, but do not make the public review contract depend on a
      // file that sync-manifest explicitly excludes from clowder-ai.
      inboundPrReference: readIfPresent('cat-cafe-skills/refs/opensource-ops-inbound-pr.md'),
      trackerToolSource: read('packages/mcp-server/src/tools/callback-tools.ts'),
      capabilityWakeupDomain: read('docs/harness-feedback/eval-domains/eval-capability-wakeup.yaml'),
      capabilityWakeupFixture: read('docs/harness-feedback/fixtures/external-pr-review-route-classifier.md'),
    }),
  ];
  const fixture = JSON.parse(read('packages/api/test/harness-eval/fixtures/review-completion-routing.json'));
  const routingEval = evaluateReviewCompletionRoutingFixture(fixture);
  errors.push(...routingEval.failures.map((error) => `review-completion fixture: ${error}`));
  return { ok: errors.length === 0, errors };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = runExternalReviewClosureCheck();
  if (!result.ok) {
    console.error(result.errors.map((error) => `[review-completion-routing] ${error}`).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('Review completion dual-route guard passed.');
  }
}
