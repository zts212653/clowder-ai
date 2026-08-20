import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { buildCapabilityWakeupClosureImport } from './capability-wakeup-closure-import.js';
import {
  deriveEvalCaseId,
  type LifecycleRootArtifact,
  scanLifecycleRootArtifacts,
} from './publish-verdict/lifecycle-root-artifact.js';

const MIGRATION_PATH = join('migrations', 'f266-legacy-reeval-cases.yaml');
const nonEmptyString = z.string().trim().min(1);
const freshnessReviewSchema = z
  .object({
    reviewedAt: z.string().datetime({ offset: true }),
    reviewedThroughVerdictId: nonEmptyString,
    disposition: z.enum(['repair', 'monitor']),
    evidenceRefs: z.array(nonEmptyString).min(1),
  })
  .strict();
const migrationSchema = z
  .object({
    domainId: z.string().regex(/^eval:[a-z0-9][a-z0-9-]*$/),
    findingKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
    selectors: z.array(z.object({ featureId: nonEmptyString, componentId: nonEmptyString }).strict()).min(1),
    freshnessReview: freshnessReviewSchema,
  })
  .strict();
const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    reviewedThrough: z.string().datetime({ offset: true }),
    cases: z.array(migrationSchema).min(1),
  })
  .strict();

export type LegacyReevalCaseMigration = z.infer<typeof migrationSchema>;
type LegacyReevalCaseMigrationManifest = z.infer<typeof manifestSchema>;
type LifecycleRootV2 = Extract<LifecycleRootArtifact, { schemaVersion: 2 }>;

function migrationPath(harnessFeedbackRoot: string): string {
  return join(harnessFeedbackRoot, MIGRATION_PATH);
}

function loadMigrationManifest(harnessFeedbackRoot: string): LegacyReevalCaseMigrationManifest | undefined {
  const path = migrationPath(harnessFeedbackRoot);
  if (!existsSync(path)) return undefined;
  return manifestSchema.parse(parseYaml(readFileSync(path, 'utf8')));
}

export function loadLegacyReevalCaseMigrations(harnessFeedbackRoot: string): LegacyReevalCaseMigration[] {
  return loadMigrationManifest(harnessFeedbackRoot)?.cases ?? [];
}

function matches(root: LifecycleRootArtifact, migration: LegacyReevalCaseMigration): boolean {
  return (
    root.schemaVersion === 1 &&
    root.domainId === migration.domainId &&
    migration.selectors.some(
      (selector) =>
        root.harnessUnderEval.featureId === selector.featureId &&
        root.harnessUnderEval.componentId === selector.componentId,
    )
  );
}

function asStableCaseRoot(
  root: Extract<LifecycleRootArtifact, { schemaVersion: 1 }>,
  migration: LegacyReevalCaseMigration,
): LifecycleRootV2 {
  return {
    ...root,
    schemaVersion: 2,
    caseId: deriveEvalCaseId(migration.domainId, migration.findingKey),
    findingKey: migration.findingKey,
  };
}

function validateMigration(
  migration: LegacyReevalCaseMigration,
  matchingRoots: readonly Extract<LifecycleRootArtifact, { schemaVersion: 1 }>[],
): void {
  if (matchingRoots.length === 0) {
    throw new Error(`legacy case ${migration.findingKey} does not match any immutable lifecycle roots`);
  }
  const reviewed = matchingRoots.find((root) => root.verdictId === migration.freshnessReview.reviewedThroughVerdictId);
  if (!reviewed) {
    throw new Error(`legacy case ${migration.findingKey} freshness review references an unmatched verdict`);
  }
  const expectedDisposition = reviewed.verdict === 'keep_observe' ? 'monitor' : 'repair';
  if (migration.freshnessReview.disposition !== expectedDisposition) {
    throw new Error(`legacy case ${migration.findingKey} freshness disposition does not match the reviewed verdict`);
  }
  if (Date.parse(migration.freshnessReview.reviewedAt) < Date.parse(reviewed.createdAt)) {
    throw new Error(`legacy case ${migration.findingKey} freshness review predates the reviewed verdict`);
  }
}

export function resolveLifecycleRootsWithLegacyCases(
  harnessFeedbackRoot: string,
  roots: readonly LifecycleRootArtifact[],
): LifecycleRootArtifact[] {
  const manifest = loadMigrationManifest(harnessFeedbackRoot);
  const migrations = manifest?.cases ?? [];
  if (
    manifest?.cases.some(
      (migration) => Date.parse(migration.freshnessReview.reviewedAt) > Date.parse(manifest.reviewedThrough),
    )
  ) {
    throw new Error('legacy freshness review exceeds the manifest completeness boundary');
  }
  const matchedVerdictIds = new Set<string>();
  const caseIds = new Set<string>();

  for (const migration of migrations) {
    const caseId = deriveEvalCaseId(migration.domainId, migration.findingKey);
    if (caseIds.has(caseId)) throw new Error(`duplicate legacy stable case ${caseId}`);
    caseIds.add(caseId);
    const matchingRoots = roots.filter((root): root is Extract<LifecycleRootArtifact, { schemaVersion: 1 }> =>
      matches(root, migration),
    );
    validateMigration(migration, matchingRoots);
    for (const root of matchingRoots) {
      if (matchedVerdictIds.has(root.verdictId)) {
        throw new Error(`legacy lifecycle root ${root.verdictId} matches more than one stable case`);
      }
      matchedVerdictIds.add(root.verdictId);
    }
  }

  const uncovered = !manifest
    ? []
    : roots.filter(
        (root) =>
          root.schemaVersion === 1 &&
          Date.parse(root.createdAt) <= Date.parse(manifest.reviewedThrough) &&
          !matchedVerdictIds.has(root.verdictId),
      );
  if (uncovered.length > 0) {
    throw new Error(
      `active legacy lifecycle roots lack freshness review: ${uncovered.map((root) => root.verdictId).join(', ')}`,
    );
  }

  return roots.map((root) => {
    if (root.schemaVersion === 2) return root;
    const migration = migrations.find((candidate) => matches(root, candidate));
    return migration ? asStableCaseRoot(root, migration) : root;
  });
}

export function loadLifecycleRootsWithLegacyCases(harnessFeedbackRoot: string): LifecycleRootArtifact[] {
  const roots = scanLifecycleRootArtifacts(harnessFeedbackRoot);
  const historical = buildCapabilityWakeupClosureImport();
  const historicalVerdictPath = join(harnessFeedbackRoot, 'verdicts', `${historical.root.verdictId}.md`);
  if (existsSync(historicalVerdictPath) && !roots.some((root) => root.verdictId === historical.root.verdictId)) {
    roots.push(historical.root);
  }
  return resolveLifecycleRootsWithLegacyCases(harnessFeedbackRoot, roots);
}

export function migrationForCase(harnessFeedbackRoot: string, caseId: string): LegacyReevalCaseMigration | undefined {
  return loadLegacyReevalCaseMigrations(harnessFeedbackRoot).find(
    (migration) => deriveEvalCaseId(migration.domainId, migration.findingKey) === caseId,
  );
}
