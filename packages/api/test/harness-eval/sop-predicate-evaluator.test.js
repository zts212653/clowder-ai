import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evaluatePredicate,
  evaluateSopDefinition,
} from '../../dist/infrastructure/harness-eval/sop/sop-predicate-evaluator.js';

// ---- Shared test trace ----

const baseTrace = {
  sessionId: 'session-test',
  sopDefinitionId: 'development',
  observedStage: 'merge',
  commands: [
    { command: 'pnpm gate', exitCode: 0 },
    { command: 'gh pr merge 1913 --squash --delete-branch', cwd: '/home/user/cat-cafe', exitCode: 0 },
    { command: 'gh pr comment 1913 --body "@codex review"', exitCode: 0 },
  ],
  envSnapshot: {
    REDIS_URL: 'redis://localhost:6398',
  },
  gitState: { branch: 'main', ahead: 0, behind: 0, clean: true },
  handles: { author: 'opus', reviewer: 'gpt52', guardian: 'opus47' },
  shaContext: { cloud_review: 'abc123' },
};

function evalP(predicate, trace = baseTrace) {
  return evaluatePredicate('test-rule', 'test-stage', 'hard_rule', 'blocker', predicate, trace);
}

// ---- manual_only ----

describe('Predicate: manual_only', () => {
  it('returns skipped with reason', () => {
    const result = evalP({ type: 'manual_only', reason: 'No machine check available' });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'No machine check available');
  });
});

// ---- command_pattern (AC-E18, AC-E22) ----

describe('Predicate: command_pattern', () => {
  it('passes when mustMatch pattern is found', () => {
    const result = evalP({ type: 'command_pattern', mustMatch: 'gh pr merge .*--squash' });
    assert.equal(result.status, 'pass');
  });

  it('violates when mustMatch pattern is not found', () => {
    const result = evalP({ type: 'command_pattern', mustMatch: 'git merge --squash' });
    assert.equal(result.status, 'violation');
    assert.ok(result.violation?.message.includes('git merge --squash'));
  });

  it('violates when mustNotMatch pattern is found', () => {
    const result = evalP({
      type: 'command_pattern',
      mustNotMatch: 'git merge --squash|git reset --soft',
    });
    // baseTrace has 'gh pr merge' not 'git merge', so this should pass
    assert.equal(result.status, 'pass');
  });

  it('violates when mustNotMatch matches an actual command', () => {
    const trace = {
      ...baseTrace,
      commands: [...baseTrace.commands, { command: 'git merge --squash' }],
    };
    const result = evalP({ type: 'command_pattern', mustNotMatch: 'git merge --squash' }, trace);
    assert.equal(result.status, 'violation');
    assert.ok(result.violation?.message.includes('git merge --squash'));
  });

  it('passes when both mustMatch and mustNotMatch are satisfied', () => {
    const result = evalP({
      type: 'command_pattern',
      mustMatch: 'gh pr merge .*--squash',
      mustNotMatch: 'git merge --squash',
    });
    assert.equal(result.status, 'pass');
  });

  it('handles pipe-separated patterns correctly', () => {
    const result = evalP({ type: 'command_pattern', mustMatch: 'pnpm gate|pnpm test|node --test' });
    assert.equal(result.status, 'pass'); // baseTrace has 'pnpm gate'
  });
});

// ---- env_check (AC-E18, AC-E22) ----

describe('Predicate: env_check', () => {
  it('passes when mustInclude is found in env value', () => {
    const result = evalP({ type: 'env_check', key: 'REDIS_URL', mustInclude: ':6398' });
    assert.equal(result.status, 'pass');
  });

  it('violates when mustInclude is not found', () => {
    const trace = { ...baseTrace, envSnapshot: { REDIS_URL: 'redis://localhost:6399' } };
    const result = evalP({ type: 'env_check', key: 'REDIS_URL', mustInclude: ':6398' }, trace);
    assert.equal(result.status, 'violation');
    assert.ok(result.violation?.message.includes(':6398'));
  });

  it('violates when env key is not set', () => {
    const trace = { ...baseTrace, envSnapshot: {} };
    const result = evalP({ type: 'env_check', key: 'REDIS_URL', mustInclude: ':6398' }, trace);
    assert.equal(result.status, 'violation');
    assert.ok(result.violation?.message.includes('<unset>'));
  });

  it('passes when mustNotInclude is absent from value', () => {
    const result = evalP({ type: 'env_check', key: 'REDIS_URL', mustNotInclude: ':6399' });
    assert.equal(result.status, 'pass');
  });

  it('violates when mustNotInclude is found in env value', () => {
    const trace = { ...baseTrace, envSnapshot: { REDIS_URL: 'redis://localhost:6399' } };
    const result = evalP({ type: 'env_check', key: 'REDIS_URL', mustNotInclude: ':6399' }, trace);
    assert.equal(result.status, 'violation');
  });
});

