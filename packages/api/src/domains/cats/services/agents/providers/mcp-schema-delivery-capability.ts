import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MCP_SCHEMA_DELIVERY_REQUESTED_MODES, type RequestGenerationSchemaDeliveryV1 } from '@cat-cafe/shared';
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const publicDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const MCP_SCHEMA_DELIVERY_DISCOVERY_SURFACES = [
  'provider-tool-search',
  'host-catalog',
  'upfront-schema-set',
  'none',
  'unknown',
] as const;

export function resolveMcpSchemaDeliveryDiscoverySurface(input: {
  readonly provider: string;
  readonly carrier: string;
}): (typeof MCP_SCHEMA_DELIVERY_DISCOVERY_SURFACES)[number] {
  if (input.provider === 'anthropic' && input.carrier === 'print_sdk') return 'provider-tool-search';
  if (input.provider === 'openai' && input.carrier === 'app_server') return 'host-catalog';
  return 'unknown';
}

export const mcpSchemaDeliveryCapabilitySubjectSchema = z
  .object({
    provider: nonEmpty.max(80),
    carrier: nonEmpty.max(80),
    modelFamily: nonEmpty.max(160),
    hostVersion: nonEmpty.max(160),
    configDigest: publicDigest,
    profileId: nonEmpty.max(80),
  })
  .strict();

export const mcpSchemaDeliveryCapabilityAttestationSchema = z
  .object({
    v: z.literal(1),
    subject: mcpSchemaDeliveryCapabilitySubjectSchema,
    deliveryMode: z.enum(MCP_SCHEMA_DELIVERY_REQUESTED_MODES).refine((mode) => mode !== 'unknown'),
    discoverySurface: z.enum(MCP_SCHEMA_DELIVERY_DISCOVERY_SURFACES),
    evidence: z
      .object({
        kind: z.enum(['provider-output', 'host-probe', 'first-person-fixture']),
        ref: nonEmpty.max(320),
      })
      .strict(),
    fixtureRevision: nonEmpty.max(160),
    resultDigest: publicDigest,
    createdAt: z.string().datetime(),
  })
  .strict();

export type McpSchemaDeliveryCapabilitySubject = z.infer<typeof mcpSchemaDeliveryCapabilitySubjectSchema>;
export type McpSchemaDeliveryCapabilityAttestation = z.infer<typeof mcpSchemaDeliveryCapabilityAttestationSchema>;
type CachedAttestation = {
  readonly ref: string;
  readonly attestation: McpSchemaDeliveryCapabilityAttestation;
};

const attestationCache = new Map<string, CachedAttestation | null>();

