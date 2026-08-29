import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { planClowderMergeExecution } from './clowder-merge-execution.mjs';

const REPOSITORY = 'zts212653/clowder-ai';
const PR_NUMBER = 1185;
const OLD_HEAD = '1111111111111111111111111111111111111111';
const CURRENT_HEAD = '2222222222222222222222222222222222222222';
const AUTHORIZATION_REF = '0000000000000000-000000-deadbeef';
const INTAKE_INTENT_ISSUE = 3958;
const SCRIPT_PATH = fileURLToPath(new URL('./clowder-merge-execution.mjs', import.meta.url));
const INBOUND_RUNBOOK_URL = new URL('../cat-cafe-skills/refs/opensource-ops-inbound-pr.md', import.meta.url);

function baseInput(overrides = {}) {
  return {
    repository: REPOSITORY,
    prNumber: PR_NUMBER,
    expectedHead: CURRENT_HEAD,
    prTruth: {
      state: 'OPEN',
      headRefOid: CURRENT_HEAD,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    },
    authorization: {
      sourceMessageId: AUTHORIZATION_REF,
      subjectRef: `pr:${REPOSITORY}#${PR_NUMBER}`,
      scope: 'pull_request',
      authorizedHead: OLD_HEAD,
    },
    intakePlan: {
      decision: 'absorbed',
      intentIssue: INTAKE_INTENT_ISSUE,
      intentIssueTruth: {
        state: 'OPEN',
        labels: [{ name: 'intake' }],
        body: `Source PR: clowder-ai#${PR_NUMBER}`,
      },
    },
    ...overrides,
  };
}

