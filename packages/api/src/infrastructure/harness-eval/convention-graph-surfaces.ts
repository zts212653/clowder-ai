import { canonicalizePathForGlobs, matchesAny } from './capability-wakeup/eval-capability-wakeup-trials-support.js';

export const CONVENTION_GRAPH_SURFACES = [
  {
    domainId: 'mcp-tool',
    globs: ['packages/mcp-server/src/tools/*.ts', 'packages/mcp-server/src/server-toolsets.ts'],
  },
  {
    domainId: 'skill-manifest',
    globs: ['cat-cafe-skills/*/SKILL.md'],
  },
  {
    domainId: 'l0-prompt-builder',
    globs: ['scripts/compile-system-prompt-l0.mjs'],
  },
] as const;

export type ConventionGraphDomainId = (typeof CONVENTION_GRAPH_SURFACES)[number]['domainId'];

export interface ConventionGraphEvidenceCommand {
  readonly command: string;
  readonly stdout?: string;
  readonly summary?: unknown;
}

const ALL_SURFACE_GLOBS = CONVENTION_GRAPH_SURFACES.flatMap((surface) => surface.globs);

interface ConventionGraphTarget {
  readonly id?: string;
  readonly domainId?: string;
  readonly kind?: string;
  readonly name?: string;
  readonly filePath?: string;
}

export function conventionGraphDomainsForPaths(paths: readonly string[]): ConventionGraphDomainId[] {
  const domains = new Set<ConventionGraphDomainId>();
  for (const rawPath of paths) {
    const path = canonicalizePathForGlobs(rawPath, ALL_SURFACE_GLOBS, []);
    for (const surface of CONVENTION_GRAPH_SURFACES) {
      if (matchesAny(path, [...surface.globs])) domains.add(surface.domainId);
    }
  }
  return [...domains];
}

export function conventionGraphPathsForDomain(paths: readonly string[], domain: ConventionGraphDomainId): string[] {
  const domainPaths = new Set<string>();
  for (const rawPath of paths) {
    const path = canonicalizePathForGlobs(rawPath, ALL_SURFACE_GLOBS, []);
    if (conventionGraphDomainsForPaths([path]).includes(domain)) domainPaths.add(path);
  }
  return [...domainPaths];
}

export function conventionGraphDomainFromCommand(command: string): ConventionGraphDomainId | null {
  if (!isConventionGraphCodeConsumersCommand(command)) return null;
  const match = /(?:^|\s)--domain(?:=|\s+)([^\s]+)/.exec(command);
  const domain = match?.[1];
  return isConventionGraphDomain(domain) ? domain : null;
}

export function isConventionGraphCodeConsumersCommand(command: string): boolean {
  return (
    /\bpnpm\s+convention-graph:code-consumers\b/.test(command) ||
    /\bcat-cafe-convention-graph\s+code-consumers\b/.test(command)
  );
}

export function conventionGraphCommandHasFreshResults(command: ConventionGraphEvidenceCommand): boolean {
  if (!isConventionGraphCodeConsumersCommand(command.command)) return false;
  return readFreshnessStale(command) === false;
}

export function conventionGraphCommandTargetPaths(
  command: ConventionGraphEvidenceCommand,
  domain?: ConventionGraphDomainId | null,
): string[] {
  const paths = new Set<string>();
  for (const target of readTargets(command)) {
    if (domain && target.domainId !== domain) continue;
    if (target.filePath) paths.add(canonicalizePathForGlobs(target.filePath, ALL_SURFACE_GLOBS, []));
  }
  return [...paths];
}

export function conventionGraphCoverageKeysForPaths(
  paths: readonly string[],
  domain: ConventionGraphDomainId,
): string[] {
  const keys = new Set<string>();
  for (const path of conventionGraphPathsForDomain(paths, domain)) {
    const key = coverageKeyForPath(domain, path);
    if (key) keys.add(key);
  }
  return [...keys];
}

export function conventionGraphCommandCoverageKeys(
  command: ConventionGraphEvidenceCommand,
  domain?: ConventionGraphDomainId | null,
): string[] {
  const keys = new Set<string>();
  for (const target of readTargets(command)) {
    if (domain && target.domainId !== domain) continue;
    const targetDomain = domain ? domain : target.domainId;
    const key = coverageKeyForTarget(targetDomain, target);
    if (key) keys.add(key);
  }
  return [...keys];
}

export function conventionGraphCoverageKeysCoverChangedFiles(
  coverageKeys: readonly string[],
  domain: ConventionGraphDomainId,
  changedFiles: readonly string[],
): boolean {
  const expectedKeys = conventionGraphCoverageKeysForPaths(changedFiles, domain);
  if (expectedKeys.length === 0) return false;
  const coveredKeys = new Set(coverageKeys);
  return expectedKeys.every((key) => coveredKeys.has(key));
}

