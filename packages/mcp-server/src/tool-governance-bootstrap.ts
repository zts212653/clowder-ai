import { createHash } from 'node:crypto';

export const MCP_SURFACE_BASELINE_PATH = 'packages/mcp-server/governance/mcp-surface-baseline.json';
export const MCP_SURFACE_ATTESTATION_PATH = 'packages/mcp-server/governance/mcp-surface-bootstrap-attestation.json';

export type McpSurfaceBootstrapAttestation = {
  schemaVersion: 1;
  featureId: 'F286';
  targetRepository: 'zts212653/cat-cafe';
  targetRef: 'origin/main';
  bootstrapFrom: string;
  cvoAuthorizationRef: 'message:0001785600399637-001062-9b03f289';
  adrAuthorizationRef: 'adr:44';
  expectedAbsentBaselinePath: typeof MCP_SURFACE_BASELINE_PATH;
  owner: 'architecture-cell:mcp-surface-governance';
  attestationSourceDigest: string;
};

export type BootstrapValidationContext = {
  mode: 'attest' | 'write' | 'check';
  resolvedTargetSha: string;
  targetHasBaseline: boolean;
  currentHasBaseline: boolean;
  targetBaselineProtectedBaseSha?: string;
  bootstrapIsTargetAncestor?: boolean;
  requestedTargetOverride?: string;
};

const ATTESTATION_KEYS = [
  'adrAuthorizationRef',
  'attestationSourceDigest',
  'bootstrapFrom',
  'cvoAuthorizationRef',
  'expectedAbsentBaselinePath',
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

function digest(attestation: Omit<McpSurfaceBootstrapAttestation, 'attestationSourceDigest'>): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(stable(attestation)))
    .digest('hex')}`;
}

export function createBootstrapAttestation(bootstrapFrom: string): McpSurfaceBootstrapAttestation {
  if (!/^[a-f0-9]{40}$/.test(bootstrapFrom)) throw new Error('bootstrapFrom must be one exact Git SHA');
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
  return { ...source, attestationSourceDigest: digest(source) };
}

function parseAttestation(value: unknown): McpSurfaceBootstrapAttestation {
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
    if (record[key] !== expected[key]) throw new Error(`Bootstrap attestation ${key} or digest is invalid`);
  }
  return expected;
}

export function validateBootstrapAttestation(
  value: unknown,
  context: BootstrapValidationContext,
): McpSurfaceBootstrapAttestation {
  const attestation = parseAttestation(value);
  if (context.requestedTargetOverride) throw new Error('Bootstrap target overrides are forbidden');
  if (context.mode === 'check' && !context.currentHasBaseline) throw new Error('Current baseline is missing');
  if (context.targetHasBaseline && !context.currentHasBaseline) {
    throw new Error('Current baseline cannot be deleted and recreated after bootstrap');
  }
  if (!context.targetHasBaseline) {
    if (context.resolvedTargetSha !== attestation.bootstrapFrom) {
      throw new Error('Protected target does not match attested bootstrapFrom');
    }
    return attestation;
  }
  if (context.mode === 'attest') throw new Error('Bootstrap is already complete on the protected target');
  if (!context.bootstrapIsTargetAncestor)
    throw new Error('Attested bootstrap is not an ancestor of the protected target');
  if (context.targetBaselineProtectedBaseSha !== attestation.bootstrapFrom) {
    throw new Error('Protected target baseline does not preserve the attested bootstrapFrom');
  }
  return attestation;
}
