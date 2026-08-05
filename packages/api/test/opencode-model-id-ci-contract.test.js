import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

const requiredVersion = '1.18.9';

for (const [workflow, jobName] of [
  ['ci.yml', 'test'],
  ['windows-smoke.yml', 'test-windows'],
]) {
  test(`${workflow} installs and requires the exact OpenCode behavior baseline`, () => {
    const document = parse(readFileSync(new URL(`../../../.github/workflows/${workflow}`, import.meta.url), 'utf8'));
    const steps = document.jobs[jobName].steps;
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
    if (workflow === 'ci.yml') {
      const publicSuiteIndex = steps.findIndex((step) => step.run?.includes('test:public'));
      assert.ok(
        behaviorIndex < publicSuiteIndex,
        'the behavior gate must run even when an independent public-suite baseline fails',
      );
    }
  });
}
