import { type PluginManifest } from '@clowder-ai/plugin-contract';
import { DEFAULT_PLUGIN_CONTRACT_RUNTIME, isManifestContractSupported } from './contract-policy.js';
import { isCanonicalPackageDigest } from './snapshot.js';
import type { PackageAdmissionCandidate, PluginPackageRecord } from './types.js';
import { PluginInventoryError } from './types.js';

export { PLUGIN_CONTRACT_VERSION } from './contract-policy.js';

export interface VerifiedPackageAdmission {
  readonly package: PluginPackageRecord & { readonly manifest: PluginManifest };
}

export type PackageManifestValidationResult =
  | { readonly valid: true; readonly manifest: PluginManifest }
  | {
      readonly valid: false;
      readonly errors: readonly { readonly instancePath: string; readonly message: string }[];
    };

export interface PackageAdmissionContractRuntime {
  /** Protocol compatibility range, independent of a plugin's installed SDK package. */
  readonly manifestContractRange: string;
  readonly validateManifest: (value: unknown) => PackageManifestValidationResult;
}

export function verifyPackageAdmission(
  candidate: PackageAdmissionCandidate,
  now: number,
  contract: PackageAdmissionContractRuntime = DEFAULT_PLUGIN_CONTRACT_RUNTIME,
): VerifiedPackageAdmission {
  const validation = contract.validateManifest(candidate.manifest);
  if (!validation.valid) {
    const details = validation.errors.map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ');
    throw new PluginInventoryError('INVALID_MANIFEST', `contract manifest validation failed: ${details}`);
  }
  if (
    !isCanonicalPackageDigest(candidate.computedPackageDigest) ||
    !isCanonicalPackageDigest(candidate.expectedPackageDigest)
  ) {
    throw new PluginInventoryError('INVALID_PACKAGE_DIGEST', 'package digests must be canonical sha512 SRI values');
  }
  if (candidate.computedPackageDigest !== candidate.expectedPackageDigest) {
    throw new PluginInventoryError('PACKAGE_DIGEST_MISMATCH', 'staged package digest does not match expected digest');
  }
  if (validation.manifest.pluginId !== candidate.packagePluginId) {
    throw new PluginInventoryError('PACKAGE_ID_MISMATCH', 'package identity does not match manifest pluginId');
  }
  if (!isManifestContractSupported(validation.manifest.contractVersion, contract.manifestContractRange)) {
    throw new PluginInventoryError(
      'CONTRACT_VERSION_MISMATCH',
      `manifest requires ${validation.manifest.contractVersion}; Host supports ${contract.manifestContractRange}`,
    );
  }
  const signalSchemas = candidate.signalSchemas ?? {};
  for (const declaration of validation.manifest.signals?.provides ?? []) {
    if (!Object.hasOwn(signalSchemas, declaration.schemaRef)) {
      throw new PluginInventoryError(
        'INVALID_MANIFEST',
        `declared signal schema is missing from admitted package: ${declaration.schemaRef}`,
      );
    }
  }
  return {
    package: {
      packageDigest: candidate.computedPackageDigest,
      pluginId: validation.manifest.pluginId,
      version: validation.manifest.version,
      contractVersion: validation.manifest.contractVersion,
      // The validated original declaration is also the input of the package's own SDK.
      manifest: structuredClone(candidate.manifest) as PluginManifest,
      signalSchemas: structuredClone(signalSchemas),
      ...(candidate.provenance === undefined ? {} : { provenance: structuredClone(candidate.provenance) }),
      packageState: 'installed',
      verifiedAt: now,
      updatedAt: now,
    },
  };
}