export interface McpSchemaDeliveryHealthEvent {
  readonly code:
    | 'mcp_schema_delivery_attestation_unavailable'
    | 'mcp_schema_delivery_attestation_invalid'
    | 'mcp_schema_delivery_attestation_subject_mismatch'
    | 'mcp_schema_delivery_host_version_unavailable';
  readonly provider: string;
  readonly carrier: string;
  readonly hostVersion?: string;
  readonly profileId: string;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('mcp_schema_delivery_non_json_number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('mcp_schema_delivery_non_json_value');
}

export function mcpSchemaDeliveryDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function createMcpSchemaDeliveryConfigDigest(config: unknown): `sha256:${string}` {
  return mcpSchemaDeliveryDigest(config);
}

export function createMcpSchemaDeliveryLaunchConfig(input: {
  readonly declaredServerNames: readonly string[];
  readonly profileId: string;
  readonly hostSurface: (typeof MCP_SCHEMA_DELIVERY_DISCOVERY_SURFACES)[number];
}): {
  readonly v: 1;
  readonly declaredServerNames: readonly string[];
  readonly profileId: string;
  readonly hostSurface: (typeof MCP_SCHEMA_DELIVERY_DISCOVERY_SURFACES)[number];
} {
  return Object.freeze({
    v: 1,
    declaredServerNames: Object.freeze([...new Set(input.declaredServerNames)].sort()),
    profileId: input.profileId,
    hostSurface: input.hostSurface,
  });
}

function subjectEquals(left: McpSchemaDeliveryCapabilitySubject, right: McpSchemaDeliveryCapabilitySubject): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function unknownProjection(input: {
  readonly profileClass: RequestGenerationSchemaDeliveryV1['profileClass'];
  readonly subject: McpSchemaDeliveryCapabilitySubject;
  readonly fallbackReason: RequestGenerationSchemaDeliveryV1['fallbackReason'];
}): RequestGenerationSchemaDeliveryV1 {
  return {
    profileClass: input.profileClass,
    profileId: input.subject.profileId,
    requestedMode: 'unknown',
    hostVersion: input.subject.hostVersion,
    fallbackReason: input.fallbackReason ?? 'attestation_unavailable',
  };
}

export function resolveMcpSchemaDeliveryForLaunch(input: {
  readonly profileClass: RequestGenerationSchemaDeliveryV1['profileClass'];
  readonly subject: McpSchemaDeliveryCapabilitySubject;
  readonly attestation?: unknown;
  readonly attestationRef?: string;
  readonly onHealthEvent?: (event: McpSchemaDeliveryHealthEvent) => void;
}): RequestGenerationSchemaDeliveryV1 {
  const subject = mcpSchemaDeliveryCapabilitySubjectSchema.parse(input.subject);
  if (!input.attestation || !input.attestationRef) {
    input.onHealthEvent?.({
      code: 'mcp_schema_delivery_attestation_unavailable',
      provider: subject.provider,
      carrier: subject.carrier,
      hostVersion: subject.hostVersion,
      profileId: subject.profileId,
    });
    return unknownProjection({ profileClass: input.profileClass, subject, fallbackReason: 'attestation_unavailable' });
  }

  const parsed = mcpSchemaDeliveryCapabilityAttestationSchema.safeParse(input.attestation);
  if (!parsed.success) {
    input.onHealthEvent?.({
      code: 'mcp_schema_delivery_attestation_invalid',
      provider: subject.provider,
      carrier: subject.carrier,
      hostVersion: subject.hostVersion,
      profileId: subject.profileId,
    });
    return unknownProjection({ profileClass: input.profileClass, subject, fallbackReason: 'attestation_invalid' });
  }
  if (!subjectEquals(subject, parsed.data.subject)) {
    input.onHealthEvent?.({
      code: 'mcp_schema_delivery_attestation_subject_mismatch',
      provider: subject.provider,
      carrier: subject.carrier,
      hostVersion: subject.hostVersion,
      profileId: subject.profileId,
    });
    return unknownProjection({
      profileClass: input.profileClass,
      subject,
      fallbackReason: 'attestation_subject_mismatch',
    });
  }

  return {
    profileClass: input.profileClass,
    profileId: subject.profileId,
    requestedMode: parsed.data.deliveryMode,
    hostVersion: subject.hostVersion,
    attestation: {
      ref: input.attestationRef,
      digest: mcpSchemaDeliveryDigest(parsed.data),
    },
  };
}

function parseHostVersion(output: string): string | undefined {
  return output.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0];
}