// ---- command_sequence (AC-E18, AC-E22) ----

describe('Predicate: command_sequence', () => {
  it('passes when all mustInclude patterns are found', () => {
    const result = evalP({
      type: 'command_sequence',
      mustInclude: ['pnpm gate', 'gh pr merge'],
    });
    assert.equal(result.status, 'pass');
  });

  it('violates when mustInclude pattern is missing', () => {
    const result = evalP({
      type: 'command_sequence',
      mustInclude: ['pnpm gate', 'pnpm check:features'],
    });
    assert.equal(result.status, 'violation');
    assert.ok(result.violation?.message.includes('pnpm check:features'));
  });

  it('detects anti-pattern + absent violation (push+close without merge)', () => {
    const trace = {
      ...baseTrace,
      commands: [{ command: 'git push origin feat/test' }, { command: 'gh pr close 99' }],
    };
    const result = evalP(
      { type: 'command_sequence', antiPattern: ['git push', 'gh pr close'], absent: ['gh pr merge'] },
      trace,
    );
    // Anti-pattern gate passes (push→close detected), gh pr merge absent → violation
    assert.equal(result.status, 'violation');
    assert.ok(result.violation?.message.includes('absent'));
  });

  it('violates on standalone anti-pattern (no absent field)', () => {
    const trace = {
      ...baseTrace,
      commands: [{ command: 'git push origin feat/test' }, { command: 'gh pr close 99' }],
    };
    const result = evalP({ type: 'command_sequence', antiPattern: ['git push', 'gh pr close'] }, trace);
    assert.equal(result.status, 'violation');
    assert.ok(result.violation?.message.includes('anti-pattern'));
  });

  it('passes when anti-pattern sequence is not in order', () => {
    const trace = {
      ...baseTrace,
      commands: [{ command: 'gh pr close 99' }, { command: 'git push origin feat/test' }],
    };
    const result = evalP({ type: 'command_sequence', antiPattern: ['git push', 'gh pr close'] }, trace);
    assert.equal(result.status, 'pass');
  });

  it('violates when absent command is NOT found (absence is the violation)', () => {
    const result = evalP({
      type: 'command_sequence',
      absent: ['nonexistent-command-xyz'],
    });
    assert.equal(result.status, 'violation');
    assert.ok(result.violation?.message.includes('nonexistent-command-xyz'));
  });

  it('passes when absent command IS found (absence condition not met)', () => {
    const result = evalP({
      type: 'command_sequence',
      absent: ['@codex review'],
    });
    assert.equal(result.status, 'pass'); // baseTrace has @codex review → not absent → pass
  });

  it('mustInclude acts as gate when combined with absent (P1-3 fix)', () => {
    // Scenario: review-retrigger-after-p1 — session without P1 fix commands
    const trace = {
      ...baseTrace,
      commands: [
        { command: 'pnpm gate', exitCode: 0 },
        { command: 'gh pr merge 99 --squash', exitCode: 0 },
      ],
    };
    const result = evalP(
      { type: 'command_sequence', mustInclude: ['git push', 'gh pr comment'], absent: ['@codex review'] },
      trace,
    );
    // mustInclude gate fails (no git push) → pass (scenario doesn't apply)
    assert.equal(result.status, 'pass');
  });

  it('mustInclude + absent fires when gate passes and absent confirmed', () => {
    // Scenario: dev pushed and commented but forgot to trigger review
    const trace = {
      ...baseTrace,
      commands: [
        { command: 'git push origin feat/test', exitCode: 0 },
        { command: 'gh pr comment 99 --body "fixed"', exitCode: 0 },
      ],
    };
    const result = evalP(
      { type: 'command_sequence', mustInclude: ['git push', 'gh pr comment'], absent: ['@codex review'] },
      trace,
    );
    // Gate passes (both present), @codex review absent → violation
    assert.equal(result.status, 'violation');
  });

  it('antiPattern + absent: passes when anti-pattern detected but absent command present', () => {
    // Scenario: dev did git push → gh pr close BUT also gh pr merge (recovered)
    const trace = {
      ...baseTrace,
      commands: [
        { command: 'git push origin feat/test', exitCode: 0 },
        { command: 'gh pr close 99', exitCode: 0 },
        { command: 'gh pr merge 99 --squash', exitCode: 0 },
      ],
    };
    const result = evalP(
      { type: 'command_sequence', antiPattern: ['git push', 'gh pr close'], absent: ['gh pr merge'] },
      trace,
    );
    // Anti-pattern detected, but gh pr merge IS present → absent condition not met → pass
    assert.equal(result.status, 'pass');
  });

  it('cwdContains with empty filter result → pass (P1-3 fix)', () => {
    const trace = {
      ...baseTrace,
      commands: [{ command: 'pnpm test', cwd: '/home/user/cat-cafe', exitCode: 0 }],
    };
    const result = evalP(
      { type: 'command_sequence', cwdContains: 'cat-cafe-runtime', mustInclude: ['git pull'] },
      trace,
    );
    // No commands in cat-cafe-runtime → rule not applicable → pass
    assert.equal(result.status, 'pass');
  });

  it('filters by cwdContains', () => {
    const trace = {
      ...baseTrace,
      commands: [
        { command: 'git pull', cwd: '/home/user/cat-cafe-runtime' },
        { command: 'pnpm start', cwd: '/home/user/cat-cafe-runtime' },
      ],
    };
    const result = evalP(
      {
        type: 'command_sequence',
        cwdContains: 'cat-cafe-runtime',
        mustInclude: ['git pull', 'pnpm start|runtime:start|restart'],
      },
      trace,
    );
    assert.equal(result.status, 'pass');
  });
});

