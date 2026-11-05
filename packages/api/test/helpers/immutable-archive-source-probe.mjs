import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { deploymentDefaults } from '@cat-cafe/shared';
import { cortexHref } from '../../dist/infrastructure/capability-evolution/adapters/microduck-exploration/cortex-reader.js';
import { readMicroduckFootballPreparationPublication } from '../../dist/infrastructure/capability-evolution/adapters/microduck-preparation/football-publication.js';
import { footballSmokeSources } from '../../dist/infrastructure/capability-evolution/adapters/microduck-preparation/publication.js';
import { projectRequestReviewHarnessExploration } from '../../dist/infrastructure/capability-evolution/adapters/request-review/request-review-harness-lineage.js';

const read = (path) => readFileSync(new URL(path, new URL('../../../../', import.meta.url)));
const archive = JSON.parse(read('packages/shared/src/__tests__/fixtures/f314-history-publication-contract.json'));
archive.snapshotCommit = 'b242c8c8badfd4f6d2eba2016cc63cdaaa2e9768';
archive.ownerReviewCommit = '4042de718a6c0b00f0e846175c19b0271d7e000a';
const input = {
  programRef: { ownerFeatureId: 'F311', ownerStateRef: 'program:archive-source' },
  objectRef: { ownerFeatureId: 'F100', ownerStateRef: 'capability:development-process-harness-effectiveness' },
};
const now = () => '2026-10-21T13:00:00.000Z';
const catalog = projectRequestReviewHarnessExploration(input, archive, now());
assert(catalog?.experiments.length);
const detail = projectRequestReviewHarnessExploration(
  { ...input, selectedExperimentRef: catalog.experiments[0].experimentRef },
  archive,
  now(),
);
const references = detail.experiments[0].conditions.preparationRefs;
const legacy = { ...archive, schemaVersion: 1, status: 'owner-reviewed-source-index' };
delete legacy.story;
const commits = projectRequestReviewHarnessExploration(input, legacy, now());
assert(commits?.nodes[0]?.changes.length);
const smoke = footballSmokeSources('be78ad81bb2031db15ffe1d6826d235f0575b0b46418cf3a52779854d6fc35b9');
assert.equal(smoke.length, 2);
const path = 'docs/videos/f311-microduck-roadshow/pipeline/football/README.md';
const document = Buffer.from('Portable public archive source fixture');
const publication = {
  schemaVersion: 1,
  ownerFeatureId: 'microduck-owner',
  objectStateRef: 'simulator:walking',
  resourceCommit: 'a9b28fa76235f5635bd9b2fd3a974a78afafc732',
  updatedAt: now(),
  groups: [
    {
      groupStateRef: 'group:source',
      title: 'Source fixture',
      items: [
        {
          materialStateRef: 'material:source',
          title: 'Source fixture',
          summary: 'Portable contract fixture',
          status: 'available',
          facts: [],
          resources: [
            {
              kind: 'document',
              label: 'Published source',
              path,
              sha256: createHash('sha256').update(document).digest('hex'),
            },
          ],
        },
      ],
    },
  ],
};
const football = await readMicroduckFootballPreparationPublication(async (requested) => {
  if (requested === path) return document;
  if (requested.endsWith('/workspace-publication.json')) return Buffer.from(JSON.stringify(publication));
  throw new Error(`Unexpected archive read: ${requested}`);
});
assert(football?.groups.length, 'the actual reader must validate and project the public fixture');
process.stdout.write(
  JSON.stringify({
    deploymentRepository: deploymentDefaults.repositoryFullName,
    projections: {
      cortex: [cortexHref('cortex-793-live1/manifest.json')],
      footballSmoke: [smoke[0].ownerHref],
      footballImage: [smoke[1].ownerHref],
      footballPublication: football.groups.flatMap((group) =>
        group.items.flatMap((item) => item.resources.map((entry) => entry.ownerHref)),
      ),
      caseSource: [references[0].href],
      ownerReview: [references.at(-1).href],
      storySource: catalog.nodes.flatMap((node) => node.changes.map((change) => change.ownerHref)),
      historicalCommit: commits.nodes.flatMap((node) => node.changes.map((change) => change.ownerHref)),
    },
  }),
);
