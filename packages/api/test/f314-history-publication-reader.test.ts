import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  evolutionExplorationReviewV1Schema,
  evolutionExplorationSelectionMatches,
  refIdentity,
} from '@cat-cafe/shared';
import { projectRequestReviewHarnessExploration } from '../src/infrastructure/capability-evolution/adapters/request-review/request-review-harness-lineage.js';
import {
  createRequestReviewOwnerAdapter,
  type RequestReviewOwnerPort,
} from '../src/infrastructure/capability-evolution/adapters/request-review/request-review-owner-adapter.js';

const archive = JSON.parse(
  readFileSync(
    new URL('../../shared/src/__tests__/fixtures/f314-history-publication-contract.json', import.meta.url),
    'utf8',
  ),
);
const input = {
  programRef: { ownerFeatureId: 'F311', ownerStateRef: 'evolution-program:ba0f4524e49cc879279164d5b272cf8c' },
  objectRef: { ownerFeatureId: 'F100', ownerStateRef: 'capability:development-process-harness-effectiveness' },
};

test('publication identity changes with the narrative even when its evidence cut does not', () => {
  const next = structuredClone(archive);
  next.story.nodes[0].title = '刚补上的后续结果';
  const aRef = { ownerFeatureId: 'F314', ownerStateRef: 'harness-history:publication:p', version: 'a'.repeat(40) };
  const bRef = { ...aRef, version: 'b'.repeat(40) };
  const a = projectRequestReviewHarnessExploration(input, archive, '2026-10-16T19:00:00Z', aRef)!;
  const b = projectRequestReviewHarnessExploration(input, next, '2026-10-16T19:00:00Z', bRef)!;
  assert.notEqual(refIdentity(a.sourceRef), refIdentity(b.sourceRef));
  assert.notEqual(refIdentity(a.nodes[0].nodeRef), refIdentity(b.nodes[0].nodeRef));
  assert.notEqual(refIdentity(a.experiments[0].experimentRef), refIdentity(b.experiments[0].experimentRef));
  assert.equal(
    a.experiments[0].conditions.preparationRefs[0].href,
    b.experiments[0].conditions.preparationRefs[0].href,
  );
  const exact = {
    ...input,
    selectedSourceRef: aRef,
    selectedNodeRef: a.experiments[0].nodeRef,
    selectedExperimentRef: a.experiments[0].experimentRef,
  };
  const detail = projectRequestReviewHarnessExploration(exact, archive, '2026-10-16T19:00:00Z', aRef)!;
  assert.equal(detail.nodes[0].title, archive.story.nodes[0].title);
  assert.equal(detail.details.length, 1);
  assert.equal(evolutionExplorationReviewV1Schema.safeParse(detail).success, true);
  assert.equal(evolutionExplorationSelectionMatches(detail, exact), true);
  assert.equal(evolutionExplorationSelectionMatches(detail, { selectedSourceRef: bRef }), false);
});

test('F314 history reads its publication owner while the running Git HEAD remains unchanged', async () => {
  const next = structuredClone(archive);
  next.story.nodes[0].title = '刚补上的后续结果';
  const runningHead = 'a'.repeat(40);
  let deployedIndexReads = 0;
  const port: RequestReviewOwnerPort = {
    gitHeadOid: async () => runningHead,
    gitBlobOidAt: async () => 'b'.repeat(40),
    readSkillFileAt: async () => '',
    readMutableAcceptedSourceAt: async () => '',
    listFileHistoryAt: async () => [],
    readHarnessLineageAt: async () => {
      deployedIndexReads++;
      return archive;
    },
  };
  const options = {
    port,
    historyReader: async () => projectRequestReviewHarnessExploration(input, next, '2026-10-16T19:00:00Z'),
  };
  const adapter = createRequestReviewOwnerAdapter(options);
  const raw = await adapter.explorationReview?.(input);
  const review = raw as ReturnType<typeof projectRequestReviewHarnessExploration>;
  assert.equal(review?.nodes[0]?.title, '刚补上的后续结果');
  assert.equal(await port.gitHeadOid(), runningHead);
  assert.equal(deployedIndexReads, 0, 'published history must not consult the deployed source index');
});
