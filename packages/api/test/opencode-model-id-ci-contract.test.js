import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

const requiredVersion = '1.18.9';

function assertOpenCodeBehaviorBaseline(steps) {
  const installIndex = steps.findIndex((step) => step.run === `npm install --global opencode-ai@${requiredVersion}`);
  const buildIndex = steps.findIndex((step) => step.run === 'pnpm --filter @cat-cafe/api build');
  const behaviorIndex = steps.findIndex((step) =>
    step.run?.includes('packages/api/test/opencode-model-id-request.test.js'),
  );

  assert.ok(buildIndex >= 0, 'the API must be built before its compiled config generator is imported');
  assert.ok(installIndex >= 0, `OpenCode ${requiredVersion} must be installed`);
  assert.ok(behaviorIndex >= 0, 'the OpenCode behavior test must run');
  assert.match(steps[behaviorIndex].run, /opencode-model-id-ci-contract\.test\.js/);
  assert.equal(steps[behaviorIndex].env.REQUIRE_OPENCODE_MODEL_ID_TEST, '1');
  assert.ok(buildIndex < behaviorIndex, 'the API must be built before the behavior test');
  assert.ok(installIndex < behaviorIndex, 'the exact OpenCode version must be installed before the behavior test');
}

test('ci.yml installs and requires the exact OpenCode behavior baseline', () => {
  const document = parse(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const behaviorJob = document.jobs['public-test-contract'];
  const aggregateJob = document.jobs.test;

  assert.ok(behaviorJob, 'the public contract job must exist');
  assert.equal(
    behaviorJob.needs,
    undefined,
    'the behavior gate must run even when an independent public-suite baseline fails',
  );
  assertOpenCodeBehaviorBaseline(behaviorJob.steps);

  assert.equal(aggregateJob.if, 'always()', 'the required public check must inspect every dependency terminal');
  for (const requiredJob of [
    'public-test-prepare',
    'public-test-shards',
    'public-test-summary',
    'public-test-serial',
    'public-test-contract',
  ]) {
    assert.ok(aggregateJob.needs.includes(requiredJob), `Test (Public) must require ${requiredJob}`);
  }
});

test('windows-smoke.yml installs and requires the exact OpenCode behavior baseline', () => {
  const document = parse(
    readFileSync(new URL('../../../.github/workflows/windows-smoke.yml', import.meta.url), 'utf8'),
  );
  assertOpenCodeBehaviorBaseline(document.jobs['test-windows'].steps);
});
