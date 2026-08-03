// @ts-check

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

async function moduleUnderTest() {
  return import('../../dist/infrastructure/harness-eval/publish-verdict/git-worktree-publisher.js');
}

describe('verdict publisher F267 census allowlist', () => {
  it('allows only the canonical census file while preserving deny-by-default registry scope', async () => {
    const { isAllowedVerdictStagePath } = await moduleUnderTest();

    assert.equal(typeof isAllowedVerdictStagePath, 'function');
    assert.equal(isAllowedVerdictStagePath('docs/harness-feedback/registry/measurement-bundles.yaml'), true);
    assert.equal(isAllowedVerdictStagePath('docs/harness-feedback/registry/other.yaml'), false);
    assert.equal(isAllowedVerdictStagePath('docs/harness-feedback/verdicts/example.md'), true);
    assert.equal(isAllowedVerdictStagePath('docs/ROADMAP.md'), false);
  });
});
