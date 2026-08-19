import { createHash } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  EvidenceRef,
  McpStandaloneReason,
  NonEmptyReadonlyArray,
  ResolvedAdmissionClaim,
  ResolvedEvidenceCatalog,
} from './tool-governance-types.js';

type Frontmatter = Record<string, unknown>;
type AcceptedBoundaryKind = Extract<McpStandaloneReason, { disposition: 'accepted-boundary' }>['kind'];

export type EvidenceResolutionInput = {
  repoRoot: string;
  refs: readonly EvidenceRef[];
  admissionSourcePaths?: readonly string[];
};

const BOUNDARY_KINDS = new Set<AcceptedBoundaryKind>([
  'resource-entry',
  'authority-boundary',
  'destructive-boundary',
  'side-effect-boundary',
  'progressive-disclosure',
  'mode-matrix-boundary',
  'provider-transport-boundary',
]);

export const FIXED_ADMISSION_SOURCE_ROOTS = ['docs/decisions', 'docs/features', 'docs/architecture'] as const;

function repoPath(repoRoot: string, relativePath: string): string {
  const root = resolve(repoRoot);
  const path = resolve(root, relativePath);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new Error(`Evidence path escapes repository: ${relativePath}`);
  }
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function frontmatter(content: string, sourcePath: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) throw new Error(`${sourcePath} is missing YAML frontmatter`);
  const parsed: unknown = parseYaml(match[1]);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${sourcePath} has malformed YAML frontmatter`);
  }
  return parsed as Frontmatter;
}

export async function discoverAdmissionSourcePaths(repoRoot: string): Promise<readonly string[]> {
  const paths: string[] = [];
  for (const root of FIXED_ADMISSION_SOURCE_ROOTS) {
    const directory = repoPath(repoRoot, root);
    if (!(await exists(directory))) continue;
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const path = resolve(entry.parentPath, entry.name);
      const content = await readFile(path, 'utf8');
      const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
      if (header && /^mcp_admission_claims:/m.test(header)) {
        paths.push(relative(resolve(repoRoot), path));
      }
    }
  }
  return paths.sort();
}

function normalizedAdr(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? String(parsed) : null;
}

async function findAcceptedAdr(repoRoot: string, number: string): Promise<boolean> {
  const directory = repoPath(repoRoot, 'docs/decisions');
  if (!(await exists(directory))) return false;
  const prefix = `${number.padStart(3, '0')}-`;
  const candidates = (await readdir(directory)).filter((name) => name.startsWith(prefix) && name.endsWith('.md'));
  for (const name of candidates) {
    const relativePath = `docs/decisions/${name}`;
    const content = await readFile(repoPath(repoRoot, relativePath), 'utf8');
    const metadata = frontmatter(content, relativePath);
    if (normalizedAdr(metadata.adr) === number && metadata.status === 'accepted') return true;
  }
  return false;
}

async function resolveRef(repoRoot: string, ref: EvidenceRef): Promise<boolean> {
  const [kind, rawValue] = ref.split(':', 2);
  if (!rawValue) return false;
  switch (kind) {
    case 'file':
    case 'test':
      return exists(repoPath(repoRoot, rawValue));
    case 'architecture-cell': {
      const relativePath = `docs/architecture/ownership/cells/${rawValue}.md`;
      const path = repoPath(repoRoot, relativePath);
      if (!(await exists(path))) return false;
      const metadata = frontmatter(await readFile(path, 'utf8'), relativePath);
      return metadata.cell_id === rawValue;
    }
    case 'adr':
      return findAcceptedAdr(repoRoot, normalizedAdr(rawValue) ?? rawValue);
    case 'message': {
      const relativePath = `docs/provenance/messages/${rawValue}.md`;
      const path = repoPath(repoRoot, relativePath);
      if (!(await exists(path))) return false;
      const metadata = frontmatter(await readFile(path, 'utf8'), relativePath);
      return metadata.source_message_id === rawValue;
    }
    default:
      return false;
  }
}

function sourceRef(metadata: Frontmatter, sourcePath: string): EvidenceRef {
  if (metadata.doc_kind === 'decision') {
    const adr = normalizedAdr(metadata.adr);
    if (!adr) throw new Error(`${sourcePath} decision is missing adr`);
    if (metadata.status !== 'accepted') throw new Error(`${sourcePath} is not accepted`);
    return `adr:${Number.parseInt(adr, 10)}` as EvidenceRef;
  }
  if (metadata.mcp_admission_status !== 'accepted') {
    throw new Error(`${sourcePath} is not accepted for MCP admission`);
  }
  if (typeof metadata.mcp_admission_ref !== 'string') {
    throw new Error(`${sourcePath} is missing mcp_admission_ref`);
  }
  return metadata.mcp_admission_ref as EvidenceRef;
}

function requiredString(value: unknown, field: string, sourcePath: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${sourcePath} admission claim has invalid ${field}`);
  }
  return value;
}

