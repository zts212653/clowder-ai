import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type GitMarketplaceRepository,
  marketplaceSourceId,
  normalizeMarketplaceAddress,
  normalizeMarketplaceBranch,
} from './git-marketplace-repository.js';

export interface GitMarketplaceSource {
  readonly id: string;
  readonly url: string;
  readonly branch?: string;
  readonly origin: 'official' | 'environment' | 'user';
  readonly status: 'pending' | 'ready' | 'error';
  readonly checkedAt: number | null;
  readonly error?: string;
  readonly commit?: string;
  readonly pluginCount: number;
}

interface CachedCatalog {
  commit: string;
  catalog: unknown;
  checkedAt: number;
}
interface SourceState {
  repositories: Array<{ url: string; branch?: string }>;
  catalogs: Record<string, CachedCatalog>;
}
export interface GitMarketplaceSourcesOptions {
  readonly path: string;
  readonly repository: GitMarketplaceRepository;
  readonly validateCatalog: (value: unknown) => boolean;
  readonly environment?: string;
  readonly officialUrl?: string;
  readonly now?: () => number;
}

function environmentSources(value: string | undefined): Array<{ url: string; branch?: string }> {
  if (!value?.trim()) return [];
  const values: unknown = value.trim().startsWith('[') ? JSON.parse(value) : [value];
  if (!Array.isArray(values)) throw new Error('PLUGIN_GIT_MARKETPLACE must be an address or repository array');
  return values.map((entry) => {
    const source = typeof entry === 'string' ? { url: entry } : entry;
    if (!source || typeof source.url !== 'string' || (source.branch !== undefined && typeof source.branch !== 'string'))
      throw new Error('Invalid PLUGIN_GIT_MARKETPLACE repository');
    const branch = normalizeMarketplaceBranch(source.branch);
    return { url: normalizeMarketplaceAddress(source.url), ...(branch ? { branch } : {}) };
  });
}

/** User source preferences are durable; Git clones are reconstructible caches. */
export class GitMarketplaceSources {
  private state: SourceState | undefined;
  private serial: Promise<unknown> = Promise.resolve();
  private refreshing: Promise<GitMarketplaceSource[]> | undefined;
  private readonly failures = new Map<string, { checkedAt: number; error: string }>();
  private readonly fixed: Array<{ url: string; branch?: string; origin: 'official' | 'environment' }>;

