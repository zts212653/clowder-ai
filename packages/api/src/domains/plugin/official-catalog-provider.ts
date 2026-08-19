import {
  type OfficialPluginCatalogEntry,
  type OfficialPluginCatalogPolicy,
  type OfficialPluginRelease,
  officialPluginCatalogEntry,
} from './official-catalog.js';

export type OfficialPluginCatalogRefreshErrorCode =
  | 'CATALOG_FETCH_FAILED'
  | 'CATALOG_INVALID_METADATA'
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
}

export interface RefreshingOfficialPluginCatalogOptions {
  readonly policies: readonly OfficialPluginCatalogPolicy[];
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
  readonly refreshTtlMs?: number;
  readonly timeoutMs?: number;
  readonly maxMetadataBytes?: number;
}

const REGISTRY_ORIGIN = 'https://registry.npmjs.org';
const DEFAULT_REFRESH_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_METADATA_BYTES = 128 * 1024;

interface ParsedVersion {
  readonly major: string;
  readonly minor: string;
  readonly patch: string;
  readonly prerelease: readonly string[] | null;
}

class CatalogRefreshError extends Error {
  constructor(readonly code: OfficialPluginCatalogRefreshErrorCode) {
    super(code);
    this.name = 'CatalogRefreshError';
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalSha512(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('sha512-')) return false;
  const encoded = value.slice('sha512-'.length);
  const decoded = Buffer.from(encoded, 'base64');
  return decoded.byteLength === 64 && decoded.toString('base64') === encoded;
}

function exactTarballUrl(packageName: string, version: string, value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const packageLeaf = packageName.slice(packageName.lastIndexOf('/') + 1);
    return (
      url.origin === REGISTRY_ORIGIN &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      decodeURIComponent(url.pathname) === `/${packageName}/-/${packageLeaf}-${version}.tgz`
    );
  } catch {
    return false;
  }
}

function exactProvenance(packageName: string, version: string, value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.provenance)) return false;
  if (value.provenance.predicateType !== 'https://slsa.dev/provenance/v1' || typeof value.url !== 'string') {
    return false;
  }
  try {
    const url = new URL(value.url);
    return (
      url.origin === REGISTRY_ORIGIN &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      decodeURIComponent(url.pathname) === `/-/npm/v1/attestations/${packageName}@${version}`
    );
  } catch {
    return false;
  }
}

function parseRelease(policy: OfficialPluginCatalogPolicy, value: unknown): OfficialPluginRelease {
  if (
    !isRecord(value) ||
    value.name !== policy.packageName ||
    typeof value.version !== 'string' ||
    !isRecord(value.dist)
  ) {
    throw new CatalogRefreshError('CATALOG_INVALID_METADATA');
  }
  if (
    compareOfficialPluginVersions(value.version, policy.bootstrapRelease.version) === undefined ||
    !exactTarballUrl(policy.packageName, value.version, value.dist.tarball) ||
    !canonicalSha512(value.dist.integrity) ||
    !exactProvenance(policy.packageName, value.version, value.dist.attestations)
  ) {
    throw new CatalogRefreshError('CATALOG_INVALID_METADATA');
  }
  return {
    version: value.version,
    archiveUrl: value.dist.tarball,
    packageDigest: value.dist.integrity,
  };
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new CatalogRefreshError('CATALOG_INVALID_METADATA');
  }
  if (!response.body) throw new CatalogRefreshError('CATALOG_INVALID_METADATA');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new CatalogRefreshError('CATALOG_INVALID_METADATA');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    throw new CatalogRefreshError('CATALOG_INVALID_METADATA');
  }
}

function sameRelease(left: OfficialPluginRelease, right: OfficialPluginRelease): boolean {
  return (
    left.version === right.version && left.archiveUrl === right.archiveUrl && left.packageDigest === right.packageDigest
  );
}

