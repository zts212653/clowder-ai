import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluatePredicate } from '../../dist/infrastructure/harness-eval/sop/sop-predicate-evaluator.js';

const baseTrace = {
  sessionId: 'session-test',
  sopDefinitionId: 'development',
  observedStage: 'merge',
  commands: [],
  changedFiles: [],
  envSnapshot: { REDIS_URL: 'redis://localhost:6398' },
  gitState: { branch: 'main', ahead: 0, behind: 0, clean: true },
  handles: { author: 'opus', reviewer: 'gpt52', guardian: 'opus47' },
  shaContext: {},
};

const predicate = {
  type: 'co_creation_docs_lane',
  includeGlobs: ['docs/*.md', 'docs/**/*.md'],
  classifierRequiredGlobs: [
    'docs/SOP.md',
    'docs/VISION.md',
    'docs/lessons-learned.md',
    'docs/architecture/ownership/**',
    'docs/canon/**',
    'docs/decisions/**',
  ],
  classifierMatch: 'pnpm classify:co-creation-docs|node scripts/co-creation-docs-lane.mjs',
  worktreeMatch: 'git worktree add',
  pullRequestMatch: 'gh pr create',
  cloudReviewMatch: 'gh pr comment .*@codex review',
  fullGateMatch: 'pnpm gate',
};

function evalPredicate(trace = baseTrace) {
  return evaluatePredicate('test-rule', 'test-stage', 'hard_rule', 'blocker', predicate, trace);
}

function classifierCommand(overrides = {}) {
  return {
    command: 'pnpm classify:co-creation-docs -- --conflict none --reversibility one_commit',
    exitCode: 0,
    stdout: JSON.stringify({
      lane: 'co_creation_docs',
      delivery: 'direct_push',
      cloudReview: 'skip',
      fullGate: 'skip',
      changedFiles: ['docs/architecture/overview.md'],
      ...overrides,
    }),
  };
}

