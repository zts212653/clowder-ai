// @ts-check

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { buildPacket, seedCanonicalMeasurementCensusState } from './publish-verdict-fixtures.js';

describe('F267 measurement-validity publish gate', () => {
  it('blocks fix/build/delete_sunset before an active bundle has usable certified evidence', async (t) => {
    const repoRoot = mkdtempSync(`${tmpdir()}/f267-publish-gate-`);
    t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
    seedCanonicalMeasurementCensusState(repoRoot);
    const harnessFeedbackRoot = resolve(repoRoot, 'docs/harness-feedback');
    let generatorCalled = false;
    const gitPublisher = {
      async publishOnIsolatedWorktree(opts) {
        await opts.stage(repoRoot);
        return { commitSha: 'unreachable', prUrl: 'unreachable' };
      },
    };

    for (const verdict of ['fix', 'build', 'delete_sunset']) {
      const result = await handlePublishVerdict(
        {
          harnessFeedbackRoot,
          gitPublisher,
          generator: async () => {
            generatorCalled = true;
            throw new Error('generator must not run through the F267 validity gate');
          },
        },
        {
          packet: buildPacket({
            id: `f267-block-${verdict.replace('_', '-')}`,
            verdict,
            governance: { cvoAcceptRequired: true },
            ownerAsk: {
              targetFeatureId: 'F167',
              targetOwnerCatId: 'opus-47',
              requestedAction: verdict,
            },
            evidencePacket: {
              snapshotRefs: ['snapshot:test'],
              attributionRefs: ['attribution:test'],
              metricRefs: ['metric:turn_custody.projections_total'],
              sampleTraceRefs: ['trace:test'],
            },
            dailyTrend: {
              window: '24h',
              current: { 'turn_custody.projections_total': 5 },
              baseline: { 'turn_custody.projections_total': 2 },
              threshold: { 'turn_custody.projections_total': 10 },
              direction: 'regressed',
            },
          }),
          domain: 'eval:a2a',
          catId: 'codex',
          sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
        },
      );

      assert.ok('error' in result);
      assert.equal(result.status, 409);
      assert.equal(result.error, 'measurement_validity_gate');
      assert.match(result.detail, /keep_observe_only|certificate|insufficient/i);
    }
    assert.equal(generatorCalled, false);
  });
});