function runCli(
  prTruth,
  extraArgs = [],
  intakeArgs = ['--intake-decision', 'absorbed', '--intake-intent-issue', String(INTAKE_INTENT_ISSUE)],
) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'clowder-merge-execution-'));
  const fixturePath = path.join(tempDir, 'pr.json');
  const intakeFixturePath = path.join(tempDir, 'intake-issue.json');
  writeFileSync(fixturePath, JSON.stringify(prTruth), 'utf8');
  writeFileSync(
    intakeFixturePath,
    JSON.stringify({
      state: 'OPEN',
      labels: [{ name: 'intake' }],
      body: `Source PR: clowder-ai#${PR_NUMBER}`,
    }),
    'utf8',
  );
  try {
    const result = spawnSync(
      process.execPath,
      [
        SCRIPT_PATH,
        '--pr',
        String(PR_NUMBER),
        '--head',
        CURRENT_HEAD,
        '--authorization-ref',
        AUTHORIZATION_REF,
        '--authorization-subject',
        `pr:${REPOSITORY}#${PR_NUMBER}`,
        '--authorization-scope',
        'pull_request',
        ...intakeArgs,
        ...extraArgs,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          CAT_CAFE_CLOWDER_MERGE_PR_FIXTURE: fixturePath,
          CAT_CAFE_CLOWDER_MERGE_INTAKE_FIXTURE: intakeFixturePath,
        },
      },
    );
    const lines = result.stdout.trim().split('\n');
    return { ...result, json: JSON.parse(lines.at(-1)) };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('planClowderMergeExecution', () => {
  it('blocks source merge when no durable intake plan is declared', () => {
    const result = planClowderMergeExecution(baseInput({ intakePlan: undefined }));

    assert.equal(result.outcome, 'blocked');
    assert.equal(result.reasonCode, 'intake_plan_missing');
    assert.equal(result.nextAction, 'declare_intake_plan');
    assert.equal(result.command, null);
  });

  it('requires an Intake Intent Issue for an absorbed decision', () => {
    const result = planClowderMergeExecution(
      baseInput({ intakePlan: { decision: 'absorbed', intentIssue: undefined } }),
    );

    assert.equal(result.outcome, 'blocked');
    assert.equal(result.reasonCode, 'intake_intent_issue_missing');
    assert.equal(result.nextAction, 'create_intake_intent_issue');
    assert.equal(result.command, null);
  });

  it('rejects an absorbed issue that is not an open intake issue for the same source PR', () => {
    const result = planClowderMergeExecution(
      baseInput({
        intakePlan: {
          decision: 'absorbed',
          intentIssue: INTAKE_INTENT_ISSUE,
          intentIssueTruth: {
            state: 'CLOSED',
            labels: [{ name: 'intake' }],
            body: 'Source PR: clowder-ai#9999',
          },
        },
      }),
    );

    assert.equal(result.outcome, 'blocked');
    assert.equal(result.reasonCode, 'intake_intent_issue_not_open');
    assert.equal(result.nextAction, 'fix_intake_intent_issue');
  });

  it('rejects an absorbed issue without the intake label or exact source PR reference', () => {
    const missingLabel = planClowderMergeExecution(
      baseInput({
        intakePlan: {
          decision: 'absorbed',
          intentIssue: INTAKE_INTENT_ISSUE,
          intentIssueTruth: {
            state: 'OPEN',
            labels: [],
            body: `Source PR: clowder-ai#${PR_NUMBER}`,
          },
        },
      }),
    );
    const wrongSource = planClowderMergeExecution(
      baseInput({
        intakePlan: {
          decision: 'absorbed',
          intentIssue: INTAKE_INTENT_ISSUE,
          intentIssueTruth: {
            state: 'OPEN',
            labels: [{ name: 'intake' }],
            body: 'Source PR: clowder-ai#9999',
          },
        },
      }),
    );

    assert.equal(missingLabel.reasonCode, 'intake_intent_issue_label_missing');
    assert.equal(wrongSource.reasonCode, 'intake_intent_issue_source_mismatch');
  });

  it('accepts public-only and rejected decisions without inventing an intent issue', () => {
    for (const decision of ['public-only', 'rejected']) {
      const result = planClowderMergeExecution(baseInput({ intakePlan: { decision } }));

      assert.equal(result.outcome, 'admitted');
      assert.equal(result.intakePlan.decision, decision);
      assert.equal(result.intakePlan.intentIssue, null);
      assert.equal(result.postMergeNextAction, 'record_intake_decision_and_advance_ledger');
    }
  });

  it('preserves PR-scoped authorization across a new HEAD and selects required admin transport', () => {
    const result = planClowderMergeExecution(baseInput());

    assert.equal(result.outcome, 'admitted');
    assert.equal(result.requiresNewAuthorization, false);
    assert.equal(result.authorizationContinuity, 'valid_across_head');
    assert.deepEqual(result.intakePlan, {
      decision: 'absorbed',
      intentIssue: INTAKE_INTENT_ISSUE,
    });
    assert.equal(result.postMergeNextAction, 'complete_absorbed_intake_and_advance_ledger');
    assert.deepEqual(result.command, [
      'gh',
      'pr',
      'merge',
      String(PR_NUMBER),
      '--repo',
      REPOSITORY,
      '--squash',
      '--admin',
      '--match-head-commit',
      CURRENT_HEAD,
    ]);
  });

  it('does not reinterpret ruleset BLOCKED as a new authorization edge', () => {
    const result = planClowderMergeExecution(baseInput());

    assert.equal(result.outcome, 'admitted');
    assert.equal(result.reasonCode, 'authorized_admin_transport');
    assert.equal(result.requiresNewAuthorization, false);
  });

  it('requires fresh authorization when an exact-HEAD grant is stale', () => {
    const result = planClowderMergeExecution(
      baseInput({
        authorization: {
          sourceMessageId: AUTHORIZATION_REF,
          subjectRef: `pr:${REPOSITORY}#${PR_NUMBER}`,
          scope: 'exact_head',
          authorizedHead: OLD_HEAD,
        },
      }),
    );

    assert.equal(result.outcome, 'blocked');
    assert.equal(result.reasonCode, 'authorization_head_stale');
    assert.equal(result.requiresNewAuthorization, true);
    assert.equal(result.command, null);
  });

  it('rejects reuse of authorization for another PR subject', () => {
    const result = planClowderMergeExecution(
      baseInput({
        authorization: {
          sourceMessageId: AUTHORIZATION_REF,
          subjectRef: `pr:${REPOSITORY}#9999`,
          scope: 'pull_request',
        },
      }),
    );

    assert.equal(result.outcome, 'blocked');
    assert.equal(result.reasonCode, 'authorization_subject_mismatch');
    assert.equal(result.requiresNewAuthorization, true);
  });

  it('separates stale PR truth from authorization validity', () => {
    const result = planClowderMergeExecution(
      baseInput({
        prTruth: {
          state: 'OPEN',
          headRefOid: OLD_HEAD,
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'BLOCKED',
          statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        },
      }),
    );

    assert.equal(result.outcome, 'blocked');
    assert.equal(result.reasonCode, 'pr_head_mismatch');
    assert.equal(result.requiresNewAuthorization, false);
    assert.equal(result.authorizationContinuity, 'valid_across_head');
    assert.equal(result.nextAction, 'refresh_pr_truth');
  });

  it('blocks merge conflicts without asking for authorization again', () => {
    const result = planClowderMergeExecution(
      baseInput({
        prTruth: {
          state: 'OPEN',
          headRefOid: CURRENT_HEAD,
          mergeable: 'CONFLICTING',
          mergeStateStatus: 'DIRTY',
          statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        },
      }),
    );

    assert.equal(result.outcome, 'blocked');
    assert.equal(result.reasonCode, 'merge_conflict');
    assert.equal(result.requiresNewAuthorization, false);
    assert.equal(result.authorizationContinuity, 'valid_across_head');
    assert.equal(result.nextAction, 'resolve_conflict');
  });

  it('fails closed when no durable authorization source is present', () => {
    const result = planClowderMergeExecution(
      baseInput({
        authorization: {
          sourceMessageId: '',
          subjectRef: `pr:${REPOSITORY}#${PR_NUMBER}`,
          scope: 'pull_request',
        },
      }),
    );

    assert.equal(result.outcome, 'blocked');
    assert.equal(result.reasonCode, 'authorization_source_missing');
    assert.equal(result.requiresNewAuthorization, true);
  });

  it('rejects a non-canonical authorization source instead of accepting narrative text', () => {
    const result = planClowderMergeExecution(
      baseInput({
        authorization: {
          sourceMessageId: 'the-user-said-yes',
          subjectRef: `pr:${REPOSITORY}#${PR_NUMBER}`,
          scope: 'pull_request',
        },
      }),
    );

    assert.equal(result.outcome, 'blocked');
    assert.equal(result.reasonCode, 'authorization_source_invalid');
    assert.equal(result.requiresNewAuthorization, true);
  });

  it('blocks failed checks without invalidating merge authorization', () => {
    const result = planClowderMergeExecution(
      baseInput({
        prTruth: {
          state: 'OPEN',
          headRefOid: CURRENT_HEAD,
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'BLOCKED',
          statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'FAILURE' }],
        },
      }),
    );

    assert.equal(result.outcome, 'blocked');
    assert.equal(result.reasonCode, 'checks_failed');
    assert.equal(result.requiresNewAuthorization, false);
    assert.equal(result.authorizationContinuity, 'valid_across_head');
    assert.equal(result.nextAction, 'fix_ci');
  });

  it('blocks pending or unavailable checks without asking operator again', () => {
    const pending = planClowderMergeExecution(
      baseInput({
        prTruth: {
          state: 'OPEN',
          headRefOid: CURRENT_HEAD,
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'BLOCKED',
          statusCheckRollup: [{ name: 'CI', status: 'IN_PROGRESS', conclusion: null }],
        },
      }),
    );
    const unavailable = planClowderMergeExecution(
      baseInput({
        prTruth: {
          state: 'OPEN',
          headRefOid: CURRENT_HEAD,
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'BLOCKED',
          statusCheckRollup: [],
        },
      }),
    );

    assert.equal(pending.reasonCode, 'checks_pending');
    assert.equal(pending.nextAction, 'wait_for_ci');
    assert.equal(pending.requiresNewAuthorization, false);
    assert.equal(pending.authorizationContinuity, 'valid_across_head');
    assert.equal(unavailable.reasonCode, 'checks_unavailable');
    assert.equal(unavailable.nextAction, 'refresh_pr_truth');
    assert.equal(unavailable.requiresNewAuthorization, false);
    assert.equal(unavailable.authorizationContinuity, 'valid_across_head');
  });
});

