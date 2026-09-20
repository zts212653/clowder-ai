import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * F257 artifact store layout — the one definition shared by the publisher that
 * writes verdict artifacts and by every reader that serves them back.
 *
 *   <artifactRoot>/owners/<ownerKey>/<domainSlug>/<artifactId>/docs/harness-feedback/
 *     verdicts/<verdictId>.md
 *     bundles/<verdictId>/…
 *
 * An artifact is a container named after the verdict it was published for. One
 * publication can generate more verdicts than that one — a friction breakout writes
 * a child verdict per finding next to its aggregate — and all of them live in the
 * same container. A verdict is therefore addressed by (artifactId, verdictId); the
 * published verdict is simply the one whose id equals its container's.
 *
 * A verdict is generated from owner-scoped evidence, so the owner is part of the
 * artifact's address, not a filter applied after listing. Two owners publishing
 * the same verdict id therefore hold two independent artifacts, and a reader that
 * was never given an owner has no path to list at all.
 *
 * `ownerKey` is a SHA-256 digest of the server-trusted user id: user ids are not
 * path-safe, and a lowercase hex key cannot collide on a case-insensitive
 * filesystem.
 */

export const SAFE_DOMAIN_SLUG_PATTERN = /^eval-[a-z0-9][a-z0-9-]*$/;
export const SAFE_ARTIFACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ArtifactCoordinates {
  domainSlug: string;
  artifactId: string;
}

/** One verdict inside an artifact container. */
export interface ArtifactVerdictCoordinates extends ArtifactCoordinates {
  verdictId: string;
}

export function toArtifactDomainSlug(domainId: string): string {
  return domainId.replace(/:/g, '-');
}

export function assertSafeArtifactCoordinates({ domainSlug, artifactId }: ArtifactCoordinates): void {
  if (!SAFE_DOMAIN_SLUG_PATTERN.test(domainSlug)) {
    throw new Error(`unsafe_domain_slug: '${domainSlug}' must be a single eval domain path segment`);
  }
  if (!SAFE_ARTIFACT_ID_PATTERN.test(artifactId)) {
    throw new Error(`unsafe_artifact_id: '${artifactId}' must be a single safe artifact path segment`);
  }
}

export function artifactOwnerKey(ownerUserId: string): string {
  if (typeof ownerUserId !== 'string' || ownerUserId.trim() === '') {
    throw new Error('owner_user_required: the artifact store is partitioned by a server-trusted owner');
  }
  return createHash('sha256').update(ownerUserId, 'utf8').digest('hex');
}

/** The owner's partition; publisher staging directories also live here. */
export function artifactOwnerRoot(artifactRoot: string, ownerUserId: string): string {
  return resolve(artifactRoot, 'owners', artifactOwnerKey(ownerUserId));
}

export function artifactDirectory(artifactRoot: string, ownerUserId: string, coordinates: ArtifactCoordinates): string {
  assertSafeArtifactCoordinates(coordinates);
  return resolve(artifactOwnerRoot(artifactRoot, ownerUserId), coordinates.domainSlug, coordinates.artifactId);
}

/** Generator output root inside an artifact directory, or inside its staging twin. */
export function artifactOutputRoot(artifactDir: string): string {
  return resolve(artifactDir, 'docs', 'harness-feedback');
}

export function verdictPathIn(outputRoot: string, verdictId: string): string {
  return resolve(outputRoot, 'verdicts', `${verdictId}.md`);
}

export function bundleDirIn(outputRoot: string, verdictId: string): string {
  return resolve(outputRoot, 'bundles', verdictId);
}

export function toArtifactUrl({ domainSlug, artifactId }: ArtifactCoordinates): string {
  return `artifact://${domainSlug}/${artifactId}`;
}

/** True when `child` is strictly below `parent`. Both must already be real (symlink-free) paths. */
export function isStrictlyInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * The closed set of artifact files a client may open. Clients name a file by key;
 * they never send a path, so there is no traversal surface to validate.
 */
export const ARTIFACT_FILE_KEYS = ['verdict', 'snapshot', 'attribution', 'friction-report'] as const;
export type ArtifactFileKey = (typeof ARTIFACT_FILE_KEYS)[number];
export type ArtifactFileContentType = 'text/markdown' | 'application/json';

export function isArtifactFileKey(value: unknown): value is ArtifactFileKey {
  return typeof value === 'string' && (ARTIFACT_FILE_KEYS as readonly string[]).includes(value);
}

export function artifactFileLocation(
  outputRoot: string,
  verdictId: string,
  fileKey: ArtifactFileKey,
): { path: string; contentType: ArtifactFileContentType } {
  const bundleDir = bundleDirIn(outputRoot, verdictId);
  switch (fileKey) {
    case 'verdict':
      return { path: verdictPathIn(outputRoot, verdictId), contentType: 'text/markdown' };
    case 'snapshot':
      return { path: resolve(bundleDir, 'snapshot.json'), contentType: 'application/json' };
    case 'attribution':
      return { path: resolve(bundleDir, 'attribution.json'), contentType: 'application/json' };
    case 'friction-report':
      return { path: resolve(bundleDir, 'raw', 'rollup-report.json'), contentType: 'application/json' };
  }
}
