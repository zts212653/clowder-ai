import { isDeepStrictEqual } from 'node:util';
import type { PluginDescription, PluginIconSpec } from '@cat-cafe/shared';
import type { OfficialPluginCatalogEntry } from '../official-catalog.js';
import { fetchPluginNetworkResource } from '../plugin-network-fetch.js';
import {
  compareOfficialPluginVersions,
  type OfficialPluginCatalogProvider,
  type OfficialPluginCatalogRefreshErrorCode,
  type OfficialPluginCatalogSnapshot,
} from './official-catalog-provider.js';

export const OFFICIAL_PLUGIN_CATALOG_URL =
  'https://raw.githubusercontent.com/zts212653/clowder-ai-plugins/main/catalog/catalog.json';

const DEFAULT_CATALOG_TIMEOUT_MS = 5_000;
const DEFAULT_CATALOG_MAX_BYTES = 256 * 1024;

export interface LoadMachinePluginCatalogOptions {
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

function assertCatalogUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new TypeError('Machine plugin catalog URL must use HTTPS');
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('Machine plugin catalog URL must not contain credentials');
  }
  return url;
}

async function readBoundedCatalogJson(response: Response, maxBytes: number): Promise<unknown> {
  const declaredLengthHeader = response.headers.get('content-length');
  if (declaredLengthHeader !== null) {
    const declaredLength = Number(declaredLengthHeader);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > maxBytes) {
      throw new TypeError('Machine plugin catalog exceeded the size limit');
    }
  }
  if (!response.body) throw new TypeError('Machine plugin catalog response had no body');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new TypeError('Machine plugin catalog exceeded the size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    throw new TypeError('Machine plugin catalog was not valid JSON');
  }
}

