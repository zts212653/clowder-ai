import { type Capability, validateEffectiveGrants, validateManifest } from '@clowder-ai/plugin-contract';
import { canonicalCapabilities, PLUGIN_CONTRACT_VERSION, requestedCapabilitiesForManifest } from './contract-policy.js';
import { isCanonicalPackageDigest } from './snapshot.js';
import type { PackageAdmissionCandidate, PluginPackageRecord } from './types.js';
import { PluginInventoryError } from './types.js';

export { PLUGIN_CONTRACT_VERSION } from './contract-policy.js';

export interface VerifiedPackageAdmission {
  readonly package: PluginPackageRecord;
  readonly effectiveGrants: readonly Capability[];
  readonly requestedCapabilities: readonly Capability[];
}

export function verifyPackageAdmission(candidate: PackageAdmissionCandidate, now: number): VerifiedPackageAdmission {
  const validation = validateManifest(candidate.manifest);
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
  if (validation.manifest.contractVersion !== PLUGIN_CONTRACT_VERSION) {
    throw new PluginInventoryError(
      'CONTRACT_VERSION_MISMATCH',
      `manifest requires ${validation.manifest.contractVersion}; Host pins ${PLUGIN_CONTRACT_VERSION}`,
    );
  }
  if (!validateEffectiveGrants(candidate.effectiveGrants)) {
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
      packageState: 'installed',
      verifiedAt: now,
      updatedAt: now,
    },
    effectiveGrants,
    requestedCapabilities,
  };
}
