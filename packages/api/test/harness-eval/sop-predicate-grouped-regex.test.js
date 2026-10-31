import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluatePredicate } from '../../dist/infrastructure/harness-eval/sop/sop-predicate-evaluator.js';

const baseTrace = {
  sessionId: 'session-test',
  sopDefinitionId: 'development',
  observedStage: 'merge',
  commands: [],
  changedFiles: [],
  envSnapshot: {},
  gitState: { branch: 'main', ahead: 0, behind: 0, clean: true },
  handles: { author: 'opus', reviewer: 'gpt52' },
  shaContext: {},
};

function evaluateWithCommands(predicate, commands) {
  return evaluatePredicate('test-rule', 'test-stage', 'hard_rule', 'blocker', predicate, {
    ...baseTrace,
    commands,
  });
}

describe('SOP predicate grouped command regexes', () => {
  it('preserves grouped regex alternation instead of splitting command-pattern pipes', () => {
    const result = evaluateWithCommands({ type: 'command_pattern', mustMatch: 'pnpm (check|lint|test)' }, [
      { command: 'pnpm lint', exitCode: 0 },
    ]);

    assert.equal(result.status, 'pass');
  });

  it('preserves grouped regex alternation in command-sequence entries', () => {
    const result = evaluateWithCommands({ type: 'command_sequence', mustInclude: ['pnpm (check|lint|test)'] }, [
      { command: 'pnpm check', exitCode: 0 },
    ]);

    assert.equal(result.status, 'pass');
  });
});
