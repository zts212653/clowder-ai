import { createHash } from 'node:crypto';

export const MCP_SURFACE_BASELINE_PATH = 'packages/mcp-server/governance/mcp-surface-baseline.json';
export const MCP_SURFACE_ATTESTATION_PATH = 'packages/mcp-server/governance/mcp-surface-bootstrap-attestation.json';

export type McpSurfaceExportedBootstrapTarget = {
  targetRepository: 'zts212653/clowder-ai';
  targetRef: 'origin/main';
  bootstrapCommit: '5115761a67dd30a6a7af57a9bb4c07c4f5dd5762';
  bootstrapParent: '69efbd889d30aad8074922c88b159b674e69e614';
  sourceSnapshot: 'f0186f814dacf37885419a54ebe44466439df09c';
  projectionCommit: 'acbe72825628f268560d5d6059d608a7983a78e2';
  projectionParent: 'dc582b899ebdcb6f7bb3c6abf2eb81090f8c1c3d';
  projectionSourceSnapshot: '7e813d323070433ed9b48bfc2b48bebb45151b0d';
  legacyBaselineDigest: 'sha256:a2398c0f860006f33b7418db2e539ef1513d4f8692a3c07d7ea0a309bad5ab7f';
  projectedBaselineDigest: 'sha256:b286a3d6420a560b5aa776faae123ecafa62961cef80face57535f7e5cf03dbd';
  provenanceManifestVersion: 3;
};

export type McpSurfaceBootstrapAttestation = {
  schemaVersion: 2;
  featureId: 'F286';
  targetRepository: 'zts212653/cat-cafe';
  targetRef: 'origin/main';
  bootstrapFrom: string;
  exportedTargets: readonly [McpSurfaceExportedBootstrapTarget];
  cvoAuthorizationRef: 'message:0001785600399637-001062-9b03f289';
  adrAuthorizationRef: 'adr:44';
  expectedAbsentBaselinePath: typeof MCP_SURFACE_BASELINE_PATH;
  owner: 'architecture-cell:mcp-surface-governance';
  attestationSourceDigest: string;
};

export type ExportedBootstrapWitness = {
  bootstrapCommit: string;
  parentShas: readonly string[];
  provenance: unknown;
  legacyAttestation: unknown;
  baselineProtectedBaseSha?: string;
  projectionCommit: string;
  projectionParentShas: readonly string[];
  projectionProvenance: unknown;
};

export type BootstrapTargetProof =
  | {
      kind: 'source';
      bootstrapIsTargetAncestor: boolean;
      exportedSourceSnapshotsAreTargetAncestors: boolean;
    }
  | {
      kind: 'exported';
      target: McpSurfaceExportedBootstrapTarget;
      bootstrapIsTargetAncestor: boolean;
      projectionIsTargetAncestor: boolean;
      witness: ExportedBootstrapWitness;
    }
  | { kind: 'unresolved' };

export type BootstrapValidationContext = {
  mode: 'attest' | 'write' | 'check';
  resolvedTargetSha: string;
  targetHasBaseline: boolean;
  currentHasBaseline: boolean;
  targetBaselineProtectedBaseSha?: string;
  targetProof?: BootstrapTargetProof;
  requestedTargetOverride?: string;
};

export const MCP_SURFACE_EXPORTED_BOOTSTRAP_TARGETS = [
  {
    targetRepository: 'zts212653/clowder-ai',
    targetRef: 'origin/main',
    bootstrapCommit: '5115761a67dd30a6a7af57a9bb4c07c4f5dd5762',
    bootstrapParent: '69efbd889d30aad8074922c88b159b674e69e614',
    sourceSnapshot: 'f0186f814dacf37885419a54ebe44466439df09c',
    projectionCommit: 'acbe72825628f268560d5d6059d608a7983a78e2',
    projectionParent: 'dc582b899ebdcb6f7bb3c6abf2eb81090f8c1c3d',
    projectionSourceSnapshot: '7e813d323070433ed9b48bfc2b48bebb45151b0d',
    legacyBaselineDigest: 'sha256:a2398c0f860006f33b7418db2e539ef1513d4f8692a3c07d7ea0a309bad5ab7f',
    projectedBaselineDigest: 'sha256:b286a3d6420a560b5aa776faae123ecafa62961cef80face57535f7e5cf03dbd',
    provenanceManifestVersion: 3,
  },
] as const satisfies readonly [McpSurfaceExportedBootstrapTarget];

