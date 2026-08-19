import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { validateMetricRefsAgainstGlossary } from '../../dist/infrastructure/harness-eval/publish-verdict/metric-glossary-validation.js';
import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { setupHarnessFeedback } from './eval-manual-trigger-fixtures.js';
import { buildPacket } from './publish-verdict-fixtures.js';

const TEST_GLOSSARY = {
  'c1.test': { label: 'Test metric' },
  'hold_lifecycle.zombie_count': { label: 'Zombie holds' },
  'inline_action.feedback_written': { label: 'Feedback writes' },
  'process.runtime_pid': { label: 'Runtime pid' },
};

describe('publish_verdict metric glossary preflight', () => {
  it('accepts the historical metric ref aliases understood by Eval Hub', () => {
    for (const metricRef of [
      'metric:c1.test=4',
      'metric:cat_cafe_a2a_hold_zombie_count_total=2',
      'metric:cat_cafe.a2a.inline_action_feedback_written_total{catId="codex"}=1',
      'metric:process:runtime_pid=123',
    ]) {
      const packet = buildPacket({
        evidencePacket: { ...buildPacket().evidencePacket, metricRefs: [metricRef] },
      });
      assert.equal(validateMetricRefsAgainstGlossary(packet, { metricGlossary: TEST_GLOSSARY }), null);
    }
  });

  it('rejects unknown metricRefs before the publisher can open an evidence PR', async () => {
    const root = setupHarnessFeedback();
    const registryPath = join(root, 'eval-domains', 'eval-a2a.yaml');
    writeFileSync(
      registryPath,
      `${readFileSync(registryPath, 'utf8')}metricGlossary:\n  c1.test:\n    label: Test metric\n    means: Test-only glossary entry.\n    goodDirection: neutral\n`,
    );
    let publisherCalled = false;
    let generatorCalled = false;

    try {
      const packet = buildPacket({
        id: 'vhp-unknown-metric-ref',
        evidencePacket: {
          ...buildPacket().evidencePacket,
          metricRefs: ['metric:not_registered=1'],
        },
      });
      const result = await handlePublishVerdict(
        {
          harnessFeedbackRoot: root,
          generator: async () => {
            generatorCalled = true;
            throw new Error('generator_should_not_run');
          },
          gitPublisher: {
            async publishOnIsolatedWorktree() {
              publisherCalled = true;
              throw new Error('publisher_should_not_run');
            },
          },
        },
        {
          packet,
          domain: 'eval:a2a',
          catId: 'codex',
          sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
        },
      );

      assert.equal(result.status, 400);
      assert.equal(result.error, 'metric_refs_not_in_glossary');
      assert.match(result.detail, /metric:not_registered=1/);
      assert.equal(publisherCalled, false);
      assert.equal(generatorCalled, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
