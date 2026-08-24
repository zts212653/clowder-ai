import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createEvalDomainDailySpec } from '../../dist/infrastructure/harness-eval/domain/eval-domain-daily.js';
import { createEvalDomainNDaySpec } from '../../dist/infrastructure/harness-eval/domain/eval-domain-nday.js';
import { FIXTURE_FRICTION_3D_YAML, makeRedis, makeTempRoot } from './eval-domain-nday-fixtures.js';

const repoHarnessFeedbackRoot = fileURLToPath(new URL('../../../../docs/harness-feedback', import.meta.url));

async function readDeliveredContent(spec, subjectKey) {
  const gateResult = await spec.admission.gate();
  assert.equal(gateResult.run, true);
  const item = gateResult.workItems.find((candidate) => candidate.subjectKey === subjectKey);
  assert.ok(item, `missing scheduled work item ${subjectKey}`);

  const deliver = mock.fn(async () => 'scheduled-message');
  await spec.run.execute(item.signal, item.subjectKey, {
    assignedCatId: null,
    deliver,
    invokeTrigger: { trigger: mock.fn() },
  });

  assert.equal(deliver.mock.callCount(), 1);
  return deliver.mock.calls[0].arguments[0].content;
}

function assertSharedCheckoutGroundingContract(content) {
  assert.match(content, /Scheduled eval repository grounding \(shared checkout\)/);
  assert.match(content, /do not run `git pull`, `git merge`, or `git rebase`/);
  assert.match(content, /deployed runtime truth.*`git rev-parse HEAD`/);
  assert.match(content, /repository truth.*`git rev-parse origin\/main`/);
  assert.match(content, /command prose cannot prove which invocation moved HEAD/);
}

describe('scheduled eval repository grounding contract', () => {
  it('injects the passive-runtime, SHA-bound contract into daily eval messages', async () => {
    const spec = createEvalDomainDailySpec({ harnessFeedbackRoot: repoHarnessFeedbackRoot });
    const content = await readDeliveredContent(spec, 'eval:memory');

    assertSharedCheckoutGroundingContract(content);
  });

  it('injects the same contract into N-day eval messages', async () => {
    const root = makeTempRoot(FIXTURE_FRICTION_3D_YAML);
    const spec = createEvalDomainNDaySpec({ harnessFeedbackRoot: root, redis: makeRedis() });
    const content = await readDeliveredContent(spec, 'eval:friction');

    assertSharedCheckoutGroundingContract(content);
  });
});
