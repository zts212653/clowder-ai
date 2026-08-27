import type { EvidenceRef, McpRuntimeProfile } from './tool-governance-types.js';

export const FIXED_CUTOVER_CONSUMER_ROOTS = [
  'packages/mcp-server/src',
  'packages/api/src',
  'packages/api/config',
  'packages/web/src',
  'packages/shared/src',
  'assets/system-prompts',
  'assets/prompt-templates',
  'cat-cafe-skills',
  'packages/mcp-server/test',
  'packages/api/test',
  'packages/web/test',
  'packages/shared/test',
  'test',
  'evals',
  'scripts',
] as const;

export const REQUIRED_CUTOVER_LAYERS = [
  'mcp-definition',
  'runtime-catalog-profile',
  'prompt-l0',
  'skill-convention',
  'fixture-test',
  'eval',
  'observability',
] as const;

export type CutoverLayer = (typeof REQUIRED_CUTOVER_LAYERS)[number];

export type CutoverSurfaceEntry = {
  name: string;
  resourceFamily: string;
  runtimeProfiles: readonly McpRuntimeProfile[];
};

export type CutoverLayerDisposition =
  | { status: 'covered'; consumers: readonly string[] }
  | { status: 'not-applicable'; rationale: string; absenceEvidence: readonly string[] };

export type AtomicCutoverManifest = {
  resource:
    | { kind: 'family'; resourceFamily: string }
    | {
        kind: 'tightly-coupled-group';
        groupName: string;
        resourceFamilies: readonly [string, string, ...string[]];
        evidenceRef: EvidenceRef;
      };
  retiredNames: readonly string[];
  canonicalNames: readonly string[];
  expectedProfiles: Readonly<Record<string, readonly McpRuntimeProfile[]>>;
  rollbackRevision: string;
  layers: Partial<Record<CutoverLayer, CutoverLayerDisposition>>;
};

export type CutoverConsumerScan = {
  retiredName: string;
  scannedRoots: readonly string[];
  matches: readonly { root: string; path: string; line: number }[];
  resolvedConsumers: readonly string[];
};

export type CutoverFinding = {
  code:
    | 'missing-cutover-manifest'
    | 'cutover-set-mismatch'
    | 'missing-cutover-layer'
    | 'consumer-root-coverage-mismatch'
    | 'stale-retired-reference'
    | 'cross-family-cutover'
    | 'invalid-rollback-revision'
    | 'dual-surface-exposure'
    | 'profile-expectation-mismatch';
  manifestIndex?: number;
  name?: string;
  message: string;
};