// ---- sha_dedup (AC-E18, AC-E22) ----

describe('Predicate: sha_dedup', () => {
  it('passes when SHA appears only once', () => {
    const result = evalP({ type: 'sha_dedup', scope: 'cloud_review' });
    assert.equal(result.status, 'pass');
  });

  it('violates when SHA appears in multiple commands', () => {
    const trace = {
      ...baseTrace,
      commands: [
        { command: 'gh pr comment 99 --body "@codex review" abc123' },
        { command: 'gh pr comment 99 --body "@codex review" abc123' },
      ],
      shaContext: { cloud_review: 'abc123' },
    };
    const result = evalP({ type: 'sha_dedup', scope: 'cloud_review' }, trace);
    assert.equal(result.status, 'violation');
    assert.ok(result.violation?.message.includes('duplicate'));
  });

  it('passes when SHA scope is not in shaContext', () => {
    const trace = { ...baseTrace, shaContext: {} };
    const result = evalP({ type: 'sha_dedup', scope: 'cloud_review' }, trace);
    assert.equal(result.status, 'pass');
  });
});

// ---- git_state_predicate (AC-E18, AC-E22) ----

describe('Predicate: git_state_predicate', () => {
  it('passes when ahead and behind are both zero', () => {
    const result = evalP({
      type: 'git_state_predicate',
      repository: 'cat-cafe',
      branch: 'main',
      checks: ['ahead_zero', 'behind_zero'],
    });
    assert.equal(result.status, 'pass');
  });

  it('violates when ahead > 0', () => {
    const trace = { ...baseTrace, gitState: { ...baseTrace.gitState, ahead: 3 } };
    const result = evalP(
      { type: 'git_state_predicate', repository: 'cat-cafe', branch: 'main', checks: ['ahead_zero'] },
      trace,
    );
    assert.equal(result.status, 'violation');
    assert.ok(result.violation?.message.includes('ahead=3'));
  });

  it('violates when behind > 0', () => {
    const trace = { ...baseTrace, gitState: { ...baseTrace.gitState, behind: 2 } };
    const result = evalP(
      { type: 'git_state_predicate', repository: 'cat-cafe', branch: 'main', checks: ['behind_zero'] },
      trace,
    );
    assert.equal(result.status, 'violation');
    assert.ok(result.violation?.message.includes('behind=2'));
  });

  it('violates when worktree is dirty', () => {
    const trace = { ...baseTrace, gitState: { ...baseTrace.gitState, clean: false } };
    const result = evalP(
      { type: 'git_state_predicate', repository: 'cat-cafe', branch: 'main', checks: ['clean_worktree'] },
      trace,
    );
    assert.equal(result.status, 'violation');
    assert.ok(result.violation?.message.includes('not clean'));
  });

  it('passes unknown checks gracefully (forward-compatible)', () => {
    const result = evalP({
      type: 'git_state_predicate',
      repository: 'cat-cafe',
      branch: 'main',
      checks: ['future_check'],
    });
    assert.equal(result.status, 'pass');
  });

  // ---- P1-1: scope gates for repository / branch / beforeCommand ----

  it('passes when branch does not match trace (scope mismatch)', () => {
    const trace = { ...baseTrace, gitState: { ...baseTrace.gitState, branch: 'feat/test', ahead: 5 } };
    const result = evalP(
      { type: 'git_state_predicate', repository: 'cat-cafe', branch: 'main', checks: ['ahead_zero'] },
      trace,
    );
    // Branch is feat/test, rule scoped to main → not applicable → pass
    assert.equal(result.status, 'pass');
  });

  it('passes when repository does not match worktreeRoot (scope mismatch)', () => {
    const trace = {
      ...baseTrace,
      gitState: { ...baseTrace.gitState, ahead: 5, worktreeRoot: '/home/user/other-project' },
    };
    const result = evalP(
      { type: 'git_state_predicate', repository: 'cat-cafe', branch: 'main', checks: ['ahead_zero'] },
      trace,
    );
    // worktreeRoot doesn't contain 'cat-cafe' → not applicable → pass
    assert.equal(result.status, 'pass');
  });

  it('passes when beforeCommand is not in trace commands', () => {
    const trace = {
      ...baseTrace,
      gitState: { ...baseTrace.gitState, ahead: 5 },
      commands: [{ command: 'pnpm test', exitCode: 0 }],
    };
    const result = evalP(
      {
        type: 'git_state_predicate',
        repository: 'cat-cafe',
        branch: 'main',
        checks: ['ahead_zero'],
        beforeCommand: 'git worktree add',
      },
      trace,
    );
    // No 'git worktree add' in commands → rule not triggered → pass
    assert.equal(result.status, 'pass');
  });

  it('violates when all scope conditions match', () => {
    const trace = {
      ...baseTrace,
      gitState: { ...baseTrace.gitState, ahead: 3, worktreeRoot: '/home/user/cat-cafe' },
      commands: [{ command: 'git worktree add ../cat-cafe-feature -b feat/test', exitCode: 0 }],
    };
    const result = evalP(
      {
        type: 'git_state_predicate',
        repository: 'cat-cafe',
        branch: 'main',
        checks: ['ahead_zero'],
        beforeCommand: 'git worktree add',
      },
      trace,
    );
    // All scope gates pass, ahead=3 → violation
    assert.equal(result.status, 'violation');
    assert.ok(result.violation?.message.includes('ahead=3'));
  });

  it('applies when worktreeRoot is absent (cannot determine repository)', () => {
    // Conservative: if we can't determine repo, still apply the rule
    const trace = { ...baseTrace, gitState: { ...baseTrace.gitState, ahead: 3 } };
    const result = evalP(
      { type: 'git_state_predicate', repository: 'cat-cafe', branch: 'main', checks: ['ahead_zero'] },
      trace,
    );
    assert.equal(result.status, 'violation');
  });
});

