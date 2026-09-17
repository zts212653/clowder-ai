import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { evolutionAssetReviewV1Schema } from '@cat-cafe/shared';
import { createMicroduckExplorationBindings } from '../dist/infrastructure/capability-evolution/adapters/microduck-exploration/publication.js';
import { readExplorationOwner } from '../dist/infrastructure/capability-evolution/read-model/program-exploration.js';

const repoRoot = resolve(import.meta.dirname, '../../..');
const programRef = { ownerFeatureId: 'F311', ownerStateRef: 'evolution-program:bcc336788a7df9d6075b1efb4c0a7e68' };
const objectRef = { ownerFeatureId: 'microduck-owner', ownerStateRef: 'simulator:walking', version: '1' };
const sourceRef = { ...objectRef, ownerStateRef: 'owner:publication' };
const versionRef = { ...objectRef, assetKind: 'code', assetId: 'walking', version: 'v2' };

export function verifyExplorationProjectionRecovery(mode) {
  for (const defect of ['withdrawn-parent', 'cycle'])
    test(`${mode} retains independent nodes while ${defect} awaits owner correction`, async () => {
      let withdrawnParent = true;
      const versionReview = async () =>
        evolutionAssetReviewV1Schema.parse({
          schemaVersion: 1,
          status: 'resolved',
          programRef,
          objectRef,
          sourceRef,
          currentProofRef: sourceRef,
          readAt: '2026-09-09T14:00:00.000Z',
          versions: [
            { versionRef: { ...versionRef, version: 'v0' }, title: 'independent version', parentEdges: [] },
            {
              versionRef,
              title: 'walking v2',
              parentEdges: withdrawnParent
                ? [
                    {
                      parentVersionRef: { ...versionRef, version: defect === 'cycle' ? 'v3' : 'v1' },
                      edgeRef: sourceRef,
                    },
                  ]
                : [],
            },
            {
              versionRef: { ...versionRef, version: 'v3' },
              title: 'dependent version',
              parentEdges: [{ parentVersionRef: versionRef, edgeRef: sourceRef }],
            },
          ],
          currentVersionRefs: [],
          blockers: [{ code: 'owner_note', ownerRef: objectRef }],
        });
      assert.equal(
        (await versionReview()).status,
        'resolved',
        'the owner response itself satisfies its accepted contract',
      );
      const adapter =
        mode === 'legacy' ? { versionReview } : createMicroduckExplorationBindings({ repoRoot, versionReview });
      const broken = await readExplorationOwner(adapter, { programRef, objectRef });
      assert.equal(broken.code, 200, JSON.stringify({ status: broken.body.status, blockers: broken.body.blockers }));
      assert.equal(broken.body.status, 'resolved');
      assert(broken.body.blockers.some((b) => b.code === 'owner_exploration_lineage_withheld'));
      assert(broken.body.blockers.some((b) => b.code === 'owner_note'));
      assert(!broken.body.blockers.some((b) => b.code.startsWith('owner_public_archive_')));
      assert.deepEqual(
        broken.body.nodes.filter((n) => n.kind === 'owner_version').map((n) => n.versionRef.version),
        ['v0'],
      );
      assert.equal(broken.body.nodes.filter((n) => n.kind === 'public_archive').length, mode === 'legacy' ? 0 : 9);
      const withheldSelection = await readExplorationOwner(adapter, {
        programRef,
        objectRef,
        selectedNodeRef: versionRef,
      });
      assert.equal(withheldSelection.code, 422);
      assert(withheldSelection.body.blockers.some((b) => b.code === 'owner_exploration_lineage_withheld'));
      if (mode === 'public-federation') {
        assert.equal(broken.body.experiments.length, 12);
        const run = broken.body.experiments[0];
        const detail = await readExplorationOwner(adapter, {
          programRef,
          objectRef,
          selectedNodeRef: run.nodeRef,
          selectedExperimentRef: run.experimentRef,
        });
        assert.equal(detail.code, 200);
        assert.equal(detail.body.details[0].records.length, run.recordCount);
      }
      withdrawnParent = false;
      const healed = await readExplorationOwner(adapter, { programRef, objectRef });
      assert.equal(healed.code, 200, JSON.stringify(healed.body));
      assert.equal(healed.body.nodes.filter((n) => n.kind === 'public_archive').length, mode === 'legacy' ? 0 : 9);
      assert.equal(healed.body.nodes.filter((n) => n.kind === 'owner_version').length, 3);
      assert(!healed.body.blockers.some((b) => b.code === 'owner_exploration_lineage_withheld'));
    });
}
