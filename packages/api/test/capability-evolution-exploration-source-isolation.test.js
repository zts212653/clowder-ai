import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evolutionAssetReviewV1Schema } from '@cat-cafe/shared';
import { createMicroduckExplorationBindings } from '../dist/infrastructure/capability-evolution/adapters/microduck-exploration/publication.js';
import { readExplorationOwner } from '../dist/infrastructure/capability-evolution/read-model/program-exploration.js';

const programRef = { ownerFeatureId: 'F311', ownerStateRef: 'evolution-program:bcc336788a7df9d6075b1efb4c0a7e68' };
const objectRef = { ownerFeatureId: 'microduck-owner', ownerStateRef: 'simulator:walking', version: '1' };
const sourceRef = { ...objectRef, ownerStateRef: 'owner:publication' };
const versionRef = { ...objectRef, assetKind: 'code', assetId: 'walking-policy' };
const versionReview = async () =>
  evolutionAssetReviewV1Schema.parse({
    schemaVersion: 1,
    status: 'resolved',
    programRef,
    objectRef,
    sourceRef,
    currentProofRef: sourceRef,
    readAt: '2026-09-09T14:00:00.000Z',
    versions: [{ versionRef, title: 'Official walking policy', parentEdges: [] }],
    currentVersionRefs: [versionRef],
    blockers: [{ code: 'owner_note', ownerRef: objectRef }],
  });

for (const fault of ['unavailable', 'invalid']) {
  const readBytes = async () => {
    if (fault === 'invalid') return new Uint8Array();
    throw Object.assign(new Error('this install does not contain the local demonstration archive'), { code: 'ENOENT' });
  };
  test(`a ${fault} local archive does not erase healthy owner versions or masquerade as their source`, async () => {
    const adapter = createMicroduckExplorationBindings({ repoRoot: '/isolated-install', readBytes, versionReview });
    for (const selection of [{}, { selectedNodeRef: versionRef }]) {
      const result = await readExplorationOwner(adapter, { programRef, objectRef, ...selection });
      assert.equal(result.code, 200, JSON.stringify(result.body));
      assert.deepEqual(result.body.sourceRef, sourceRef);
      assert.equal(result.body.nodes.length, 1);
      assert.deepEqual(result.body.nodes[0].versionRef, versionRef);
      assert.deepEqual(result.body.experiments, []);
      assert.deepEqual(result.body.details, []);
      assert(result.body.blockers.some((b) => b.code === `owner_public_archive_${fault}`));
      assert(result.body.blockers.some((b) => b.code === 'owner_note'));
    }
    const missingPublic = { ...objectRef, ownerStateRef: 'public-controller:unavailable', version: 'missing' };
    const selected = await readExplorationOwner(adapter, { programRef, objectRef, selectedNodeRef: missingPublic });
    assert.equal(selected.code, fault === 'invalid' ? 422 : 503);
    assert.equal(selected.body.status, fault);
    assert.equal(selected.body.nodes, undefined, 'an explicit archive selection cannot silently become an owner read');
    assert(selected.body.blockers.some((b) => b.code === `owner_public_archive_${fault}`));
  });

  test(`two unavailable sources preserve the ${fault} archive classification without inventing a catalog`, async () => {
    const adapter = createMicroduckExplorationBindings({ repoRoot: '/isolated-install', readBytes });
    const result = await readExplorationOwner(adapter, { programRef, objectRef });
    assert.equal(result.code, fault === 'invalid' ? 422 : 503);
    assert.equal(result.body.nodes, undefined);
    assert(result.body.blockers.some((b) => b.code === `owner_public_archive_${fault}`));
    assert(result.body.blockers.some((b) => b.code === 'owner_version_review_unavailable'));
  });
}
