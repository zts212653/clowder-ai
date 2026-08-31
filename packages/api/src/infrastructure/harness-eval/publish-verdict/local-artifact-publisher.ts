import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mapPublishVerdictError } from './error-mapping.js';
import type { ArtifactPublisher, ArtifactRef, PublishArtifactOpts } from './types.js';

const SAFE_DOMAIN_SLUG_PATTERN = /^eval-[a-z0-9][a-z0-9-]*$/;
const SAFE_ARTIFACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isNodeError(err: unknown, code: string): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === code;
}

export interface LocalArtifactPublisherDeps {
  /** Root directory where verdict artifacts are persisted. */
  artifactRoot: string;
}

function toDomainSlug(domainId: string): string {
  return domainId.replace(/:/g, '-');
}

function toArtifactUrl(domainSlug: string, artifactId: string): string {
  return `artifact://${domainSlug}/${artifactId}`;
}

function assertSafeArtifactCoordinates(domainSlug: string, artifactId: string): void {
  if (!SAFE_DOMAIN_SLUG_PATTERN.test(domainSlug)) {
    throw new Error(`unsafe_domain_slug: '${domainSlug}' must be a single eval domain path segment`);
  }
  if (!SAFE_ARTIFACT_ID_PATTERN.test(artifactId)) {
    throw new Error(`unsafe_artifact_id: '${artifactId}' must be a single safe artifact path segment`);
  }
}

type GeneratedArtifact = Awaited<ReturnType<PublishArtifactOpts['generate']>>;

function duplicateArtifactError(opts: PublishArtifactOpts, finalDir: string): Error {
  return new Error(
    `artifact_already_exists: artifact '${opts.packet.id}' already exists for domain '${opts.packet.domainId}' at ${finalDir}`,
  );
}

function assertGeneratedArtifact(generated: GeneratedArtifact): void {
  if (!existsSync(generated.verdictPath)) {
    throw new Error(`generator did not write verdict.md at expected path: ${generated.verdictPath}`);
  }
  if (!existsSync(generated.bundleDir)) {
    throw new Error(`generator did not write bundle directory at expected path: ${generated.bundleDir}`);
  }
}

async function stageArtifact(
  deps: LocalArtifactPublisherDeps,
  opts: PublishArtifactOpts,
  domainSlug: string,
  finalDir: string,
): Promise<GeneratedArtifact['afterPublish']> {
  const artifactId = opts.packet.id;
  mkdirSync(deps.artifactRoot, { recursive: true });
  const tempDir = mkdtempSync(resolve(deps.artifactRoot, `.staging-${domainSlug}-${artifactId}-`));

  try {
    const harnessFeedbackRoot = resolve(tempDir, 'docs', 'harness-feedback');
    mkdirSync(harnessFeedbackRoot, { recursive: true });
    const generated = await opts.generate(harnessFeedbackRoot);
    assertGeneratedArtifact(generated);

    // Atomic publication: readers either see no artifact or the complete
    // directory. The parent must exist before rename(2).
    mkdirSync(dirname(finalDir), { recursive: true });
    renameSync(tempDir, finalDir);
    return generated.afterPublish;
  } catch (err) {
    rmSync(tempDir, { recursive: true, force: true });
    // Two publishers can pass the initial existsSync check concurrently.
    if (isNodeError(err, 'EEXIST') || isNodeError(err, 'ENOTEMPTY')) {
      throw duplicateArtifactError(opts, finalDir);
    }
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
 * - Artifacts live at `<artifactRoot>/<domainSlug>/<artifactId>/`.
 * - The directory preserves the generator layout under
 *   `docs/harness-feedback/{verdicts,bundles}/` plus replay inputs.
 * - Writes are staged to a temp directory and atomically renamed to the final
 *   path so concurrent publishers and readers never see a partial artifact.
 * - Duplicate artifact IDs are rejected (idempotent — publishing the same id
 *   twice is a client error, not an overwrite).
 * - `afterPublish` runs exactly once after the artifact is durably published.
 * - On failure, the temp directory is removed.
 *
 * The filesystem backend can later be replaced by an object store or database
 * without changing the ArtifactPublisher contract.
 */
export function createLocalArtifactPublisher(deps: LocalArtifactPublisherDeps): ArtifactPublisher {
  return {
    async publishArtifact(opts: PublishArtifactOpts): Promise<ArtifactRef> {
      const domainSlug = toDomainSlug(opts.packet.domainId);
      const artifactId = opts.packet.id;
      // ArtifactPublisher is a trust boundary in its own right. Do not rely on
      // callers having passed through VerdictHandoffPacket or route validation
      // before these values participate in resolve()/mkdtempSync().
      assertSafeArtifactCoordinates(domainSlug, artifactId);
      const finalDir = resolve(deps.artifactRoot, domainSlug, artifactId);

      if (existsSync(finalDir)) {
        throw duplicateArtifactError(opts, finalDir);
      }

      const afterPublish = await stageArtifact(deps, opts, domainSlug, finalDir);
      await completeAfterPublish(afterPublish, finalDir, artifactId);

      return {
        artifactId,
        domainSlug,
        verdictPath: resolve(finalDir, 'docs', 'harness-feedback', 'verdicts', `${artifactId}.md`),
        bundleDir: resolve(finalDir, 'docs', 'harness-feedback', 'bundles', artifactId),
        artifactUrl: toArtifactUrl(domainSlug, artifactId),
      };
    },
  };
}
