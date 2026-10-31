import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  readExplorationOwner,
  resolveExplorationProjection,
} from '../dist/infrastructure/capability-evolution/read-model/program-exploration.js';
import { explorationFixture } from './capability-evolution-exploration.helper.mjs';
import { verifyExplorationProjectionRecovery } from './capability-evolution-exploration-projection-recovery.helper.mjs';

verifyExplorationProjectionRecovery('legacy');

test('a deterministic record-set violation remains invalid without trimming cases or claiming a source outage', async () => {
  const publication = explorationFixture({ withDetail: true });
  publication.experiments[0].recordCount += 1;
  const input = { programRef: publication.programRef, objectRef: publication.objectRef };
  const result = await readExplorationOwner(
    { explorationReview: async () => resolveExplorationProjection(input, publication) },
    input,
  );
  assert.equal(result.code, 422);
  assert.equal(result.body.status, 'invalid');
  assert(result.body.blockers.some((b) => b.code === 'owner_exploration_projection_invalid'));
  assert.equal(result.body.nodes, undefined);
  assert.equal(publication.details[0].records.length, 1);
  assert.equal(publication.experiments[0].recordCount, 2);
});

test('an entirely withheld lineage stays explicitly invalid rather than claiming no versions were published', async () => {
  const publication = explorationFixture();
  publication.nodes[0].parentEdges = [
    { parentNodeRef: { ...publication.nodes[0].nodeRef, version: 'missing' }, sourceRef: publication.sourceRef },
  ];
  const input = { programRef: publication.programRef, objectRef: publication.objectRef };
  const result = await readExplorationOwner(
    { explorationReview: async () => resolveExplorationProjection(input, publication) },
    input,
  );
  assert.equal(result.code, 422);
  assert.equal(result.body.status, 'invalid');
  assert(result.body.blockers.some((b) => b.code === 'owner_exploration_lineage_withheld'));
});