// ---- handle_check (AC-E18, AC-E22) ----

describe('Predicate: handle_check', () => {
  it('passes when reviewer is different from author', () => {
    const result = evalP({ type: 'handle_check', constraint: 'reviewer_not_author' });
    assert.equal(result.status, 'pass');
  });

  it('violates when reviewer is same as author', () => {
    const trace = { ...baseTrace, handles: { author: 'opus', reviewer: 'opus' } };
    const result = evalP({ type: 'handle_check', constraint: 'reviewer_not_author' }, trace);
    assert.equal(result.status, 'violation');
    assert.ok(result.violation?.message.includes('same as author'));
  });

  it('violates when no reviewer is assigned', () => {
    const trace = { ...baseTrace, handles: { author: 'opus' } };
    const result = evalP({ type: 'handle_check', constraint: 'reviewer_not_author' }, trace);
    assert.equal(result.status, 'violation');
    assert.ok(result.violation?.message.includes('no reviewer'));
  });

  it('passes when guardian is present and different from author/reviewer', () => {
    const result = evalP({ type: 'handle_check', constraint: 'guardian_handoff_present' });
    assert.equal(result.status, 'pass');
  });

  it('violates when guardian is not present', () => {
    const trace = { ...baseTrace, handles: { author: 'opus', reviewer: 'gpt52' } };
    const result = evalP({ type: 'handle_check', constraint: 'guardian_handoff_present' }, trace);
    assert.equal(result.status, 'violation');
  });

  it('passes unknown constraints gracefully', () => {
    const result = evalP({ type: 'handle_check', constraint: 'future_constraint' });
    assert.equal(result.status, 'pass');
  });
});