describe('clowder merge execution contract surfaces', () => {
  it(
    'routes the inbound runbook through the deterministic execution guard',
    { skip: !existsSync(INBOUND_RUNBOOK_URL) && 'home-only maintainer runbook is absent from public export' },
    () => {
      const runbook = readFileSync(INBOUND_RUNBOOK_URL, 'utf8');
      const grounding = readFileSync(
        new URL('../cat-cafe-skills/receive-handoff-grounding/SKILL.md', import.meta.url),
        'utf8',
      );
      const resolverCatalog = readFileSync(
        new URL('../cat-cafe-skills/receive-handoff-grounding/refs/resolver-catalog.md', import.meta.url),
        'utf8',
      );
      const claimSchema = readFileSync(
        new URL('../cat-cafe-skills/receive-handoff-grounding/refs/claim-schema.md', import.meta.url),
        'utf8',
      );
      const featureSpec = readFileSync(new URL('../docs/features/F167-a2a-chain-quality.md', import.meta.url), 'utf8');
      const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

      assert.match(runbook, /pnpm merge:clowder/);
      assert.match(runbook, /--authorization-scope (pull_request|exact_head)/);
      assert.match(runbook, /--intake-decision (absorbed|public-only|rejected)/);
      assert.match(runbook, /--intake-intent-issue/);
      assert.match(runbook, /authorization key/i);
      assert.match(runbook, /subject freshness key/i);
      assert.doesNotMatch(runbook, /gh pr merge \{N\} --repo zts212653\/clowder-ai --squash --admin/);

      assert.match(grounding, /authorization key/i);
      assert.match(grounding, /subject freshness key/i);
      assert.match(grounding, /exact[- ]HEAD/i);
      assert.match(resolverCatalog, /authorization key/i);
      assert.match(resolverCatalog, /subject freshness key/i);
      assert.match(claimSchema, /authorization key/i);
      assert.match(claimSchema, /subject freshness key/i);
      assert.match(featureSpec, /authorization key/i);
      assert.match(featureSpec, /subject freshness key/i);

      assert.equal(packageJson.scripts['merge:clowder'], 'node scripts/clowder-merge-execution.mjs');
      assert.match(packageJson.scripts['check:pre-merge-gate'], /clowder-merge-execution\.test\.mjs/);
    },
  );
});

describe('clowder-merge-execution CLI', () => {
  it('fails closed before source merge when the CLI omits its intake plan', () => {
    const result = runCli(baseInput().prTruth, [], []);

    assert.equal(result.status, 1);
    assert.equal(result.json.reasonCode, 'intake_plan_missing');
    assert.equal(result.json.nextAction, 'declare_intake_plan');
  });

  it('plans an admitted admin command without executing unless --execute is present', () => {
    const result = runCli(baseInput().prTruth);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.outcome, 'admitted');
    assert.deepEqual(result.json.command, planClowderMergeExecution(baseInput()).command);
  });

  it('returns a blocking result for stale exact-HEAD authorization', () => {
    const result = runCli(baseInput().prTruth, ['--authorization-scope', 'exact_head', '--authorized-head', OLD_HEAD]);

    assert.equal(result.status, 1);
    assert.equal(result.json.reasonCode, 'authorization_head_stale');
    assert.equal(result.json.requiresNewAuthorization, true);
  });
});
