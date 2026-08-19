import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const apiRoot = path.resolve(import.meta.dirname, '../..');
const trialsPath = path.join(
  apiRoot,
  'src/infrastructure/harness-eval/capability-wakeup/eval-capability-wakeup-trials.ts',
);

describe('capability wakeup trial file limits', () => {
  it('keeps the trial evaluator under the AGENTS hard file cap', () => {
    const lineCount = fs.readFileSync(trialsPath, 'utf8').trimEnd().split('\n').length;
    assert.ok(
      lineCount <= 350,
      `eval-capability-wakeup-trials.ts has ${lineCount} lines; split capability-specific helpers into focused modules`,
    );
  });
});