describe('Predicate: co_creation_docs_lane', () => {
  it('lets an obviously light docs-only direct push omit classifier ceremony', () => {
    const result = evalPredicate({
      ...baseTrace,
      changedFiles: ['docs/architecture/overview.md'],
      commands: [{ command: 'git push origin main', exitCode: 0 }],
    });
    assert.equal(result.status, 'pass');
  });

  it('still requires classifier evidence for known governance paths', () => {
    const result = evalPredicate({
      ...baseTrace,
      changedFiles: ['docs/SOP.md'],
      commands: [{ command: 'git push origin main', exitCode: 0 }],
    });
    assert.equal(result.status, 'violation');
    assert.match(result.violation?.message ?? '', /governance.*classifier|classifier.*governance/i);
  });

  it('requires classifier evidence before docs-only work enters a heavy carrier', () => {
    const result = evalPredicate({
      ...baseTrace,
      changedFiles: ['docs/architecture/overview.md'],
      commands: [{ command: 'git worktree add ../docs -b docs/overview', exitCode: 0 }],
    });
    assert.equal(result.status, 'violation');
    assert.match(result.violation?.message ?? '', /heavy.*classifier|classifier.*heavy/i);
  });

  it('normalizes equivalent dot-segment paths the same way as the classifier', () => {
    const trace = {
      ...baseTrace,
      changedFiles: ['docs/architecture/drafts/../overview.md'],
      commands: [classifierCommand()],
    };
    assert.equal(evalPredicate(trace).status, 'pass');
  });

  it('does not apply when dot-segment normalization moves a path outside docs', () => {
    const trace = { ...baseTrace, changedFiles: ['docs/../cat-cafe-skills/example/SKILL.md'] };
    assert.equal(evalPredicate(trace).status, 'pass');
  });

  it('violates when a direct-push docs result still opens a worktree and PR', () => {
    const result = evalPredicate({
      ...baseTrace,
      changedFiles: ['docs/architecture/overview.md'],
      commands: [
        classifierCommand(),
        { command: 'git worktree add ../docs -b docs/overview', exitCode: 0 },
        { command: 'gh pr create --title docs:overview', exitCode: 0 },
      ],
    });
    assert.equal(result.status, 'violation');
    assert.match(result.violation?.message ?? '', /direct_push/);
  });

  it('counts a failed worktree attempt as over-processing friction', () => {
    const result = evalPredicate({
      ...baseTrace,
      changedFiles: ['docs/architecture/overview.md'],
      commands: [classifierCommand(), { command: 'git worktree add ../docs -b docs/overview', exitCode: 128 }],
    });
    assert.equal(result.status, 'violation');
    assert.match(result.violation?.message ?? '', /direct_push/);
  });

  it('violates when docs result skips full gate but the session runs pnpm gate', () => {
    const result = evalPredicate({
      ...baseTrace,
      changedFiles: ['docs/SOP.md'],
      commands: [
        classifierCommand({ delivery: 'pull_request', changedFiles: ['docs/SOP.md'] }),
        { command: 'gh pr create --title docs:sop', exitCode: 0 },
        { command: 'pnpm gate', exitCode: 0 },
      ],
    });
    assert.equal(result.status, 'violation');
    assert.match(result.violation?.message ?? '', /fullGate=skip/);
  });

  it('violates when docs result skips cloud review but the session triggers it', () => {
    const result = evalPredicate({
      ...baseTrace,
      changedFiles: ['docs/SOP.md'],
      commands: [
        classifierCommand({ delivery: 'pull_request', changedFiles: ['docs/SOP.md'] }),
        { command: 'gh pr comment 123 --body "@codex review"', exitCode: 0 },
      ],
    });
    assert.equal(result.status, 'violation');
    assert.match(result.violation?.message ?? '', /cloudReview=skip/);
  });

  it('passes a governance docs PR with local review and docs-level validation', () => {
    const trace = {
      ...baseTrace,
      changedFiles: ['docs/SOP.md'],
      commands: [
        classifierCommand({ delivery: 'pull_request', changedFiles: ['docs/SOP.md'] }),
        { command: 'pnpm check:docs-discovery', exitCode: 0 },
        { command: 'gh pr create --title docs:sop', exitCode: 0 },
      ],
    };
    assert.equal(evalPredicate(trace).status, 'pass');
  });

  it('violates when classifier output does not cover the trace changed files', () => {
    const result = evalPredicate({
      ...baseTrace,
      changedFiles: ['docs/architecture/overview.md', 'docs/architecture/index.md'],
      commands: [classifierCommand()],
    });
    assert.equal(result.status, 'violation');
    assert.match(result.violation?.message ?? '', /changed files/i);
  });

  it('violates when classifier output includes a non-doc file hidden by include globs', () => {
    const result = evalPredicate({
      ...baseTrace,
      changedFiles: ['docs/architecture/overview.md'],
      commands: [classifierCommand({ changedFiles: ['docs/architecture/overview.md', 'scripts/check-docs.mjs'] })],
    });
    assert.equal(result.status, 'violation');
    assert.match(result.violation?.message ?? '', /outside.*scope/i);
  });

  it('violates when a docs-only trace receives a regular-development classifier result', () => {
    const result = evalPredicate({
      ...baseTrace,
      changedFiles: ['docs/architecture/overview.md'],
      commands: [classifierCommand({ lane: 'regular_development', cloudReview: 'required', fullGate: 'required' })],
    });
    assert.equal(result.status, 'violation');
    assert.match(result.violation?.message ?? '', /regular_development/);
  });

  it('does not apply to regular development traces with code changes', () => {
    const trace = {
      ...baseTrace,
      changedFiles: ['docs/architecture/overview.md', 'scripts/check-docs.mjs'],
    };
    assert.equal(evalPredicate(trace).status, 'pass');
  });
});
