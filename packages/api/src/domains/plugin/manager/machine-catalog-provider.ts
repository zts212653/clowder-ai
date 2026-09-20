import type { PluginDescription, PluginIconSpec } from '@cat-cafe/shared';
import type { Capability } from '@clowder-ai/plugin-contract';
import type { OfficialPluginCatalogEntry, OfficialPluginOwnerAuth } from '../official-catalog.js';
import {
  compareOfficialPluginVersions,
  type OfficialPluginCatalogProvider,
  type OfficialPluginCatalogSnapshot,
} from '../official-catalog-provider.js';

export const OFFICIAL_PLUGIN_CATALOG_URL =
  'https://raw.githubusercontent.com/zts212653/clowder-ai-plugins/main/catalog/catalog.json';

const DEFAULT_CATALOG_TIMEOUT_MS = 5_000;
const DEFAULT_CATALOG_MAX_BYTES = 256 * 1024;
const DEFAULT_REFRESH_TTL_MS = 5 * 60_000;

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
  const fetchFn = options.fetchFn ?? fetch;
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

export interface MachineCatalogHostPolicy {
  readonly pluginId: string;
  readonly replacesRepositoryPluginId?: string;
  readonly effectiveGrants: readonly Capability[];
  readonly ownerAuth?: OfficialPluginOwnerAuth;
}

export interface MachineOfficialPluginCatalogOptions {
  readonly loadCatalog: () => Promise<unknown>;
  /** Exact runtime export from the selected @clowder-ai/plugin-contract artifact. */
  readonly validateCatalog: (value: unknown) => MachineCatalogValidationResult;
  /** Host-owned authority; catalog metadata is never allowed to widen this policy. */
  readonly hostPolicies: readonly MachineCatalogHostPolicy[];
  readonly refreshTtlMs?: number;
  readonly now?: () => number;
}

/**
 * Resolves repository identities replaced by Host-managed catalog plugins.
 * Machine metadata can announce a current candidate, while an installed instance
 * keeps the replacement authoritative even when discovery is temporarily offline.
 */
export function resolveRepositoryReplacementPluginIds(
  hostPolicies: readonly MachineCatalogHostPolicy[],
  catalogEntries: readonly Pick<OfficialPluginCatalogEntry, 'pluginId'>[],
  installedPluginIds: readonly string[],
): readonly string[] {
  const authoritativePluginIds = new Set([...catalogEntries.map((entry) => entry.pluginId), ...installedPluginIds]);
  return hostPolicies.flatMap((policy) =>
    policy.replacesRepositoryPluginId !== undefined && authoritativePluginIds.has(policy.pluginId)
      ? [policy.replacesRepositoryPluginId]
      : [],
  );
}

function projectEntry(
  plugin: ValidatedMachineCatalog['plugins'][number],
  policy: MachineCatalogHostPolicy,
): OfficialPluginCatalogEntry | undefined {
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
    ...(policy.replacesRepositoryPluginId === undefined
      ? {}
      : { replacesRepositoryPluginId: policy.replacesRepositoryPluginId }),
    effectiveGrants: policy.effectiveGrants,
    ...(policy.ownerAuth === undefined ? {} : { ownerAuth: policy.ownerAuth }),
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
  private readonly policies: ReadonlyMap<string, MachineCatalogHostPolicy>;
  private readonly refreshTtlMs: number;
  private lastGoodEntries: readonly OfficialPluginCatalogEntry[] = [];
  private lastAttemptAt: number | null = null;
  private checkedAt: number | null = null;
  private status: OfficialPluginCatalogSnapshot['status'] = 'bootstrap';
  private errorCode: OfficialPluginCatalogSnapshot['errorCode'];
  private inFlight: Promise<OfficialPluginCatalogSnapshot> | undefined;

  constructor(private readonly options: MachineOfficialPluginCatalogOptions) {
    this.now = options.now ?? Date.now;
    this.policies = new Map(options.hostPolicies.map((policy) => [policy.pluginId, policy]));
    this.refreshTtlMs = options.refreshTtlMs ?? DEFAULT_REFRESH_TTL_MS;
  }

  async snapshot(): Promise<OfficialPluginCatalogSnapshot> {
    const now = this.now();
    if (this.inFlight) return this.inFlight;
    if (this.lastAttemptAt !== null && now - this.lastAttemptAt < this.refreshTtlMs) return this.project();
    this.lastAttemptAt = now;
    this.inFlight = this.refresh(now).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
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
      const policy = this.policies.get(plugin.pluginId);
      if (!policy) continue;
      const entry = projectEntry(plugin, policy);
      if (entry) entries.push(entry);
    }
    this.lastGoodEntries = entries;
    this.status = 'fresh';
    this.errorCode = undefined;
    return this.project();
  }

  private project(): OfficialPluginCatalogSnapshot {
    return {
      entries: this.lastGoodEntries,
      status: this.status,
      checkedAt: this.checkedAt,
      ...(this.errorCode === undefined ? {} : { errorCode: this.errorCode }),
    };
  }
}