function defaultVersionProbe(command: string): string {
  return execFileSync(command, ['--version'], {
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 16 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function createMemoizedHostVersionProbe(
  probe: (command: string) => string = defaultVersionProbe,
): (command: string) => string | undefined {
  const cache = new Map<string, string | undefined>();
  return (command: string): string | undefined => {
    if (cache.has(command)) return cache.get(command);
    let version: string | undefined;
    try {
      version = parseHostVersion(probe(command));
    } catch {
      version = undefined;
    }
    cache.set(command, version);
    return version;
  };
}

export const getMemoizedMcpHostVersion = createMemoizedHostVersionProbe();

export function resolveMcpSchemaDeliveryForProviderLaunch(input: {
  readonly repoRoot: string;
  readonly command: string;
  readonly provider: string;
  readonly carrier: string;
  readonly modelFamily: string;
  readonly profileClass: RequestGenerationSchemaDeliveryV1['profileClass'];
  readonly profileId: string;
  readonly config: unknown;
  readonly hostVersionProbe?: (command: string) => string | undefined;
  readonly onHealthEvent?: (event: McpSchemaDeliveryHealthEvent) => void;
}): RequestGenerationSchemaDeliveryV1 {
  const hostVersion = (input.hostVersionProbe ?? getMemoizedMcpHostVersion)(input.command);
  if (!hostVersion) {
    input.onHealthEvent?.({
      code: 'mcp_schema_delivery_host_version_unavailable',
      provider: input.provider,
      carrier: input.carrier,
      profileId: input.profileId,
    });
    return {
      profileClass: input.profileClass,
      profileId: input.profileId,
      requestedMode: 'unknown',
      fallbackReason: 'host_version_unavailable',
    };
  }
  const subject = mcpSchemaDeliveryCapabilitySubjectSchema.parse({
    provider: input.provider,
    carrier: input.carrier,
    modelFamily: input.modelFamily,
    hostVersion,
    configDigest: createMcpSchemaDeliveryConfigDigest(input.config),
    profileId: input.profileId,
  });
  let evidence: { readonly ref: string; readonly attestation: McpSchemaDeliveryCapabilityAttestation } | undefined;
  try {
    evidence = loadMcpSchemaDeliveryAttestation(input.repoRoot, subject);
  } catch {
    input.onHealthEvent?.({
      code: 'mcp_schema_delivery_attestation_invalid',
      provider: subject.provider,
      carrier: subject.carrier,
      hostVersion: subject.hostVersion,
      profileId: subject.profileId,
    });
    return unknownProjection({ profileClass: input.profileClass, subject, fallbackReason: 'attestation_invalid' });
  }
  return resolveMcpSchemaDeliveryForLaunch({
    profileClass: input.profileClass,
    subject,
    ...(evidence ? { attestation: evidence.attestation, attestationRef: evidence.ref } : {}),
    onHealthEvent: input.onHealthEvent,
  });
}

function safeFileSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unknown'
  );
}

export function mcpSchemaDeliveryAttestationFileName(subject: McpSchemaDeliveryCapabilitySubject): string {
  const parsed = mcpSchemaDeliveryCapabilitySubjectSchema.parse(subject);
  return [
    parsed.provider,
    parsed.carrier,
    parsed.modelFamily,
    parsed.hostVersion,
    parsed.profileId,
    parsed.configDigest.slice('sha256:'.length, 'sha256:'.length + 12),
  ]
    .map(safeFileSegment)
    .join('--')
    .concat('.json');
}

export function loadMcpSchemaDeliveryAttestation(
  repoRoot: string,
  subject: McpSchemaDeliveryCapabilitySubject,
): CachedAttestation | undefined {
  const ref = `docs/features/evidence/F286/provider-schema-delivery/${mcpSchemaDeliveryAttestationFileName(subject)}`;
  const path = join(repoRoot, ref);
  const cacheKey = resolve(path);
  const cached = attestationCache.get(cacheKey);
  if (cached !== undefined) return cached ?? undefined;
  if (!existsSync(path)) {
    attestationCache.set(cacheKey, null);
    return undefined;
  }
  const loaded = {
    ref,
    attestation: mcpSchemaDeliveryCapabilityAttestationSchema.parse(JSON.parse(readFileSync(path, 'utf8'))),
  };
  attestationCache.set(cacheKey, loaded);
  return loaded;
}

export function persistMcpSchemaDeliveryAttestation(
  path: string,
  value: unknown,
): { readonly digest: string; readonly created: boolean } {
  const attestation = mcpSchemaDeliveryCapabilityAttestationSchema.parse(value);
  const digest = mcpSchemaDeliveryDigest(attestation);
  if (existsSync(path)) {
    const existing = mcpSchemaDeliveryCapabilityAttestationSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    const existingDigest = mcpSchemaDeliveryDigest(existing);
    if (existingDigest !== digest) throw new Error('mcp_schema_delivery_attestation_conflicting_subject');
    return { digest, created: false };
  }
  writeFileSync(path, `${JSON.stringify(attestation, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  attestationCache.delete(resolve(path));
  return { digest, created: true };
}