function parseClaims(content: string, sourcePath: string): readonly ResolvedAdmissionClaim[] {
  const metadata = frontmatter(content, sourcePath);
  const rawClaims = metadata.mcp_admission_claims;
  if (rawClaims === undefined) return [];
  if (!Array.isArray(rawClaims) || rawClaims.length === 0) {
    throw new Error(`${sourcePath} mcp_admission_claims must be a non-empty array`);
  }
  const expectedRef = sourceRef(metadata, sourcePath);
  const sourceDigest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  return rawClaims.map((rawClaim, index) => {
    if (typeof rawClaim !== 'object' || rawClaim === null || Array.isArray(rawClaim)) {
      throw new Error(`${sourcePath} admission claim ${index} must be an object`);
    }
    const claim = rawClaim as Record<string, unknown>;
    const ref = requiredString(claim.ref, 'ref', sourcePath) as EvidenceRef;
    if (ref !== expectedRef) {
      throw new Error(`${sourcePath} admission claim ref ${ref} must match its source ${expectedRef}`);
    }
    const boundaryKind = requiredString(claim.boundaryKind, 'boundaryKind', sourcePath);
    if (!BOUNDARY_KINDS.has(boundaryKind as AcceptedBoundaryKind)) {
      throw new Error(`${sourcePath} admission claim has invalid boundaryKind ${boundaryKind}`);
    }
    if (claim.decision !== 'accepted') {
      throw new Error(`${sourcePath} admission claim decision must be accepted`);
    }
    return {
      ref,
      subject: {
        toolName: requiredString(claim.toolName, 'toolName', sourcePath),
        resourceFamily: requiredString(claim.resourceFamily, 'resourceFamily', sourcePath),
        boundaryKind: boundaryKind as AcceptedBoundaryKind,
      },
      decision: 'accepted',
      sourceDigest,
    };
  });
}

export async function resolveToolGovernanceEvidence(input: EvidenceResolutionInput): Promise<ResolvedEvidenceCatalog> {
  const existingRefs = new Set<EvidenceRef>();
  for (const ref of [...new Set(input.refs)].sort()) {
    if (await resolveRef(input.repoRoot, ref)) existingRefs.add(ref);
  }

  const groupedClaims = new Map<EvidenceRef, ResolvedAdmissionClaim[]>();
  const admissionSourcePaths = input.admissionSourcePaths ?? (await discoverAdmissionSourcePaths(input.repoRoot));
  for (const sourcePath of [...new Set(admissionSourcePaths)].sort()) {
    const content = await readFile(repoPath(input.repoRoot, sourcePath), 'utf8');
    for (const claim of parseClaims(content, sourcePath)) {
      const claims = groupedClaims.get(claim.ref) ?? [];
      claims.push(claim);
      groupedClaims.set(claim.ref, claims);
    }
  }
  const admissionClaims = new Map<EvidenceRef, NonEmptyReadonlyArray<ResolvedAdmissionClaim>>();
  for (const [ref, claims] of groupedClaims) {
    claims.sort((left, right) =>
      `${left.subject.toolName}:${left.subject.resourceFamily}:${left.subject.boundaryKind}`.localeCompare(
        `${right.subject.toolName}:${right.subject.resourceFamily}:${right.subject.boundaryKind}`,
      ),
    );
    const [first, ...rest] = claims;
    if (!first) throw new Error(`Internal error: empty admission claim group for ${ref}`);
    admissionClaims.set(ref, [first, ...rest]);
  }
  return { existingRefs, admissionClaims };
}
