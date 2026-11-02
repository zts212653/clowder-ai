import type { OfficialPluginCatalogEntry } from '../official-catalog.js';

export type OfficialPluginCatalogRefreshErrorCode =
  | 'CATALOG_FETCH_FAILED'
  | 'CATALOG_INVALID_METADATA'
  | 'CATALOG_CONTRACT_INVALID'
  | 'CATALOG_POLICY_MISSING'
  | 'CATALOG_ROLLBACK_REJECTED'
  | 'CATALOG_EQUIVOCATION_REJECTED';

export interface OfficialPluginCatalogSnapshot {
  readonly entries: readonly OfficialPluginCatalogEntry[];
  readonly status: 'bootstrap' | 'fresh' | 'degraded';
  readonly checkedAt: number | null;
  readonly errorCode?: OfficialPluginCatalogRefreshErrorCode;
}

export interface OfficialPluginCatalogProvider {
  snapshot(): Promise<OfficialPluginCatalogSnapshot>;
  /** Current Host-owned/cached entries without starting a remote refresh. */
  localSnapshot?(): OfficialPluginCatalogSnapshot | Promise<OfficialPluginCatalogSnapshot>;
}

interface ParsedVersion {
  readonly major: string;
  readonly minor: string;
  readonly patch: string;
  readonly prerelease: readonly string[] | null;
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    );
  if (!match) return undefined;
  const prerelease = match[4]?.split('.') ?? null;
  if (
    prerelease?.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))
  ) {
    return undefined;
  }
  return {
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease,
  };
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  if (left === right) return 0;
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return compareNumericIdentifier(left, right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : 1;
}

function comparePrerelease(left: readonly string[] | null, right: readonly string[] | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    const comparison = comparePrereleaseIdentifier(leftPart, rightPart);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

export function compareOfficialPluginVersions(left: string, right: string): number | undefined {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (!parsedLeft || !parsedRight) return undefined;
  const major = compareNumericIdentifier(parsedLeft.major, parsedRight.major);
  if (major !== 0) return major;
  const minor = compareNumericIdentifier(parsedLeft.minor, parsedRight.minor);
  if (minor !== 0) return minor;
  const patch = compareNumericIdentifier(parsedLeft.patch, parsedRight.patch);
  if (patch !== 0) return patch;
  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}

export class StaticOfficialPluginCatalog implements OfficialPluginCatalogProvider {
  constructor(
    private readonly entries: readonly OfficialPluginCatalogEntry[],
    private readonly status: OfficialPluginCatalogSnapshot['status'] = 'bootstrap',
  ) {}

  async snapshot(): Promise<OfficialPluginCatalogSnapshot> {
    return { entries: this.entries, status: this.status, checkedAt: null };
  }
}