export function conventionGraphCommandCoversChangedFiles(
  command: ConventionGraphEvidenceCommand,
  domain: ConventionGraphDomainId,
  changedFiles: readonly string[],
): boolean {
  if (!conventionGraphCommandHasFreshResults(command)) return false;
  if (conventionGraphDomainFromCommand(command.command) !== domain) return false;
  return conventionGraphCoverageKeysCoverChangedFiles(
    conventionGraphCommandCoverageKeys(command, domain),
    domain,
    changedFiles,
  );
}

function isConventionGraphDomain(value: string | undefined): value is ConventionGraphDomainId {
  return CONVENTION_GRAPH_SURFACES.some((surface) => surface.domainId === value);
}

function readFreshnessStale(command: ConventionGraphEvidenceCommand): boolean | undefined {
  for (const result of readResultObjects(command)) {
    const stale = readFreshnessStaleFromObject(result);
    if (stale !== undefined) return stale;
  }
  return undefined;
}

function readTargets(command: ConventionGraphEvidenceCommand): ConventionGraphTarget[] {
  for (const result of readResultObjects(command)) {
    const targets = result?.targets;
    if (!Array.isArray(targets)) continue;
    return targets.flatMap(readTarget);
  }
  return [];
}

function readTarget(target: unknown): ConventionGraphTarget[] {
  const record = asRecord(target);
  if (!record) return [];
  const id = readStringField(record, 'id');
  const domainId = firstStringField(record, ['domainId', 'domain_id']);
  const kind = readStringField(record, 'kind');
  const name = readStringField(record, 'name');
  const filePath = firstStringField(record, ['filePath', 'file_path']);
  return [
    {
      ...(id ? { id } : {}),
      ...(domainId ? { domainId } : {}),
      ...(kind ? { kind } : {}),
      ...(name ? { name } : {}),
      ...(filePath ? { filePath } : {}),
    },
  ];
}

function readResultObjects(command: ConventionGraphEvidenceCommand): (Record<string, unknown> | null)[] {
  const summary = asRecord(command.summary);
  const summaryResult = asRecord(summary?.result);
  return [
    summary,
    summaryResult,
    parseJsonObject(firstStringField(summary, ['stdout', 'output'])),
    parseJsonObject(firstStringField(summaryResult, ['stdout', 'output'])),
    parseJsonObject(command.stdout),
  ];
}

function readFreshnessStaleFromObject(value: Record<string, unknown> | null): boolean | undefined {
  const freshness = asRecord(value?.freshness);
  return typeof freshness?.stale === 'boolean' ? freshness.stale : undefined;
}

function readStringField(value: Record<string, unknown> | null, field: string): string | undefined {
  const candidate = value?.[field];
  return typeof candidate === 'string' ? candidate : undefined;
}

function firstStringField(value: Record<string, unknown> | null, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const candidate = readStringField(value, field);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function coverageKeyForTarget(
  domain: ConventionGraphDomainId | string | undefined,
  target: ConventionGraphTarget,
): string | null {
  if (!isConventionGraphDomain(domain)) return null;
  if (target.filePath)
    return coverageKeyForPath(domain, canonicalizePathForGlobs(target.filePath, ALL_SURFACE_GLOBS, []));
  if (target.name) return `${domain}:name:${target.name}`;
  if (target.id) return `${domain}:id:${target.id}`;
  return null;
}

function coverageKeyForPath(domain: ConventionGraphDomainId, path: string): string {
  if (domain === 'mcp-tool') return `${domain}:${mcpToolSurfaceStem(path)}`;
  if (domain === 'skill-manifest') return `${domain}:${skillManifestSurfaceKey(path)}`;
  return `${domain}:${path}`;
}

function mcpToolSurfaceStem(path: string): string {
  let stem = stripExtension(baseName(path));
  for (const suffix of [
    '-sop-source-refs',
    '-source-refs',
    '-toolsets',
    '-toolset',
    '-tools',
    '-tool',
    '-schemas',
    '-schema',
    '-helpers',
    '-helper',
    '-types',
    '-type',
  ]) {
    if (stem.endsWith(suffix) && stem.length > suffix.length) {
      stem = stem.slice(0, -suffix.length);
      break;
    }
  }
  return stem;
}

function skillManifestSurfaceKey(path: string): string {
  const match = /^cat-cafe-skills\/([^/]+)\/SKILL\.md$/.exec(path);
  if (match?.[1]) return match[1];
  return path;
}

function baseName(path: string): string {
  const parts = path.split('/');
  const name = parts[parts.length - 1];
  if (name !== undefined && name !== '') return name;
  return path;
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}