export function resolveGovernanceTarget(gateBaseSha: string | undefined): {
  fetchLatest: boolean;
  ref: string;
} {
  if (gateBaseSha === undefined || gateBaseSha.trim() === '') {
    return { fetchLatest: true, ref: 'origin/main' };
  }
  const exactSha = gateBaseSha.trim();
  if (!/^[a-f0-9]{40}$/.test(exactSha)) {
    throw new Error('CAT_CAFE_GATE_BASE_SHA must be one exact Git SHA');
  }
  return { fetchLatest: false, ref: exactSha };
}

const ATTESTATION_KEYS = [
  'adrAuthorizationRef',
  'attestationSourceDigest',
  'bootstrapFrom',
  'cvoAuthorizationRef',
  'expectedAbsentBaselinePath',
  'exportedTargets',
  'featureId',
  'owner',
  'schemaVersion',
  'targetRef',
  'targetRepository',
] as const;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item)]),
  );
}

export function digestGovernanceValue(attestation: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(stable(attestation)))
    .digest('hex')}`;
}

export function createBootstrapAttestation(bootstrapFrom: string): McpSurfaceBootstrapAttestation {
  if (!/^[a-f0-9]{40}$/.test(bootstrapFrom)) throw new Error('bootstrapFrom must be one exact Git SHA');
  const source = {
    schemaVersion: 2,
    featureId: 'F286',
    targetRepository: 'zts212653/cat-cafe',
    targetRef: 'origin/main',
    bootstrapFrom,
    exportedTargets: MCP_SURFACE_EXPORTED_BOOTSTRAP_TARGETS,
    cvoAuthorizationRef: 'message:0001785600399637-001062-9b03f289',
    adrAuthorizationRef: 'adr:44',
    expectedAbsentBaselinePath: MCP_SURFACE_BASELINE_PATH,
    owner: 'architecture-cell:mcp-surface-governance',
  } as const;
  return { ...source, attestationSourceDigest: digestGovernanceValue(source) };
}

export function parseBootstrapAttestation(value: unknown): McpSurfaceBootstrapAttestation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Bootstrap attestation must be one object');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify(ATTESTATION_KEYS)) {
    throw new Error('Bootstrap attestation must use the closed fields contract');
  }
  const expected = createBootstrapAttestation(String(record.bootstrapFrom));
  for (const key of ATTESTATION_KEYS) {
    if (JSON.stringify(stable(record[key])) !== JSON.stringify(stable(expected[key]))) {
      throw new Error(`Bootstrap attestation ${key} or digest is invalid`);
    }
  }
  return expected;
}

function createLegacyBootstrapAttestation(bootstrapFrom: string): Record<string, unknown> {
  const source = {
    schemaVersion: 1,
    featureId: 'F286',
    targetRepository: 'zts212653/cat-cafe',
    targetRef: 'origin/main',
    bootstrapFrom,
    cvoAuthorizationRef: 'message:0001785600399637-001062-9b03f289',
    adrAuthorizationRef: 'adr:44',
    expectedAbsentBaselinePath: MCP_SURFACE_BASELINE_PATH,
    owner: 'architecture-cell:mcp-surface-governance',
  } as const;
  return { ...source, attestationSourceDigest: digestGovernanceValue(source) };
}

function readRecord(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${subject} must be one object`);
  }
  return value as Record<string, unknown>;
}

