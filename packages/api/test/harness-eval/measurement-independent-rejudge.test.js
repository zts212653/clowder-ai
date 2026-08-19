// @ts-check

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { parse } from 'yaml';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const sourceMapRef = 'docs/harness-feedback/rejudge-source-maps/f267-friction-2026-07-18-to-24.yaml';
const cohortRef = 'docs/harness-feedback/rejudge-cohorts/f267-friction-2026-07-18-to-24.yaml';

const sourceDefinitions = [
  {
    itemId: 'item-001',
    measurementRef:
      'docs/harness-feedback/bundles/2026-07-18-eval-friction-manual-recheck-rolling-window-toolgap-watch/raw/measurement-validity.json',
    rollupRef:
      'docs/harness-feedback/bundles/2026-07-18-eval-friction-manual-recheck-rolling-window-toolgap-watch/raw/rollup-report.json',
    measurementSha256: '62c9131d0f694afcb9b4f58d2c692ae0857a2bf3a9622e08d9710189a745e652',
    rollupSha256: 'c3db70fd054e209922231add4439b3291bb77384bb914957b9c93aa5a79a988f',
    window: { startMs: 1784157586204, endMs: 1784416786204 },
  },
  {
    itemId: 'item-002',
    measurementRef:
      'docs/harness-feedback/bundles/2026-07-21-eval-friction-overlap-tail-after-routing-guard-watch/raw/measurement-validity.json',
    rollupRef:
      'docs/harness-feedback/bundles/2026-07-21-eval-friction-overlap-tail-after-routing-guard-watch/raw/rollup-report.json',
    measurementSha256: '76c5fbe83e5b544b214f93aee00020f2a52a2edfeb40deb841dc1d39c4a2647f',
    rollupSha256: '68f5beb2597bb4e46d6c49be7902f08266a88f50608d724a9ae4dea8d2295b00',
    window: { startMs: 1784343600000, endMs: 1784602800000 },
  },
  {
    itemId: 'item-003',
    measurementRef:
      'docs/harness-feedback/bundles/2026-07-24-eval-friction-singleton-tool-contract-watch/raw/measurement-validity.json',
    rollupRef:
      'docs/harness-feedback/bundles/2026-07-24-eval-friction-singleton-tool-contract-watch/raw/rollup-report.json',
    measurementSha256: '2e6a9403100ea367b27f54e42ac1a4baaaffa62b632fe254616764219f2a87b1',
    rollupSha256: '5168457d3829a162d2b4edcc70490ff8a2ffe154b855d631fa2e7ddf662af1d0',
    window: { startMs: 1784602800000, endMs: 1784862000000 },
  },
];

function sourceInput(definition) {
  return {
    itemId: definition.itemId,
    measurementSource: {
      ref: definition.measurementRef,
      bytes: readFileSync(resolve(repoRoot, definition.measurementRef)),
    },
    rollupSource: {
      ref: definition.rollupRef,
      bytes: readFileSync(resolve(repoRoot, definition.rollupRef)),
    },
  };
}

function readYaml(ref) {
  return parse(readFileSync(resolve(repoRoot, ref), 'utf8'));
}

async function moduleUnderTest() {
  return import('../../dist/infrastructure/harness-eval/measurement/measurement-independent-rejudge.js');
}

describe('F267 frozen independent-rejudge cohort', () => {
  it('separates checker-only provenance from a decision-blind cohort', async () => {
    const { buildFrozenFrictionRejudgeArtifacts } = await moduleUnderTest();
    const result = buildFrozenFrictionRejudgeArtifacts(sourceDefinitions.map(sourceInput), {
      sourceMapId: 'f267-friction-2026-07-18-to-24-source-map',
      cohortId: 'f267-friction-2026-07-18-to-24',
    });

    assert.deepEqual(
      result.sourceMap.items,
      sourceDefinitions.map((definition) => ({
        itemId: definition.itemId,
        measurementSource: {
          ref: definition.measurementRef,
          sha256: definition.measurementSha256,
        },
        rollupSource: {
          ref: definition.rollupRef,
          sha256: definition.rollupSha256,
        },
      })),
    );

    assert.deepEqual(
      result.cohort.items,
      sourceDefinitions.map((definition) => ({
        itemId: definition.itemId,
        window: definition.window,
        sourceDigests: {
          measurementSha256: definition.measurementSha256,
          rollupSha256: definition.rollupSha256,
        },
        evidence: {
          cancel: {
            opportunityStatus: 'measured',
            expectedCount: 0,
            actualCount: 0,
            intersectionCount: 0,
            missingCount: 0,
            extraCount: 0,
            recall: null,
          },
          downstreamDegraded: true,
          droppedChannels: [],
        },
      })),
    );

    const itemIds = result.cohort.items.map((item) => item.itemId);
    assert.deepEqual(itemIds, [...itemIds].sort());
    assert.equal(new Set(itemIds).size, itemIds.length);
    assert.ok(itemIds.every((itemId) => /^item-\d{3}$/.test(itemId)));

    const cohortBytes = JSON.stringify(result.cohort);
    for (const definition of sourceDefinitions) {
      assert.doesNotMatch(cohortBytes, new RegExp(definition.measurementRef));
      assert.doesNotMatch(cohortBytes, new RegExp(definition.rollupRef));
    }
    assert.doesNotMatch(cohortBytes, /measurement-validity|rollup-report/);
    assert.doesNotMatch(
      cohortBytes,
      /"(?:ref|expectedIds|actualIds|intersectionIds|missingIds|extraIds|decision|reasons|withdrawalConditions|attribution|report|verdictId)"/,
    );

    assert.deepEqual(result.sourceMap, readYaml(sourceMapRef));
    assert.deepEqual(result.cohort, readYaml(cohortRef));
  });
});
