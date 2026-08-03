import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

const evaluatorPath = new URL('../../src/infrastructure/harness-eval/sop/sop-predicate-evaluator.ts', import.meta.url);
const legacyRegressionSuitePath = new URL('./sop-predicate-evaluator.test.js', import.meta.url);

describe('SOP predicate evaluator module size', () => {
  it('keeps the dispatcher under the AGENTS hard file cap', () => {
    const lineCount = fs.readFileSync(evaluatorPath, 'utf8').trimEnd().split('\n').length;
    assert.ok(
      lineCount <= 350,
      `sop-predicate-evaluator.ts has ${lineCount} lines; split predicate-specific logic into focused modules`,
    );
  });

  it('does not add new predicates to the oversized legacy regression suite', () => {
    const lineCount = fs.readFileSync(legacyRegressionSuitePath, 'utf8').trimEnd().split('\n').length;
    assert.ok(
      lineCount <= 768,
      `sop-predicate-evaluator.test.js has ${lineCount} lines; put new predicate suites in focused test files`,
    );
  });
});