export function validateExportedBootstrapWitness(
  attestation: McpSurfaceBootstrapAttestation,
  target: McpSurfaceExportedBootstrapTarget,
  witness: ExportedBootstrapWitness,
): void {
  if (witness.bootstrapCommit !== target.bootstrapCommit) {
    throw new Error('Exported bootstrap witness commit does not match the attested target');
  }
  if (JSON.stringify(witness.parentShas) !== JSON.stringify([target.bootstrapParent])) {
    throw new Error('Exported bootstrap witness parent does not match the attested target');
  }
  const provenance = readRecord(witness.provenance, 'Exported bootstrap provenance');
  if (
    provenance.source_commit_sha !== target.sourceSnapshot ||
    provenance.target_head_sha !== target.bootstrapParent ||
    provenance.manifest_version !== target.provenanceManifestVersion
  ) {
    throw new Error('Exported bootstrap provenance does not match the attested source mapping');
  }
  if (
    JSON.stringify(stable(witness.legacyAttestation)) !==
    JSON.stringify(stable(createLegacyBootstrapAttestation(attestation.bootstrapFrom)))
  ) {
    throw new Error('Exported bootstrap introduction does not preserve the source attestation');
  }
  if (witness.baselineProtectedBaseSha !== attestation.bootstrapFrom) {
    throw new Error('Exported bootstrap introduction does not preserve the source protected base');
  }
  if (witness.projectionCommit !== target.projectionCommit) {
    throw new Error('Exported bootstrap projection commit does not match the attested target');
  }
  if (JSON.stringify(witness.projectionParentShas) !== JSON.stringify([target.projectionParent])) {
    throw new Error('Exported bootstrap projection parent does not match the attested target');
  }
  const projectionProvenance = readRecord(witness.projectionProvenance, 'Exported bootstrap projection provenance');
  if (
    projectionProvenance.source_commit_sha !== target.projectionSourceSnapshot ||
    projectionProvenance.target_head_sha !== target.projectionParent ||
    projectionProvenance.manifest_version !== target.provenanceManifestVersion
  ) {
    throw new Error('Exported bootstrap projection provenance does not match the attested source mapping');
  }
}

export function useAttestedExportedBaselineProjection(
  target: McpSurfaceExportedBootstrapTarget,
  targetBaselineDigest: string,
  currentBaselineDigest: string,
): boolean {
  if (targetBaselineDigest !== target.legacyBaselineDigest) return false;
  if (currentBaselineDigest !== target.projectedBaselineDigest) {
    throw new Error('Initial exported MCP baseline does not match the source-attested public projection');
  }
  return true;
}

function validateBaselinePresence(context: BootstrapValidationContext): void {
  if (context.mode === 'check' && !context.currentHasBaseline) throw new Error('Current baseline is missing');
  if (context.targetHasBaseline && !context.currentHasBaseline) {
    throw new Error('Current baseline cannot be deleted and recreated after bootstrap');
  }
}

function validateEstablishedTarget(
  attestation: McpSurfaceBootstrapAttestation,
  context: BootstrapValidationContext,
): void {
  if (context.mode === 'attest') throw new Error('Bootstrap is already complete on the protected target');
  const proof = context.targetProof;
  if (!proof || proof.kind === 'unresolved') {
    throw new Error('Attested bootstrap has no valid source or exported target lineage');
  }
  if (!proof.bootstrapIsTargetAncestor) {
    throw new Error('Attested bootstrap is not an ancestor of the protected target');
  }
  if (proof.kind === 'source') {
    if (!proof.exportedSourceSnapshotsAreTargetAncestors) {
      throw new Error('Exported bootstrap source snapshot is not in the protected source history');
    }
  } else {
    if (!proof.projectionIsTargetAncestor) {
      throw new Error('Attested exported baseline projection is not an ancestor of the protected target');
    }
    const expectedTarget = attestation.exportedTargets.find(
      (target) => target.bootstrapCommit === proof.target.bootstrapCommit,
    );
    if (!expectedTarget || JSON.stringify(stable(expectedTarget)) !== JSON.stringify(stable(proof.target))) {
      throw new Error('Exported bootstrap target is not covered by the source attestation');
    }
    validateExportedBootstrapWitness(attestation, expectedTarget, proof.witness);
  }
  if (context.targetBaselineProtectedBaseSha !== attestation.bootstrapFrom) {
    throw new Error('Protected target baseline does not preserve the attested bootstrapFrom');
  }
}

export function validateBootstrapAttestation(
  value: unknown,
  context: BootstrapValidationContext,
): McpSurfaceBootstrapAttestation {
  const attestation = parseBootstrapAttestation(value);
  if (context.requestedTargetOverride) throw new Error('Bootstrap target overrides are forbidden');
  validateBaselinePresence(context);
  if (!context.targetHasBaseline) {
    if (context.resolvedTargetSha !== attestation.bootstrapFrom) {
      throw new Error('Protected target does not match attested bootstrapFrom');
    }
    return attestation;
  }
  validateEstablishedTarget(attestation, context);
  return attestation;
}
