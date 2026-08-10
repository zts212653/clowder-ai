import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';
import {
  loadLegacyReevalCaseMigrations,
  resolveLifecycleRootsWithLegacyCases,
} from '../../dist/infrastructure/harness-eval/legacy-reeval-case-migration.js';
import { scanLifecycleRootArtifacts } from '../../dist/infrastructure/harness-eval/publish-verdict/lifecycle-root-artifact.js';

const harnessFeedbackRoot = join(process.cwd(), '..', '..', 'docs', 'harness-feedback');
const migrationManifestPath = join(harnessFeedbackRoot, 'migrations', 'f266-legacy-reeval-cases.yaml');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('F266 legacy v1 stable-case migration', () => {
  it('groups covered v1 roots while preserving post-boundary artifacts and historical aliases', () => {
    const originalRoots = scanLifecycleRootArtifacts(harnessFeedbackRoot);
    const legacyV1 = originalRoots.filter((root) => root.schemaVersion === 1);
    const manifest = parseYaml(readFileSync(migrationManifestPath, 'utf8'));
    const reviewedThrough = Date.parse(manifest.reviewedThrough);
    assert.ok(Number.isFinite(reviewedThrough), 'migration manifest must declare a valid reviewedThrough boundary');
    const hashesBefore = new Map(
      legacyV1.map((root) => {
        const path = join(harnessFeedbackRoot, 'bundles', root.verdictId, 'lifecycle-root.json');
        return [root.verdictId, sha256(path)];
      }),
    );

    const migrations = loadLegacyReevalCaseMigrations(harnessFeedbackRoot);
    const resolved = resolveLifecycleRootsWithLegacyCases(harnessFeedbackRoot, originalRoots);
    const migratedByVerdict = new Map(resolved.map((root) => [root.verdictId, root]));

    assert.equal(migrations.length, 13);
    for (const legacyRoot of legacyV1) {
      const migrated = migratedByVerdict.get(legacyRoot.verdictId);
      assert.ok(migrated, `${legacyRoot.verdictId} must remain in the resolved corpus`);
      if (migrated.schemaVersion === 1) {
        assert.ok(
          Date.parse(legacyRoot.createdAt) > reviewedThrough,
          `${legacyRoot.verdictId} may remain v1 only after the reviewed legacy boundary`,
        );
      } else {
        assert.match(migrated.caseId, /^eval-case-v1-[a-f0-9]{64}$/);
        assert.ok(migrated.findingKey.length > 0);
      }
      const path = join(harnessFeedbackRoot, 'bundles', legacyRoot.verdictId, 'lifecycle-root.json');
      assert.equal(sha256(path), hashesBefore.get(legacyRoot.verdictId));
    }

    const postBoundaryContinuations = [
      [
        '2026-08-10-eval-a2a-phase-t-unexplained-streak-gated-observe',
        '2026-08-03-eval-a2a-phase-t-post-repair-short-window-no-samples',
      ],
      [
        '2026-08-10-task-outcome-keep-observe-pr-lifecycle-terminal-drift-magic-watch',
        '2026-08-05-task-outcome-keep-observe-pr-lifecycle-terminal-drift-a2-watch',
      ],
    ];
    for (const [continuationVerdictId, reviewedVerdictId] of postBoundaryContinuations) {
      const continuation = migratedByVerdict.get(continuationVerdictId);
      const reviewed = migratedByVerdict.get(reviewedVerdictId);
      assert.equal(continuation?.schemaVersion, 2, `${continuationVerdictId} must continue its stable case`);
      assert.equal(reviewed?.schemaVersion, 2, `${reviewedVerdictId} must define the reviewed stable case`);
      assert.equal(continuation.caseId, reviewed.caseId);
    }

    const f203 = migrations.find((migration) => migration.findingKey === 'workspace-navigator-activation');
    assert.deepEqual(f203?.freshnessReview, {
      reviewedAt: '2026-08-09T01:41:59.000Z',
      reviewedThroughVerdictId: '2026-07-26-capability-wakeup-workspace-navigator-insufficient-fix-v2',
      disposition: 'repair',
      evidenceRefs: ['source-message:0001785893991161-000132-d30dc683'],
    });

    const f267 = migrations.find((migration) => migration.findingKey === 'f267-memory-measurement-validity');
    assert.deepEqual(f267?.freshnessReview, {
      reviewedAt: '2026-08-09T04:18:00.000Z',
      reviewedThroughVerdictId: '2026-08-09-eval-memory-source-selector-validity-blocked-keep-observe',
      disposition: 'monitor',
      evidenceRefs: ['verdict:2026-08-09-eval-memory-source-selector-validity-blocked-keep-observe'],
    });

    const phaseGAliases = [
      '2026-07-22-task-outcome-keep-observe-clean-a1-window',
      '2026-07-26-task-outcome-keep-observe-proposal-reject-watch',
      '2026-08-02-task-outcome-keep-observe-a2-watch',
    ].map((verdictId) => migratedByVerdict.get(verdictId)?.caseId);
    assert.equal(new Set(phaseGAliases).size, 1);
  });

  it('bounds completeness fail-closed to the reviewed legacy snapshot', () => {
    const roots = scanLifecycleRootArtifacts(harnessFeedbackRoot);
    const futureVerdictId = '2026-08-20-eval-qc-new-finding-without-findingkey';
    const futureRoot = {
      ...roots.find((root) => root.schemaVersion === 1 && root.domainId === 'eval:qc'),
      schemaVersion: 1,
      verdictId: futureVerdictId,
      createdAt: '2026-08-20T00:00:00.000Z',
      harnessUnderEval: { featureId: 'F253', componentId: 'future-qc-finding', name: 'Future QC finding' },
    };

    const resolved = resolveLifecycleRootsWithLegacyCases(harnessFeedbackRoot, [...roots, futureRoot]);

    assert.equal(resolved.find((root) => root.verdictId === futureVerdictId)?.schemaVersion, 1);
  });
});