// ---- P1-2: rule owner propagation (AC-E21) ----

describe('Rule owner propagation (AC-E21)', () => {
  it('propagates owner through evaluatePredicate to violation', () => {
    const owner = { type: 'stage_suggested_skill', skill: 'merge-gate' };
    const result = evaluatePredicate(
      'test-rule',
      'test-stage',
      'hard_rule',
      'blocker',
      { type: 'command_pattern', mustMatch: 'nonexistent-cmd' },
      baseTrace,
      owner,
    );
    assert.equal(result.status, 'violation');
    assert.deepEqual(result.violation?.owner, owner);
  });

  it('propagates owner through evaluateSopDefinition', async () => {
    const { DEVELOPMENT_SOP_DEFINITION } = await import(
      '../../../../packages/shared/dist/types/sop-definition.generated.js'
    );

    const badTrace = {
      ...baseTrace,
      envSnapshot: { REDIS_URL: 'redis://localhost:6399' },
    };

    const results = evaluateSopDefinition(DEVELOPMENT_SOP_DEFINITION, badTrace);
    const redisViolation = results.find((r) => r.ruleId === 'impl-redis-6398-only');
    assert.equal(redisViolation?.status, 'violation');
    assert.ok(redisViolation?.violation?.owner, 'violation should carry rule owner');
    assert.equal(redisViolation?.violation?.owner?.type, 'stage_suggested_skill');
  });

  it('does not include owner on pass results', () => {
    const owner = { type: 'stage_suggested_skill', skill: 'merge-gate' };
    const result = evaluatePredicate(
      'test-rule',
      'test-stage',
      'hard_rule',
      'blocker',
      { type: 'command_pattern', mustMatch: 'pnpm gate' },
      baseTrace,
      owner,
    );
    assert.equal(result.status, 'pass');
    assert.equal(result.violation, undefined);
  });
});

// ---- Full SOP definition evaluation (AC-E22) ----

