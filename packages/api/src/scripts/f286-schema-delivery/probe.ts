import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createMcpSchemaDeliveryConfigDigest,
  getMemoizedMcpHostVersion,
  mcpSchemaDeliveryAttestationFileName,
  mcpSchemaDeliveryCapabilityAttestationSchema,
  persistMcpSchemaDeliveryAttestation,
} from '../../domains/cats/services/agents/providers/mcp-schema-delivery-capability.js';
import { findMonorepoRoot } from '../../utils/monorepo-root.js';

type Args = Record<string, string>;

const REQUIRED = [
  'provider',
  'carrier',
  'model-family',
  'profile-id',
  'delivery-mode',
  'discovery-surface',
  'config-json',
  'evidence-kind',
  'evidence-ref',
  'fixture-revision',
  'result-digest',
] as const;

function parseArgs(argv: readonly string[]): Args {
  const parsed: Args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`f286_probe_invalid_argument:${flag ?? 'missing'}`);
    }
    parsed[flag.slice(2)] = value;
  }
  for (const key of REQUIRED) {
    if (!parsed[key]) throw new Error(`f286_probe_missing_argument:${key}`);
  }
  if (!parsed['host-version'] && !parsed['host-command']) {
    throw new Error('f286_probe_missing_argument:host-version_or_host-command');
  }
  return parsed;
}

function assertEvidenceOutputPath(repoRoot: string, requested: string, expectedFileName: string): string {
  const evidenceRoot = resolve(repoRoot, 'docs/features/evidence/F286/provider-schema-delivery');
  const output = isAbsolute(requested) ? resolve(requested) : resolve(repoRoot, requested);
  const relativePath = relative(evidenceRoot, output);
  if (relativePath.startsWith('..') || isAbsolute(relativePath) || relativePath !== expectedFileName) {
    throw new Error(`f286_probe_evidence_output_must_equal:${resolve(evidenceRoot, expectedFileName)}`);
  }
  return output;
}

export function runF286McpSchemaDeliveryProbe(argv: readonly string[]): {
  readonly attestation: unknown;
  readonly digest?: string;
  readonly output?: string;
} {
  const args = parseArgs(argv);
  const hostVersion = args['host-version'] ?? getMemoizedMcpHostVersion(args['host-command']);
  if (!hostVersion) throw new Error('f286_probe_host_version_unavailable');
  let config: unknown;
  try {
    config = JSON.parse(args['config-json']);
  } catch {
    throw new Error('f286_probe_config_json_invalid');
  }
  const attestation = mcpSchemaDeliveryCapabilityAttestationSchema.parse({
    v: 1,
    subject: {
      provider: args.provider,
      carrier: args.carrier,
      modelFamily: args['model-family'],
      hostVersion,
      configDigest: createMcpSchemaDeliveryConfigDigest(config),
      profileId: args['profile-id'],
    },
    deliveryMode: args['delivery-mode'],
    discoverySurface: args['discovery-surface'],
    evidence: {
      kind: args['evidence-kind'],
      ref: args['evidence-ref'],
    },
    fixtureRevision: args['fixture-revision'],
    resultDigest: args['result-digest'],
    createdAt: args['created-at'] ?? new Date().toISOString(),
  });

  if (!args['evidence-output']) return { attestation };
  const repoRoot = findMonorepoRoot(process.cwd());
  const output = assertEvidenceOutputPath(
    repoRoot,
    args['evidence-output'],
    mcpSchemaDeliveryAttestationFileName(attestation.subject),
  );
  mkdirSync(dirname(output), { recursive: true });
  const persisted = persistMcpSchemaDeliveryAttestation(output, attestation);
  return { attestation, digest: persisted.digest, output };
}

function main(): void {
  const result = runF286McpSchemaDeliveryProbe(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
