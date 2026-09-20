import { type Capability, type PluginManifest } from '@clowder-ai/plugin-contract';
import {
  canonicalCapabilities,
  DEFAULT_PLUGIN_CONTRACT_RUNTIME,
  requestedCapabilitiesForManifest,
} from './contract-policy.js';
import { isCanonicalPackageDigest } from './snapshot.js';
import type { PackageAdmissionCandidate, PluginPackageRecord } from './types.js';
import { PluginInventoryError } from './types.js';

export { PLUGIN_CONTRACT_VERSION } from './contract-policy.js';

export interface VerifiedPackageAdmission {
  readonly package: PluginPackageRecord;
  readonly effectiveGrants: readonly Capability[];
  readonly requestedCapabilities: readonly Capability[];
}

export type PackageManifestValidationResult =
  | { readonly valid: true; readonly manifest: PluginManifest }
  | {
      readonly valid: false;
      readonly errors: readonly { readonly instancePath: string; readonly message: string }[];
    };

export interface PackageAdmissionContractRuntime {
  /** Exact contractVersion allowlist accepted by this Host composition. */
  readonly manifestContractVersions: readonly string[];
  readonly validateManifest: (value: unknown) => PackageManifestValidationResult;
  readonly validateEffectiveGrants: (values: readonly string[]) => boolean;
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
  if (!contract.manifestContractVersions.includes(validation.manifest.contractVersion)) {
    throw new PluginInventoryError(
      'CONTRACT_VERSION_MISMATCH',
      `manifest requires ${validation.manifest.contractVersion}; Host admits ${contract.manifestContractVersions.join(', ')}`,
    );
  }
  if (!contract.validateEffectiveGrants(candidate.effectiveGrants)) {
    throw new PluginInventoryError('INVALID_GRANT', 'effective grants contain an unknown or duplicate capability');
  }
  const requestedCapabilities = requestedCapabilitiesForManifest(validation.manifest);
  if (candidate.effectiveGrants.some((capability) => !requestedCapabilities.includes(capability as Capability))) {
    throw new PluginInventoryError('INVALID_GRANT', 'effective grants must be a subset of manifest requests');
  }
  const effectiveGrants = canonicalCapabilities(candidate.effectiveGrants as readonly Capability[]);
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
      manifest: structuredClone(validation.manifest),
      signalSchemas: structuredClone(signalSchemas),
      ...(candidate.provenance === undefined ? {} : { provenance: structuredClone(candidate.provenance) }),
      packageState: 'installed',
      verifiedAt: now,
      updatedAt: now,
    },
    effectiveGrants,
    requestedCapabilities,
  };
}
