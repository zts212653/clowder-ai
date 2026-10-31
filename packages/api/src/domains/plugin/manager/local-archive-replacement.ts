import { isDeepStrictEqual } from 'node:util';
import {
  type PluginArchiveReplacementConfirmation,
  PluginArchiveReplacementConfirmationSchema,
  type PluginArchiveReplacementOffer,
} from '@cat-cafe/shared';
import type { PluginManifest } from '@clowder-ai/plugin-contract';
import { type PackageAdmissionContractRuntime, verifyPackageAdmission } from '../host-inventory/manifest-verifier.js';
import type { PackageAdmissionCandidate, PluginInventorySnapshot } from '../host-inventory/types.js';

export class PluginArchiveReplacementError extends Error {
  constructor(
    readonly code: 'ARCHIVE_REPLACEMENT_CONFIRMATION_REQUIRED' | 'STALE_ARCHIVE_REPLACEMENT',
    message: string,
    readonly replacement?: PluginArchiveReplacementOffer,
  ) {
    super(message);
    this.name = 'PluginArchiveReplacementError';
  }
}

function stale(): never {
  throw new PluginArchiveReplacementError(
    'STALE_ARCHIVE_REPLACEMENT',
    'The plugin or archive changed. Select the archive again and review a new confirmation.',
  );
}

/** Bind explicit legacy or same-package catalog replacement to the exact installation and archive. */
export function confirmArchiveReplacement(
  sourceKind: string,
  snapshot: PluginInventorySnapshot,
  candidate: PackageAdmissionCandidate & { readonly manifest: PluginManifest },
  confirmation?: PluginArchiveReplacementConfirmation,
  contract?: PackageAdmissionContractRuntime,
): boolean {
  const current = snapshot.instances.find(
    (instance) => instance.pluginId === candidate.packagePluginId && instance.lifecycleState === 'installed',
  );
  const previous = snapshot.packages.find((record) => record.packageDigest === current?.packageDigest);
  const legacy = previous?.provenance === undefined;
  const sameCatalogPackage =
    previous?.provenance?.kind === 'catalog' &&
    candidate.provenance?.kind === 'local-archive' &&
    previous.provenance.packageName === candidate.provenance.packageName;
  if (sourceKind !== 'local-archive' || !current || !previous || (!legacy && !sameCatalogPackage)) {
    if (confirmation !== undefined) stale();
    return false;
  }
  // Read-only preflight uses the same package verifier as the eventual upgrade.
  // Its timestamp is discarded; no inventory record is persisted by this call.
  verifyPackageAdmission(candidate, 0, contract);
  const expected: PluginArchiveReplacementConfirmation = {
    pluginId: current.pluginId,
    pluginInstanceId: current.pluginInstanceId,
    currentPackageDigest: current.packageDigest,
    candidatePackageDigest: candidate.computedPackageDigest,
    expectedLifecycleRevision: current.lifecycleRevision,
  };
  if (confirmation === undefined) {
    throw new PluginArchiveReplacementError(
      'ARCHIVE_REPLACEMENT_CONFIRMATION_REQUIRED',
      'Confirm replacing this installation while retaining its instance, configuration, and data.',
      {
        confirmation: expected,
        displayName: candidate.manifest.name,
        currentVersion: previous.version,
        candidateVersion: candidate.manifest.version,
      },
    );
  }
  const parsed = PluginArchiveReplacementConfirmationSchema.safeParse(confirmation);
  if (!parsed.success) stale();
  if (!isDeepStrictEqual(parsed.data, expected)) stale();
  return true;
}