type ValidationInput = {
  before: readonly CutoverSurfaceEntry[];
  after: readonly CutoverSurfaceEntry[];
  manifests: readonly AtomicCutoverManifest[];
  scans: readonly CutoverConsumerScan[];
};

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function equalSet(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = sorted(left);
  const normalizedRight = sorted(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

function removedProfiles(before: CutoverSurfaceEntry, after: CutoverSurfaceEntry): readonly McpRuntimeProfile[] {
  return before.runtimeProfiles.filter((profile) => !after.runtimeProfiles.includes(profile));
}

function familiesForManifest(manifest: AtomicCutoverManifest): ReadonlySet<string> {
  return new Set(
    manifest.resource.kind === 'family' ? [manifest.resource.resourceFamily] : manifest.resource.resourceFamilies,
  );
}

function manifestSetFindings(
  manifest: AtomicCutoverManifest,
  index: number,
  beforeByName: ReadonlyMap<string, CutoverSurfaceEntry>,
  afterByName: ReadonlyMap<string, CutoverSurfaceEntry>,
): CutoverFinding[] {
  const findings: CutoverFinding[] = [];
  const families = familiesForManifest(manifest);
  const expectedRetired = sorted(
    [...beforeByName.values()]
      .filter((entry) => families.has(entry.resourceFamily) && !afterByName.has(entry.name))
      .map((entry) => entry.name),
  );
  const expectedCanonical = sorted(
    [...afterByName.values()]
      .filter((entry) => families.has(entry.resourceFamily) && !beforeByName.has(entry.name))
      .map((entry) => entry.name),
  );
  const expectedProfileNames = sorted([
    ...expectedCanonical,
    ...[...beforeByName.values()]
      .filter((entry) => {
        const after = afterByName.get(entry.name);
        return after && families.has(entry.resourceFamily) && removedProfiles(entry, after).length > 0;
      })
      .map((entry) => entry.name),
  ]);
  const hasCurrentDelta = expectedRetired.length > 0 || expectedCanonical.length > 0 || expectedProfileNames.length > 0;
  if (
    hasCurrentDelta &&
    (!equalSet(manifest.retiredNames, expectedRetired) ||
      !equalSet(manifest.canonicalNames, expectedCanonical) ||
      !equalSet(Object.keys(manifest.expectedProfiles), expectedProfileNames))
  ) {
    findings.push({
      code: 'cutover-set-mismatch',
      manifestIndex: index,
      message: `Manifest sets must equal derived delta; retired=${expectedRetired.join(',')} canonical=${expectedCanonical.join(',')} profiles=${expectedProfileNames.join(',')}`,
    });
  }
  const observedFamilies = new Set(
    [...manifest.retiredNames, ...manifest.canonicalNames].flatMap((name) => {
      const family = beforeByName.get(name)?.resourceFamily ?? afterByName.get(name)?.resourceFamily;
      return family ? [family] : [];
    }),
  );
  if (
    manifest.resource.kind === 'family' &&
    (observedFamilies.size > 1 ||
      (observedFamilies.size === 1 && !observedFamilies.has(manifest.resource.resourceFamily)))
  ) {
    findings.push({
      code: 'cross-family-cutover',
      manifestIndex: index,
      message: 'A family manifest cannot contain identities from another resource family',
    });
  }
  return findings;
}

function manifestIntegrityFindings(manifest: AtomicCutoverManifest, index: number): CutoverFinding[] {
  const findings: CutoverFinding[] = [];
  if (!/^[a-f0-9]{40}$/.test(manifest.rollbackRevision)) {
    findings.push({
      code: 'invalid-rollback-revision',
      manifestIndex: index,
      message: 'rollbackRevision must be an exact 40-character commit SHA',
    });
  }
  for (const layer of REQUIRED_CUTOVER_LAYERS) {
    if (!manifest.layers[layer]) {
      findings.push({
        code: 'missing-cutover-layer',
        manifestIndex: index,
        message: `Cutover manifest is missing layer ${layer}`,
      });
    }
  }
  return findings;
}

function scanFindings(
  manifest: AtomicCutoverManifest,
  index: number,
  scansByName: ReadonlyMap<string, CutoverConsumerScan>,
): CutoverFinding[] {
  const findings: CutoverFinding[] = [];
  for (const retiredName of manifest.retiredNames) {
    const scan = scansByName.get(retiredName);
    if (!scan || !equalSet(scan.scannedRoots, FIXED_CUTOVER_CONSUMER_ROOTS)) {
      findings.push({
        code: 'consumer-root-coverage-mismatch',
        manifestIndex: index,
        name: retiredName,
        message: `${retiredName} was not scanned across the fixed consumer-root set`,
      });
      continue;
    }
    if (scan.matches.length > 0 || scan.resolvedConsumers.length > 0) {
      findings.push({
        code: 'stale-retired-reference',
        manifestIndex: index,
        name: retiredName,
        message: `${retiredName} still has production or resolved consumers`,
      });
    }
    for (const layer of REQUIRED_CUTOVER_LAYERS) {
      const disposition = manifest.layers[layer];
      if (disposition?.status === 'not-applicable' && !disposition.absenceEvidence.includes(retiredName)) {
        findings.push({
          code: 'stale-retired-reference',
          manifestIndex: index,
          name: retiredName,
          message: `${layer} not-applicable lacks absence evidence for ${retiredName}`,
        });
      }
    }
  }
  return findings;
}

function profileExpectationFindings(
  manifest: AtomicCutoverManifest,
  index: number,
  afterByName: ReadonlyMap<string, CutoverSurfaceEntry>,
): CutoverFinding[] {
  const findings: CutoverFinding[] = [];
  for (const [name, expected] of Object.entries(manifest.expectedProfiles)) {
    const actual = afterByName.get(name)?.runtimeProfiles ?? [];
    if (!equalSet(actual, expected)) {
      findings.push({
        code: 'profile-expectation-mismatch',
        manifestIndex: index,
        name,
        message: `Profile expectation does not match ${name}`,
      });
    }
  }
  return findings;
}

function dualSurfaceFindings(
  manifest: AtomicCutoverManifest,
  index: number,
  afterByName: ReadonlyMap<string, CutoverSurfaceEntry>,
): CutoverFinding[] {
  const findings: CutoverFinding[] = [];
  for (const retiredName of manifest.retiredNames) {
    const retired = afterByName.get(retiredName);
    if (!retired) continue;
    for (const canonicalName of manifest.canonicalNames) {
      const canonical = afterByName.get(canonicalName);
      if (!canonical) continue;
      const overlap = retired.runtimeProfiles.filter((profile) => canonical.runtimeProfiles.includes(profile));
      if (overlap.length > 0) {
        findings.push({
          code: 'dual-surface-exposure',
          manifestIndex: index,
          name: retiredName,
          message: `${retiredName} and ${canonicalName} overlap in ${overlap.join(',')}`,
        });
      }
    }
  }
  return findings;
}

function profileFindings(
  manifest: AtomicCutoverManifest,
  index: number,
  afterByName: ReadonlyMap<string, CutoverSurfaceEntry>,
): CutoverFinding[] {
  return [
    ...profileExpectationFindings(manifest, index, afterByName),
    ...dualSurfaceFindings(manifest, index, afterByName),
  ];
}

export function validateAtomicCutovers(input: ValidationInput): { ok: boolean; findings: readonly CutoverFinding[] } {
  const beforeByName = new Map(input.before.map((entry) => [entry.name, entry]));
  const afterByName = new Map(input.after.map((entry) => [entry.name, entry]));
  const scansByName = new Map(input.scans.map((scan) => [scan.retiredName, scan]));
  const findings: CutoverFinding[] = [];
  const manifestedRetirements = new Set(input.manifests.flatMap((manifest) => manifest.retiredNames));
  const manifestedProfileChanges = new Set(
    input.manifests.flatMap((manifest) => Object.keys(manifest.expectedProfiles)),
  );
  for (const name of beforeByName.keys()) {
    if (!afterByName.has(name) && !manifestedRetirements.has(name)) {
      findings.push({
        code: 'missing-cutover-manifest',
        name,
        message: `${name} was removed without an atomic cutover manifest`,
      });
    }
    const before = beforeByName.get(name);
    const after = afterByName.get(name);
    if (before && after && removedProfiles(before, after).length > 0 && !manifestedProfileChanges.has(name)) {
      findings.push({
        code: 'missing-cutover-manifest',
        name,
        message: `${name} lost a runtime/profile projection without an atomic cutover manifest`,
      });
    }
  }
  input.manifests.forEach((manifest, index) => {
    findings.push(...manifestSetFindings(manifest, index, beforeByName, afterByName));
    findings.push(...manifestIntegrityFindings(manifest, index));
    findings.push(...scanFindings(manifest, index, scansByName));
    findings.push(...profileFindings(manifest, index, afterByName));
  });
  findings.sort((left, right) =>
    `${left.manifestIndex ?? -1}:${left.name ?? ''}:${left.code}`.localeCompare(
      `${right.manifestIndex ?? -1}:${right.name ?? ''}:${right.code}`,
    ),
  );
  return { ok: findings.length === 0, findings };
}