describe('evaluateSopDefinition (AC-E22)', () => {
  it('evaluates all rules from a development-like definition', async () => {
    // Import the real generated definition
    const { DEVELOPMENT_SOP_DEFINITION } = await import(
      '../../../../packages/shared/dist/types/sop-definition.generated.js'
    );

    const trace = {
      sessionId: 'integration-test',
      sopDefinitionId: 'development',
      observedStage: 'merge',
      commands: [
        { command: 'pnpm gate', exitCode: 0 },
        { command: 'pnpm test', exitCode: 0 },
        { command: 'gh pr merge 99 --squash', cwd: '/home/user/cat-cafe', exitCode: 0 },
        { command: 'gh pr view 99', exitCode: 0 },
        { command: 'pnpm check:features', exitCode: 0 },
      ],
      envSnapshot: { REDIS_URL: 'redis://localhost:6398' },
      gitState: { branch: 'main', ahead: 0, behind: 0, clean: true },
      handles: { author: 'opus', reviewer: 'gpt52', guardian: 'opus47' },
      shaContext: {},
    };

    const results = evaluateSopDefinition(DEVELOPMENT_SOP_DEFINITION, trace);

    // Count by status
    const pass = results.filter((r) => r.status === 'pass');
    const skipped = results.filter((r) => r.status === 'skipped');
    const violations = results.filter((r) => r.status === 'violation');

    // 19 total rules in development.yaml
    assert.equal(results.length, 19, `expected 19 rules, got ${results.length}`);

    // 8 manual_only rules -> skipped
    assert.equal(skipped.length, 8, `expected 8 skipped (manual_only), got ${skipped.length}`);

    // Nominal trace should produce 0 violations
    assert.equal(
      violations.length,
      0,
      `expected 0 violations in nominal trace, got ${violations.length}: ${violations.map((v) => v.ruleId).join(', ')}`,
    );

    // Verify specific rule IDs are present
    const ruleIds = results.map((r) => r.ruleId);
    assert.ok(ruleIds.includes('merge-github-squash-only'));
    assert.ok(ruleIds.includes('impl-redis-6398-only'));
    assert.ok(ruleIds.includes('review-no-self-review'));
    assert.ok(ruleIds.includes('impl-main-sync-before-worktree'));
    assert.ok(ruleIds.includes('impl-convention-graph-before-convention-edit'));

    // Verify specific rules pass
    const squashRule = results.find((r) => r.ruleId === 'merge-github-squash-only');
    assert.equal(squashRule?.status, 'pass', 'merge-github-squash-only should pass');

    const redisRule = results.find((r) => r.ruleId === 'impl-redis-6398-only');
    assert.equal(redisRule?.status, 'pass', 'impl-redis-6398-only should pass');

    const selfReview = results.find((r) => r.ruleId === 'review-no-self-review');
    assert.equal(selfReview?.status, 'pass', 'review-no-self-review should pass');

    // Log summary for debugging
    console.log(
      `  SOP eval: ${pass.length} pass, ${violations.length} violation, ${skipped.length} skipped (of ${results.length} total)`,
    );
    for (const v of violations) {
      console.log(`    ⚠ ${v.ruleId}: ${v.violation?.message}`);
    }
  });

  it('detects violations when trace is non-compliant', async () => {
    const { DEVELOPMENT_SOP_DEFINITION } = await import(
      '../../../../packages/shared/dist/types/sop-definition.generated.js'
    );

    const nonCompliantTrace = {
      sessionId: 'bad-session',
      sopDefinitionId: 'development',
      observedStage: 'merge',
      commands: [
        // git worktree add triggers the main-sync-before-worktree scope gate
        { command: 'git worktree add ../cat-cafe-feat -b feat/test', exitCode: 0 },
        // Uses local squash instead of gh pr merge --squash
        { command: 'git merge --squash feat/test', exitCode: 0 },
        { command: 'git push origin main', exitCode: 0 },
        { command: 'gh pr close 99', exitCode: 0 },
      ],
      envSnapshot: { REDIS_URL: 'redis://localhost:6399' }, // Wrong port!
      gitState: { branch: 'main', ahead: 2, behind: 1, clean: false },
      handles: { author: 'opus', reviewer: 'opus' }, // Self-review!
      shaContext: {},
    };

    const results = evaluateSopDefinition(DEVELOPMENT_SOP_DEFINITION, nonCompliantTrace);
    const violations = results.filter((r) => r.status === 'violation');

    // Should detect multiple violations
    assert.ok(violations.length >= 4, `expected ≥4 violations in non-compliant trace, got ${violations.length}`);

    // Specific violations we expect
    const violationIds = violations.map((v) => v.ruleId);

    // merge-github-squash-only: no 'gh pr merge --squash' found
    assert.ok(violationIds.includes('merge-github-squash-only'), 'should detect missing squash merge');

    // impl-redis-6398-only: REDIS_URL includes :6399
    assert.ok(violationIds.includes('impl-redis-6398-only'), 'should detect wrong Redis port');

    // review-no-self-review: author === reviewer
    assert.ok(violationIds.includes('review-no-self-review'), 'should detect self-review');

    // impl-main-sync-before-worktree: ahead > 0
    assert.ok(violationIds.includes('impl-main-sync-before-worktree'), 'should detect main not synced');
  });
});