function releaseDigestKey(catalogId: string, packageDigest: string): string {
  return `${catalogId}\0${packageDigest}`;
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

export class RefreshingOfficialPluginCatalog implements OfficialPluginCatalogProvider {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly refreshTtlMs: number;
  private readonly timeoutMs: number;
  private readonly maxMetadataBytes: number;
  private readonly releases = new Map<string, OfficialPluginRelease>();
  private readonly releaseVersionsByDigest = new Map<string, string>();
  private lastAttemptAt: number | null = null;
  private status: OfficialPluginCatalogSnapshot['status'] = 'bootstrap';
  private errorCode: OfficialPluginCatalogRefreshErrorCode | undefined;
  private inFlight: Promise<OfficialPluginCatalogSnapshot> | undefined;

  constructor(private readonly options: RefreshingOfficialPluginCatalogOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
    this.refreshTtlMs = options.refreshTtlMs ?? DEFAULT_REFRESH_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxMetadataBytes = options.maxMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES;
    for (const policy of options.policies) {
      this.releases.set(policy.catalogId, policy.bootstrapRelease);
      this.releaseVersionsByDigest.set(
        releaseDigestKey(policy.catalogId, policy.bootstrapRelease.packageDigest),
        policy.bootstrapRelease.version,
      );
    }
  }

  async snapshot(): Promise<OfficialPluginCatalogSnapshot> {
    const now = this.now();
    if (this.inFlight) return this.inFlight;
    if (this.lastAttemptAt !== null && now - this.lastAttemptAt < this.refreshTtlMs) return this.project();
    this.lastAttemptAt = now;
    this.inFlight = this.refresh().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async refresh(): Promise<OfficialPluginCatalogSnapshot> {
    try {
      const releases = await Promise.all(this.options.policies.map((policy) => this.fetchRelease(policy)));
      for (let index = 0; index < this.options.policies.length; index += 1) {
        this.releases.set(this.options.policies[index].catalogId, releases[index]);
      }
      this.status = 'fresh';
      this.errorCode = undefined;
    } catch (error) {
      this.status = 'degraded';
      this.errorCode = error instanceof CatalogRefreshError ? error.code : 'CATALOG_FETCH_FAILED';
    }
    return this.project();
  }

  private async fetchRelease(policy: OfficialPluginCatalogPolicy): Promise<OfficialPluginRelease> {
    let response: Response;
    try {
      response = await this.fetchFn(
        `${REGISTRY_ORIGIN}/${encodeURIComponent(policy.packageName)}/${policy.releaseTag}`,
        {
          redirect: 'error',
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: { accept: 'application/json' },
        },
      );
    } catch {
      throw new CatalogRefreshError('CATALOG_FETCH_FAILED');
    }
    if (!response.ok) throw new CatalogRefreshError('CATALOG_FETCH_FAILED');
    const release = parseRelease(policy, await readBoundedJson(response, this.maxMetadataBytes));
    const current = this.releases.get(policy.catalogId) ?? policy.bootstrapRelease;
    const comparison = compareOfficialPluginVersions(release.version, current.version);
    if (comparison === undefined) throw new CatalogRefreshError('CATALOG_INVALID_METADATA');
    if (comparison < 0) throw new CatalogRefreshError('CATALOG_ROLLBACK_REJECTED');
    if (comparison === 0 && !sameRelease(release, current)) {
      throw new CatalogRefreshError('CATALOG_EQUIVOCATION_REJECTED');
    }
    const digestKey = releaseDigestKey(policy.catalogId, release.packageDigest);
    const digestVersion = this.releaseVersionsByDigest.get(digestKey);
    if (comparison > 0 && digestVersion !== undefined && digestVersion !== release.version) {
      throw new CatalogRefreshError('CATALOG_INVALID_METADATA');
    }
    this.releaseVersionsByDigest.set(digestKey, release.version);
    return release;
  }

  private project(): OfficialPluginCatalogSnapshot {
    const entries = this.options.policies.map((policy) =>
      officialPluginCatalogEntry(policy, this.releases.get(policy.catalogId) ?? policy.bootstrapRelease),
    );
    return {
      entries,
      status: this.status,
      checkedAt: this.lastAttemptAt,
      ...(this.errorCode === undefined ? {} : { errorCode: this.errorCode }),
    };
  }
}
