import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GeneratedVerdictArtifact } from '../publish-verdict/types.js';
import { bundleDirIn, isStrictlyInside, SAFE_ARTIFACT_ID_PATTERN, verdictPathIn } from './artifact-store-layout.js';

/**
 * A generator reports where it wrote a verdict. That report is an address claim,
 * not proof, and two different consumers act on it:
 *
 * - The handler writes lifecycle roots into the returned bundle directories. It
 *   runs `assertGeneratedArtifactCoordinates` first, a pure check that every
 *   returned path is exactly the coordinate the output root defines for its verdict
 *   id, so a generator that picked the wrong root cannot redirect those writes
 *   outside the artifact being built.
 * - The publisher confirms a publication. It also runs `assertVerdictsMaterialized`
 *   against the staged tree and again against the final directory: each coordinate
 *   exists as the expected kind and resolves to itself, with no link leading out of
 *   the tree. Only then is the returned reference a statement about files that are
 *   really in the artifact.
 */

interface VerdictCoordinateClaim {
  label: string;
  verdictId: string;
  verdictPath: unknown;
  bundleDir: unknown;
}

function coordinateClaims(verdictId: string, generated: GeneratedVerdictArtifact): VerdictCoordinateClaim[] {
  return [
    { label: 'verdict', verdictId, verdictPath: generated.verdictPath, bundleDir: generated.bundleDir },
    ...(generated.childArtifacts ?? []).map((child) => ({
      label: `child verdict '${child.verdictId}'`,
      verdictId: child.verdictId,
      verdictPath: child.verdictPath,
      bundleDir: child.bundleDir,
    })),
  ];
}

function assertExactCoordinate(label: string, actual: unknown, expected: string): void {
  if (typeof actual !== 'string' || resolve(actual) !== expected) {
    throw new Error(
      `artifact_coordinate_mismatch: generator returned ${label} '${String(actual)}', expected '${expected}'`,
    );
  }
}

export function assertGeneratedArtifactCoordinates(
  outputRoot: string,
  verdictId: string,
  generated: GeneratedVerdictArtifact,
): void {
  const claimed = new Set<string>();
  for (const claim of coordinateClaims(verdictId, generated)) {
    if (!SAFE_ARTIFACT_ID_PATTERN.test(claim.verdictId)) {
      throw new Error(`artifact_coordinate_mismatch: ${claim.label} id is not a single safe path segment`);
    }
    // Two claims on one id would be two verdicts written to one file.
    if (claimed.has(claim.verdictId)) {
      throw new Error(
        `artifact_coordinate_mismatch: generator returned verdict id '${claim.verdictId}' more than once`,
      );
    }
    claimed.add(claim.verdictId);
    assertExactCoordinate(`${claim.label} markdown`, claim.verdictPath, verdictPathIn(outputRoot, claim.verdictId));
    assertExactCoordinate(`${claim.label} bundle`, claim.bundleDir, bundleDirIn(outputRoot, claim.verdictId));
  }
}

function assertMaterialized(label: string, path: string, realExpected: string, kind: 'file' | 'directory'): void {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new Error(`artifact_not_materialized: ${label} does not exist at ${path}`);
  }
  if (real !== realExpected) {
    throw new Error(`artifact_not_materialized: ${label} at ${path} resolves outside the artifact (${real})`);
  }
  const stat = statSync(real);
  if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) {
    throw new Error(`artifact_not_materialized: ${label} at ${path} is not a ${kind}`);
  }
}

/** Every verdict id a generation claims: the published verdict first, then its children. */
export function generatedVerdictIds(verdictId: string, generated: GeneratedVerdictArtifact): string[] {
  return coordinateClaims(verdictId, generated).map((claim) => claim.verdictId);
}

export function assertVerdictsMaterialized(outputRoot: string, verdictIds: readonly string[]): void {
  const realOutputRoot = realpathSync(outputRoot);
  for (const verdictId of verdictIds) {
    assertMaterialized(
      `verdict '${verdictId}' markdown`,
      verdictPathIn(outputRoot, verdictId),
      verdictPathIn(realOutputRoot, verdictId),
      'file',
    );
    assertMaterialized(
      `verdict '${verdictId}' bundle`,
      bundleDirIn(outputRoot, verdictId),
      bundleDirIn(realOutputRoot, verdictId),
      'directory',
    );
  }
}

/** Replay inputs a generator asks to publish must already be inside the staged artifact. */
export function assertStagedPathsInside(stagingRoot: string, stagedPaths: readonly string[] | undefined): void {
  if (!stagedPaths || stagedPaths.length === 0) return;
  const realStagingRoot = realpathSync(stagingRoot);
  for (const stagedPath of stagedPaths) {
    let real: string;
    try {
      real = realpathSync(stagedPath);
    } catch {
      throw new Error(`artifact_not_materialized: staged path does not exist: ${stagedPath}`);
    }
    if (!isStrictlyInside(realStagingRoot, real)) {
      throw new Error(
        `artifact_coordinate_mismatch: staged path ${stagedPath} is outside the artifact being published`,
      );
    }
  }
}
