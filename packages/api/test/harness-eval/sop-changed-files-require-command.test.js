import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluatePredicate } from '../../dist/infrastructure/harness-eval/sop/sop-predicate-evaluator.js';

const baseTrace = {
  sessionId: 'session-test',
  sopDefinitionId: 'development',
  observedStage: 'implementation',
  commands: [],
  changedFiles: ['packages/api/src/routes/thread-routes.ts'],
  envSnapshot: {},
  gitState: { branch: 'feat/test', ahead: 0, behind: 0, clean: true },
  handles: { author: 'codex', reviewer: 'sonnet' },
  shaContext: {},
};

describe('changed_files_require_command predicate', () => {
  it('defaults missing exclude globs to an empty list', () => {
    const result = evaluatePredicate(
      'impl-convention-surface-before-edit',
      'implementation',
      'pitfall',
      'blocker',
      {
        type: 'changed_files_require_command',
        includeGlobs: ['packages/api/src/routes/*.ts'],
        mustMatch: 'pnpm convention-graph:code-consumers',
      },
      baseTrace,
    );

    assert.equal(result.status, 'violation');
    assert.match(result.violation?.message ?? '', /pnpm convention-graph:code-consumers/);
  });

  it('preserves grouped regex alternation in the required command expression', () => {
    const result = evaluatePredicate(
      'impl-doc-check-before-edit',
      'implementation',
      'pitfall',
      'blocker',
      {
        type: 'changed_files_require_command',
        includeGlobs: ['docs/*.md'],
        mustMatch: 'pnpm (check|lint|test)',
      },
      {
        ...baseTrace,
        changedFiles: ['docs/README.md'],
        commands: [{ command: 'pnpm test', exitCode: 0 }],
      },
    );

    assert.equal(result.status, 'pass');
  });
});
