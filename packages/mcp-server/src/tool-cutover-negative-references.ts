export const FIXED_CUTOVER_NEGATIVE_TEST_ROOTS = [
  'packages/mcp-server/test',
  'packages/api/test',
  'packages/web/test',
  'packages/shared/test',
  'test',
] as const;

export const CUTOVER_NEGATIVE_REFERENCE_KINDS = ['absence', 'rejection'] as const;
export const CUTOVER_NEGATIVE_REFERENCE_MARKER = 'mcp-cutover-negative-reference:';

export type CutoverConsumerMatch = {
  root: string;
  path: string;
  line: number;
};

export type CutoverNegativeReference = CutoverConsumerMatch & {
  kind: (typeof CUTOVER_NEGATIVE_REFERENCE_KINDS)[number];
};

export type CutoverConsumerScan = {
  retiredName: string;
  scannedRoots: readonly string[];
  matches: readonly CutoverConsumerMatch[];
  negativeReferences: readonly CutoverNegativeReference[];
  resolvedConsumers: readonly string[];
};

type ClassifiedReferences = {
  activeMatches: readonly CutoverConsumerMatch[];
  invalidEvidence: readonly string[];
};

type ReferenceValidationContext = {
  evidenceCounts: ReadonlyMap<string, number>;
  rawCoordinates: ReadonlySet<string>;
  allowedConsumers: ReadonlySet<string>;
};

function coordinate(reference: CutoverConsumerMatch): string {
  return `${reference.root}\0${reference.path}\0${reference.line}`;
}

function isNegativeTestRoot(root: string): boolean {
  return FIXED_CUTOVER_NEGATIVE_TEST_ROOTS.includes(root as (typeof FIXED_CUTOVER_NEGATIVE_TEST_ROOTS)[number]);
}

function isKnownKind(kind: string): boolean {
  return CUTOVER_NEGATIVE_REFERENCE_KINDS.includes(kind as (typeof CUTOVER_NEGATIVE_REFERENCE_KINDS)[number]);
}

function pathBelongsToRoot(path: string, root: string): boolean {
  return path.startsWith(`${root}/`) && !path.includes('..') && !path.includes('\\');
}

function invalidEvidenceReasons(
  reference: CutoverNegativeReference,
  key: string,
  context: ReferenceValidationContext,
): string[] {
  const reasons: string[] = [];
  if (context.evidenceCounts.get(key) !== 1) reasons.push('duplicate evidence');
  if (!context.rawCoordinates.has(key)) reasons.push('no matching fixed-root occurrence');
  if (!isNegativeTestRoot(reference.root)) reasons.push('not in a fixed deterministic-test root');
  if (!pathBelongsToRoot(reference.path, reference.root)) reasons.push('path/root mismatch');
  if (!context.allowedConsumers.has(reference.path)) reasons.push('not listed by fixture-test consumers');
  if (!isKnownKind(reference.kind)) reasons.push('unknown negative-reference kind');
  return reasons;
}

export function classifyCutoverReferences(
  scan: CutoverConsumerScan,
  fixtureTestConsumers: readonly string[] | undefined,
): ClassifiedReferences {
  const rawCoordinates = new Set(scan.matches.map(coordinate));
  const evidenceCounts = new Map<string, number>();
  for (const reference of scan.negativeReferences) {
    const key = coordinate(reference);
    evidenceCounts.set(key, (evidenceCounts.get(key) ?? 0) + 1);
  }

  const allowedConsumers = new Set(fixtureTestConsumers ?? []);
  const validCoordinates = new Set<string>();
  const invalidEvidence: string[] = [];
  for (const reference of scan.negativeReferences) {
    const key = coordinate(reference);
    const reasons = invalidEvidenceReasons(reference, key, { evidenceCounts, rawCoordinates, allowedConsumers });
    if (reasons.length > 0) {
      invalidEvidence.push(`${reference.path}:${reference.line} (${reasons.join(', ')})`);
      continue;
    }
    validCoordinates.add(key);
  }

  return {
    activeMatches: scan.matches.filter((match) => !validCoordinates.has(coordinate(match))),
    invalidEvidence,
  };
}
