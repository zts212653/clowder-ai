import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  type ArtifactCoordinates,
  artifactDirectory,
  artifactOutputRoot,
  artifactOwnerRoot,
  bundleDirIn,
  toArtifactDomainSlug,
  toArtifactUrl,
  verdictPathIn,
} from '../artifact-store/artifact-store-layout.js';
import {
  assertGeneratedArtifactCoordinates,
  assertStagedPathsInside,
  assertVerdictsMaterialized,
  generatedVerdictIds,
} from '../artifact-store/generated-artifact-coordinates.js';
import { reserveVerdictIds } from '../artifact-store/verdict-id-reservations.js';
import { mapPublishVerdictError } from './error-mapping.js';
import type { ArtifactPublisher, ArtifactRef, PublishArtifactOpts } from './types.js';

function isNodeError(err: unknown, code: string): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === code;
}

export interface LocalArtifactPublisherDeps {
  /** Root directory where verdict artifacts are persisted. */
  artifactRoot: string;
}

type GeneratedArtifact = Awaited<ReturnType<PublishArtifactOpts['generate']>>;

interface ArtifactTarget {
  coordinates: ArtifactCoordinates;
  ownerRoot: string;
  finalDir: string;
}

function duplicateArtifactError(opts: PublishArtifactOpts, finalDir: string): Error {
  return new Error(
    `artifact_already_exists: artifact '${opts.packet.id}' already exists for domain '${opts.packet.domainId}' at ${finalDir}`,
  );
}

async function stageArtifact(
  target: ArtifactTarget,
  opts: PublishArtifactOpts,
): Promise<{ generated: GeneratedArtifact; verdictIds: string[] }> {
  const { coordinates, ownerRoot, finalDir } = target;
  mkdirSync(ownerRoot, { recursive: true });
  const stagingDir = mkdtempSync(resolve(ownerRoot, `.staging-${coordinates.domainSlug}-${coordinates.artifactId}-`));

  try {
    const outputRoot = artifactOutputRoot(stagingDir);
    mkdirSync(outputRoot, { recursive: true });
    const generated = await opts.generate(outputRoot);
    // The generator's return value is a claim about what it wrote; confirm it
    // names the canonical coordinates and that those files are in this tree.
    assertGeneratedArtifactCoordinates(outputRoot, coordinates.artifactId, generated);
    const verdictIds = generatedVerdictIds(coordinates.artifactId, generated);
    assertVerdictsMaterialized(outputRoot, verdictIds);
    assertStagedPathsInside(stagingDir, generated.extraStagedPaths);
    // Every verdict id the container holds is reserved before the container is visible.
    reserveVerdictIds(ownerRoot, coordinates, verdictIds);

    // Atomic publication: readers either see no artifact or the complete
    // directory. The parent must exist before rename(2).
    mkdirSync(dirname(finalDir), { recursive: true });
    renameSync(stagingDir, finalDir);
    return { generated, verdictIds };
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true });
    // Two publishers can pass the initial existsSync check concurrently.
    if (isNodeError(err, 'EEXIST') || isNodeError(err, 'ENOTEMPTY')) {
      throw duplicateArtifactError(opts, finalDir);
    }
    throw err;
  }
}

function confirmPublished(finalDir: string, verdictIds: readonly string[]): void {
  try {
    assertVerdictsMaterialized(artifactOutputRoot(finalDir), verdictIds);
  } catch (err) {
    // The rename succeeded, so this directory is ours to withdraw.
    rmSync(finalDir, { recursive: true, force: true });
    throw err;
  }
}

async function completeAfterPublish(
  afterPublish: GeneratedArtifact['afterPublish'],
  finalDir: string,
  artifactId: string,
): Promise<void> {
  if (!afterPublish) return;

  try {
    await afterPublish();
  } catch (afterErr) {
    // The side effect is part of the publication unit of work. Roll the
    // exposed artifact back so the Hub cannot surface inconsistent state.
    rmSync(finalDir, { recursive: true, force: true });
    const message = afterErr instanceof Error ? afterErr.message : String(afterErr);
    // Preserve typed domain errors so the handler maps them to the intended
    // 4xx response instead of a generic publisher failure.
    if (mapPublishVerdictError(message)) throw afterErr;
    throw new Error(`artifact_publish_rollback: afterPublish failed for ${artifactId}: ${message}`);
  }
}

/**
 * F257 / F192 sunset: durable artifact publisher that stores verdict bundles on
 * the local filesystem (under `CAT_CAFE_DATA_DIR` or a configured root), NOT in
 * the product Git repository.
 *
 * Contract:
 * - Artifacts live at `<artifactRoot>/owners/<ownerKey>/<domainSlug>/<artifactId>/`
 *   (see `artifact-store-layout.ts`); the owner is part of the address.
 * - The directory preserves the generator layout under
 *   `docs/harness-feedback/{verdicts,bundles}/` plus replay inputs.
 * - Writes are staged to a temp directory inside the owner partition and
 *   atomically renamed to the final path, so concurrent publishers and readers
 *   never see a partial artifact.
 * - Success is confirmed only for files that exist at their canonical coordinates,
 *   before the rename and again after it.
 * - Duplicate artifact IDs within one owner are rejected (publishing the same id
 *   twice is a client error, not an overwrite).
 * - A verdict id names one verdict in the owner's store: every id a publication
 *   holds, children included, is reserved before its container becomes visible, and
 *   an id another artifact holds is rejected (`verdict-id-reservations.ts`).
 * - `afterPublish` runs exactly once after the artifact is durably published.
 * - On failure, the staging directory is removed.
 *
 * The filesystem backend can later be replaced by an object store or database
 * without changing the ArtifactPublisher contract.
 */
export function createLocalArtifactPublisher(deps: LocalArtifactPublisherDeps): ArtifactPublisher {
  return {
    async publishArtifact(opts: PublishArtifactOpts): Promise<ArtifactRef> {
      const coordinates = { domainSlug: toArtifactDomainSlug(opts.packet.domainId), artifactId: opts.packet.id };
      // ArtifactPublisher is a trust boundary in its own right. Do not rely on
      // callers having passed through VerdictHandoffPacket or route validation
      // before these values participate in resolve()/mkdtempSync().
      const finalDir = artifactDirectory(deps.artifactRoot, opts.ownerUserId, coordinates);
      const target = { coordinates, ownerRoot: artifactOwnerRoot(deps.artifactRoot, opts.ownerUserId), finalDir };

      if (existsSync(finalDir)) {
        throw duplicateArtifactError(opts, finalDir);
      }

      const { generated, verdictIds } = await stageArtifact(target, opts);
      confirmPublished(finalDir, verdictIds);
      await completeAfterPublish(generated.afterPublish, finalDir, coordinates.artifactId);

      const outputRoot = artifactOutputRoot(finalDir);
      return {
        artifactId: coordinates.artifactId,
        domainSlug: coordinates.domainSlug,
        verdictPath: verdictPathIn(outputRoot, coordinates.artifactId),
        bundleDir: bundleDirIn(outputRoot, coordinates.artifactId),
        artifactUrl: toArtifactUrl(coordinates),
      };
    },
  };
}
