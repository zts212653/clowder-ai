// @ts-check

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

async function moduleUnderTest() {
  return import('../../dist/infrastructure/harness-eval/publish-verdict/git-worktree-publisher.js');
}

describe('verdict publisher F267 census allowlist', () => {
  it('allows only the canonical census file while preserving deny-by-default registry scope', async () => {
    const { isAllowedCapabilityEvolutionMeasurementStagePath, isAllowedVerdictStagePath } = await moduleUnderTest();

    assert.equal(typeof isAllowedVerdictStagePath, 'function');
    assert.equal(isAllowedVerdictStagePath('docs/harness-feedback/registry/measurement-bundles.yaml'), true);
    assert.equal(isAllowedVerdictStagePath('docs/harness-feedback/registry/other.yaml'), false);
    assert.equal(isAllowedVerdictStagePath('docs/harness-feedback/verdicts/example.md'), true);
    assert.equal(isAllowedVerdictStagePath('docs/harness-feedback/certificates/example.yaml'), false);
    assert.equal(
      isAllowedCapabilityEvolutionMeasurementStagePath('docs/harness-feedback/certificates/example.yaml'),
      true,
    );
    assert.equal(
      isAllowedCapabilityEvolutionMeasurementStagePath('docs/harness-feedback/measurement-results/example.yaml'),
      true,
    );
    assert.equal(
      isAllowedCapabilityEvolutionMeasurementStagePath('docs/harness-feedback/decision-proofs/records/example.yaml'),
      true,
    );
    assert.equal(
      isAllowedCapabilityEvolutionMeasurementStagePath(
        'docs/harness-feedback/decision-proofs/owner-objects/example.yaml',
      ),
      true,
    );
    assert.equal(
      isAllowedCapabilityEvolutionMeasurementStagePath('docs/harness-feedback/measurement-roles/example/observer.yaml'),
      true,
    );
    assert.equal(isAllowedCapabilityEvolutionMeasurementStagePath('docs/harness-feedback/verdicts/example.md'), false);
    assert.equal(isAllowedVerdictStagePath('docs/ROADMAP.md'), false);
  });
});