/** Fetches canonical discovery data through a fail-closed, bounded transport. */
export async function loadMachinePluginCatalog(
  catalogUrl: string,
  options: LoadMachinePluginCatalogOptions = {},
): Promise<unknown> {
  const url = assertCatalogUrl(catalogUrl);
  const fetchFn = options.fetchFn ?? fetchPluginNetworkResource;
  const response = await fetchFn(url, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw new TypeError('Machine plugin catalog request failed');
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const canonicalRawGitHubText = url.hostname === 'raw.githubusercontent.com' && contentType === 'text/plain';
  if (contentType !== 'application/json' && !canonicalRawGitHubText) {
    throw new TypeError('Machine plugin catalog response was not JSON');
  }
  return readBoundedCatalogJson(response, options.maxBytes ?? DEFAULT_CATALOG_MAX_BYTES);
}

/**
 * Projection of a catalog after the exact plugin-contract validator accepted it.
 * This boundary deliberately does not validate or duplicate catalog constraints.
 */
interface ValidatedMachineCatalog {
  readonly plugins: readonly {
    readonly pluginId: string;
    readonly name: string;
    readonly description: PluginDescription;
    readonly icon: PluginIconSpec;
    readonly publisher: { readonly name: string };
    readonly versions: readonly {
      readonly version: string;
      readonly artifact: {
        readonly packageName: string;
        readonly tarballUrl: string;
        readonly integrity: string;
      };
    }[];
  }[];
}

export type MachineCatalogValidationResult =
  | { readonly valid: true; readonly catalog: ValidatedMachineCatalog }
  | { readonly valid: false; readonly errors: readonly unknown[] };

export interface MachineOfficialPluginCatalogOptions {
  readonly loadCatalog: () => Promise<unknown>;
  /** Exact runtime export from the selected @clowder-ai/plugin-contract artifact. */
  readonly validateCatalog: (value: unknown) => MachineCatalogValidationResult;
  /** Host-shipped packages have no remote archive; installation still uses Host inventory. */
  readonly bundledEntries?: readonly OfficialPluginCatalogEntry[];
  readonly now?: () => number;
}

function projectEntry(plugin: ValidatedMachineCatalog['plugins'][number]): OfficialPluginCatalogEntry | undefined {
  const release = plugin.versions.reduce<(typeof plugin.versions)[number] | undefined>((latest, candidate) => {
    if (!latest) return candidate;
    const comparison = compareOfficialPluginVersions(candidate.version, latest.version);
    return comparison !== undefined && comparison > 0 ? candidate : latest;
  }, undefined);
  if (!release) return undefined;
  return {
    catalogId: plugin.pluginId,
    pluginId: plugin.pluginId,
    packageName: release.artifact.packageName,
    version: release.version,
    distribution: 'registry',
    archiveUrl: release.artifact.tarballUrl,
    packageDigest: release.artifact.integrity,
    presentation: {
      displayName: plugin.name,
      description: plugin.description,
      icon: plugin.icon,
      publisher: plugin.publisher.name,
    },
  };
}

/** Consumes canonical machine catalog truth without turning it into Host authority. */
export class MachineOfficialPluginCatalog implements OfficialPluginCatalogProvider {
  private readonly now: () => number;
  private readonly trustedReleases = new Map<string, OfficialPluginCatalogEntry>();
  private readonly versionsByDigest = new Map<string, string>();
  private lastGoodEntries: readonly OfficialPluginCatalogEntry[] = [];
  private checkedAt: number | null = null;
  private status: OfficialPluginCatalogSnapshot['status'] = 'bootstrap';
  private errorCode: OfficialPluginCatalogSnapshot['errorCode'];
  private inFlight: Promise<OfficialPluginCatalogSnapshot> | undefined;

  constructor(private readonly options: MachineOfficialPluginCatalogOptions) {
    if (options.bundledEntries?.some((entry) => entry.distribution !== 'bundled')) {
      throw new TypeError('Host bundled discovery accepts only bundled package entries');
    }
    this.now = options.now ?? Date.now;
  }

  async snapshot(): Promise<OfficialPluginCatalogSnapshot> {
    const now = this.now();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.refresh(now).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  localSnapshot(): OfficialPluginCatalogSnapshot {
    return this.project();
  }

  private async refresh(checkedAt: number): Promise<OfficialPluginCatalogSnapshot> {
    this.checkedAt = checkedAt;
    let raw: unknown;
    try {
      raw = await this.options.loadCatalog();
    } catch {
      this.status = 'degraded';
      this.errorCode = 'CATALOG_FETCH_FAILED';
      return this.project();
    }

    let validation: MachineCatalogValidationResult;
    try {
      validation = this.options.validateCatalog(raw);
    } catch {
      this.status = 'degraded';
      this.errorCode = 'CATALOG_CONTRACT_INVALID';
      return this.project();
    }
    if (!validation.valid) {
      this.status = 'degraded';
      this.errorCode = 'CATALOG_CONTRACT_INVALID';
      return this.project();
    }

    const entries: OfficialPluginCatalogEntry[] = [];
    for (const plugin of validation.catalog.plugins) {
      const entry = projectEntry(plugin);
      if (entry) entries.push(entry);
    }
    // Validate the entire snapshot before advancing any trusted release. A temporary
    // omission does not erase identity history or permit a later rollback.
    for (const entry of entries) {
      const error = this.continuityError(entry);
      if (error) {
        this.status = 'degraded';
        this.errorCode = error;
        return this.project();
      }
    }
    this.lastGoodEntries = structuredClone(entries);
    for (const entry of this.lastGoodEntries) {
      this.trustedReleases.set(entry.pluginId, entry);
      this.versionsByDigest.set(`${entry.pluginId}\0${entry.packageDigest}`, entry.version);
    }
    this.status = 'fresh';
    this.errorCode = undefined;
    return this.project();
  }

  private continuityError(entry: OfficialPluginCatalogEntry): OfficialPluginCatalogRefreshErrorCode | undefined {
    const previous = this.trustedReleases.get(entry.pluginId);
    const comparison = compareOfficialPluginVersions(entry.version, previous?.version ?? entry.version);
    if (comparison === undefined) return 'CATALOG_INVALID_METADATA';
    if (comparison < 0) return 'CATALOG_ROLLBACK_REJECTED';
    if (
      previous &&
      comparison === 0 &&
      (entry.version !== previous.version ||
        entry.packageName !== previous.packageName ||
        entry.archiveUrl !== previous.archiveUrl ||
        entry.packageDigest !== previous.packageDigest ||
        !isDeepStrictEqual(entry.presentation, previous.presentation))
    )
      return 'CATALOG_EQUIVOCATION_REJECTED';
    const seenVersion = this.versionsByDigest.get(`${entry.pluginId}\0${entry.packageDigest}`);
    if (seenVersion !== undefined && seenVersion !== entry.version) return 'CATALOG_EQUIVOCATION_REJECTED';
    return undefined;
  }

  private project(): OfficialPluginCatalogSnapshot {
    const bundled = this.options.bundledEntries ?? [];
    const reservedIds = new Set(bundled.map((entry) => entry.pluginId));
    return {
      entries: structuredClone([
        ...bundled,
        ...this.lastGoodEntries.filter((entry) => !reservedIds.has(entry.pluginId)),
      ]),
      status: this.status,
      checkedAt: this.checkedAt,
      ...(this.errorCode === undefined ? {} : { errorCode: this.errorCode }),
    };
  }
}