  constructor(private readonly options: GitMarketplaceSourcesOptions) {
    // Official discovery already uses the machine catalog and npm admission.
    // An explicit officialUrl is only a composed Git source (e.g. isolated tests).
    const fixed = [
      ...(options.officialUrl
        ? [{ url: normalizeMarketplaceAddress(options.officialUrl), origin: 'official' as const }]
        : []),
      ...environmentSources(options.environment).map((source) => ({ ...source, origin: 'environment' as const })),
    ];
    const seen = new Set<string>();
    this.fixed = fixed.filter((source) => {
      const id = marketplaceSourceId(source.url, 'branch' in source ? source.branch : undefined);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  list(): Promise<GitMarketplaceSource[]> {
    return this.exclusive(async () => this.project(await this.load()));
  }

  async catalogs(): Promise<Array<{ source: GitMarketplaceSource; catalog: unknown }>> {
    return this.exclusive(async () => {
      const state = await this.load();
      return this.project(state).flatMap((source) => {
        const catalog = state.catalogs[source.id];
        return catalog ? [{ source, catalog: catalog.catalog }] : [];
      });
    });
  }

  async add(value: string, branchValue?: string): Promise<GitMarketplaceSource[]> {
    const url = normalizeMarketplaceAddress(value);
    const branch = normalizeMarketplaceBranch(branchValue);
    const id = marketplaceSourceId(url, branch);
    return this.exclusive(async () => {
      if (this.project(await this.load()).some((source) => source.id === id))
        throw new Error('Marketplace already configured');
      const catalog = await this.options.repository.refresh(url, branch, this.options.validateCatalog);
      if (!this.options.validateCatalog(catalog.catalog)) throw new Error('Invalid plugin repository');
      const state = await this.load();
      if (!this.project(state).some((source) => source.id === id)) {
        await this.persist({
          ...state,
          repositories: [...state.repositories, { url, ...(branch ? { branch } : {}) }],
          catalogs: {
            ...state.catalogs,
            [id]: { ...catalog, checkedAt: (this.options.now ?? Date.now)() },
          },
        });
      }
      return this.project(await this.load());
    });
  }

  remove(id: string): Promise<GitMarketplaceSource[]> {
    return this.exclusive(async () => {
      const state = await this.load();
      if (this.fixed.some((source) => marketplaceSourceId(source.url, source.branch) === id)) {
        throw new Error('This source is supplied by the Host configuration');
      }
      // Only this source's reconstructible clone and cached catalog are removed.
      const source = state.repositories.find((source) => marketplaceSourceId(source.url, source.branch) === id);
      if (!source) return this.project(state);
      await this.options.repository.remove(source.url, source.branch);
      const catalogs = { ...state.catalogs };
      delete catalogs[id];
      this.failures.delete(id);
      await this.persist({
        ...state,
        repositories: state.repositories.filter((source) => marketplaceSourceId(source.url, source.branch) !== id),
        catalogs,
      });
      return this.project(await this.load());
    });
  }

  refresh(): Promise<GitMarketplaceSource[]> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.synchronize().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async synchronize(): Promise<GitMarketplaceSource[]> {
    return this.exclusive(async () => {
      const sources = this.project(await this.load());
      const results = await Promise.all(
        sources.map(async (source) => {
          const checkedAt = (this.options.now ?? Date.now)();
          try {
            const catalog = await this.options.repository.refresh(
              source.url,
              source.branch,
              this.options.validateCatalog,
            );
            if (!this.options.validateCatalog(catalog.catalog)) throw new Error('invalid catalog');
            return { id: source.id, catalog: { ...catalog, checkedAt } };
          } catch {
            return { id: source.id, failure: { checkedAt, error: '插件仓同步失败，保留上次可用目录。' } };
          }
        }),
      );
      const state = await this.load();
      const catalogs = { ...state.catalogs };
      const active = new Set(this.project(state).map((source) => source.id));
      for (const result of results) {
        if (!active.has(result.id)) continue;
        if (result.catalog) {
          catalogs[result.id] = result.catalog;
          this.failures.delete(result.id);
        } else if (result.failure) this.failures.set(result.id, result.failure);
      }
      await this.persist({ ...state, catalogs });
      return this.project(await this.load());
    });
  }

  private project(state: SourceState): GitMarketplaceSource[] {
    const fixed = new Set(this.fixed.map((source) => marketplaceSourceId(source.url, source.branch)));
    return [
      ...this.fixed,
      ...state.repositories
        .filter((source) => !fixed.has(marketplaceSourceId(source.url, source.branch)))
        .map((source) => ({ ...source, origin: 'user' as const })),
    ].map((source) => {
      const id = marketplaceSourceId(source.url, source.branch);
      const catalog = state.catalogs[id];
      const failure = this.failures.get(id);
      return {
        ...source,
        id,
        status: failure ? 'error' : catalog ? 'ready' : 'pending',
        pluginCount:
          catalog &&
          typeof catalog.catalog === 'object' &&
          catalog.catalog !== null &&
          'plugins' in catalog.catalog &&
          Array.isArray(catalog.catalog.plugins)
            ? catalog.catalog.plugins.length
            : 0,
        checkedAt: failure?.checkedAt ?? catalog?.checkedAt ?? null,
        ...(catalog ? { commit: catalog.commit } : {}),
        ...(failure ? { error: failure.error } : {}),
      };
    });
  }

  private async load(): Promise<SourceState> {
    if (this.state) return this.state;
    try {
      const state = JSON.parse(await readFile(this.options.path, 'utf8')) as SourceState;
      if (
        !Array.isArray(state.repositories) ||
        state.repositories.some(
          (source) =>
            !source ||
            typeof source.url !== 'string' ||
            (source.branch !== undefined && typeof source.branch !== 'string'),
        ) ||
        !state.catalogs ||
        typeof state.catalogs !== 'object'
      ) {
        throw new Error('Invalid persisted marketplace sources');
      }
      this.state = {
        repositories: state.repositories.map((source) => ({
          url: normalizeMarketplaceAddress(source.url),
          ...(source.branch ? { branch: normalizeMarketplaceBranch(source.branch) } : {}),
        })),
        catalogs: state.catalogs,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.state = { repositories: [], catalogs: {} };
    }
    return this.state;
  }

  private async persist(state: SourceState): Promise<void> {
    await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.options.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.options.path);
      this.state = state;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.catch(() => undefined).then(operation);
    this.serial = result;
    return result;
  }
}
