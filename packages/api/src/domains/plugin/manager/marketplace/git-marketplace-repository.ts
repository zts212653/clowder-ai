import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { parseDocument } from 'yaml';

const exec = promisify(execFile);
const MAX_CATALOG_BYTES = 256 * 1024;

export const OFFICIAL_PLUGIN_MARKETPLACE = 'https://github.com/zts212653/clowder-ai-plugins.git';

export interface GitMarketplacePackage {
  readonly path: string;
  readonly manifest: unknown;
  readonly package: { name: string; version: string };
}
export interface GitMarketplaceSnapshot {
  readonly commit: string;
  readonly catalog: { plugins: GitMarketplacePackage[] };
}

export function marketplaceSourceId(url: string, branch?: string): string {
  return createHash('sha256')
    .update(branch ? `${url}\0${branch}` : url)
    .digest('hex')
    .slice(0, 24);
}

export function normalizeMarketplaceAddress(value: string): string {
  const address = value.trim();
  if (!address || address.length > 4096 || /[\s\x00-\x1f\x7f]/.test(address) || address.startsWith('-')) {
    throw new Error('Invalid Git marketplace address');
  }
  // Git's scp spelling is common for enterprise hosts. It is an argument to
  // execFile, never shell text; arbitrary Git remote helpers are not accepted.
  if (/^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+:[^/].*$/.test(address)) return address;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error('Invalid Git marketplace address');
  }
  if (
    !['https:', 'ssh:', 'file:'].includes(url.protocol) ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol === 'https:' && url.username) ||
    (url.protocol !== 'file:' && !url.hostname)
  )
    throw new Error('Invalid Git marketplace address');
  return url.href;
}

export function normalizeMarketplaceBranch(value?: string): string | undefined {
  const branch = value?.trim();
  if (!branch) return undefined;
  if (
    branch.length > 255 ||
    branch === '@' ||
    branch.startsWith('-') ||
    /[\s\x00-\x1f\x7f~^:?*[\\]/.test(branch) ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))
  ) {
    throw new Error('Invalid Git marketplace branch');
  }
  return branch;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  // Retain the user's credential helpers, SSH agent and URL rewrites. Only
  // discard inherited repository redirection from the parent checkout.
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ]) {
    delete env[key];
  }
  return env;
}

function assertRepositoryPath(path: string): void {
  if (
    !path ||
    path.length > 4096 ||
    /[\\:\x00-\x1f\x7f]/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Invalid marketplace artifact path');
  }
}

export class GitMarketplaceRepository {
  private readonly refreshing = new Map<string, Promise<GitMarketplaceSnapshot>>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(readonly options: { cacheRoot: string; gitBin?: string; timeoutMs?: number }) {}

  async refresh(
    value: string,
    branchValue?: string,
    validateCatalog: (value: unknown) => boolean = () => true,
  ): Promise<GitMarketplaceSnapshot> {
    const url = normalizeMarketplaceAddress(value);
    const branch = normalizeMarketplaceBranch(branchValue);
    const id = marketplaceSourceId(url, branch);
    const pending = this.refreshing.get(id);
    if (pending) return pending;
    const operation = this.exclusive(id, () => this.synchronize(url, branch, validateCatalog)).finally(() =>
      this.refreshing.delete(id),
    );
    this.refreshing.set(id, operation);
    return operation;
  }

  async readMetadata(url: string, commit: string, path: string, branch?: string): Promise<Buffer> {
    const address = normalizeMarketplaceAddress(url);
    return this.exclusive(marketplaceSourceId(address, branch), () =>
      this.readBlob(this.directory(address, branch), commit, path, MAX_CATALOG_BYTES),
    );
  }

  async readOptionalMetadata(url: string, commit: string, path: string, branch?: string): Promise<Buffer | undefined> {
    assertRepositoryPath(path);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error('Invalid marketplace commit');
    const address = normalizeMarketplaceAddress(url);
    return this.exclusive(marketplaceSourceId(address, branch), async () => {
      const directory = this.directory(address, branch);
      const entry = await this.git(directory, ['ls-tree', '-z', commit, '--', path]);
      if (!entry.length) return undefined;
      return this.readBlob(directory, commit, path, MAX_CATALOG_BYTES);
    });
  }

  async withDirectory<T>(
    value: string,
    commit: string,
    path: string,
    consume: (directory: string, root: string) => Promise<T>,
    branch?: string,
  ): Promise<T> {
    const url = normalizeMarketplaceAddress(value);
    if (!/^packages\/[a-z0-9-]+$/.test(path)) throw new Error('Invalid marketplace package path');
    return this.exclusive(marketplaceSourceId(url, branch), async () => {
      const root = this.directory(url, branch);
      const current = (await this.git(root, ['rev-parse', '--verify', 'HEAD'])).toString().trim();
      if (current !== commit) throw new Error('Marketplace changed; reload the plugin list');
      const directory = join(root, path);
      const suffix = relative(await realpath(root), await realpath(directory));
      if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
        throw new Error('Invalid marketplace package path');
      }
      return consume(directory, root);
    });
  }

  private exclusive<T>(url: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(url) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.queues.set(url, result);
    void result
      .finally(() => {
        if (this.queues.get(url) === result) this.queues.delete(url);
      })
      .catch(() => undefined);
    return result;
  }

  private directory(url: string, branch?: string): string {
    return join(this.options.cacheRoot, marketplaceSourceId(url, branch));
  }

  private async git(cwd: string, args: string[], maxBuffer = MAX_CATALOG_BYTES): Promise<Buffer> {
    const result = await exec(this.options.gitBin ?? 'git', args, {
      cwd,
      env: gitEnvironment(),
      encoding: 'buffer',
      windowsHide: true,
      timeout: this.options.timeoutMs ?? 30_000,
      maxBuffer,
    });
    return result.stdout;
  }

  async remove(value: string, branchValue?: string): Promise<void> {
    const url = normalizeMarketplaceAddress(value);
    const branch = normalizeMarketplaceBranch(branchValue);
    await this.exclusive(marketplaceSourceId(url, branch), () =>
      rm(this.directory(url, branch), { recursive: true, force: true }),
    );
  }

  private async synchronize(
    url: string,
    branch: string | undefined,
    validateCatalog: (value: unknown) => boolean,
  ): Promise<GitMarketplaceSnapshot> {
    await mkdir(this.options.cacheRoot, { recursive: true, mode: 0o700 });
    const directory = this.directory(url, branch);
    const exists = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    let selectedBranch = branch;
    if (exists) {
      if (!exists.isDirectory() || exists.isSymbolicLink()) throw new Error('Invalid marketplace cache directory');
      const origin = (await this.git(directory, ['remote', 'get-url', 'origin'])).toString().trim();
      if (origin !== url) throw new Error('Marketplace cache origin changed');
      const currentBranch = (await this.git(directory, ['symbolic-ref', '--short', 'HEAD'])).toString().trim();
      if (branch && currentBranch !== branch) throw new Error('Marketplace cache branch changed');
      selectedBranch = currentBranch;
      const remote = (await this.git(directory, ['ls-remote', '--exit-code', '--', url, `refs/heads/${currentBranch}`]))
        .toString()
        .trim()
        .split(/\s+/)[0];
      const current = (await this.git(directory, ['rev-parse', '--verify', 'HEAD'])).toString().trim();
      if (remote === current) {
        const snapshot = await this.snapshot(directory);
        if (!validateCatalog(snapshot.catalog)) throw new Error('Invalid plugin repository');
        return snapshot;
      }
    }
    // A clone is a rebuildable cache, not an author checkout. Validate the next
    // tree before switching, whether the remote fast-forwards or rewrites history.
    const staging = await mkdtemp(join(this.options.cacheRoot, '.clone-'));
    const previous = join(staging, 'previous');
    let preservePrevious = false;
    try {
      const cloned = join(staging, 'repository');
      await this.git(staging, [
        'clone',
        '--no-tags',
        ...(selectedBranch ? ['--branch', selectedBranch] : []),
        '--single-branch',
        '--no-recurse-submodules',
        '--',
        url,
        cloned,
      ]);
      if (
        selectedBranch &&
        (await this.git(cloned, ['symbolic-ref', '--short', 'HEAD'])).toString().trim() !== selectedBranch
      )
        throw new Error('Marketplace selection must be a branch');
      const snapshot = await this.snapshot(cloned);
      if (!validateCatalog(snapshot.catalog)) throw new Error('Invalid plugin repository');
      if (exists) {
        await rename(directory, previous);
        preservePrevious = true;
      }
      try {
        await rename(cloned, directory);
      } catch (error) {
        if (exists) await rename(previous, directory);
        preservePrevious = false;
        throw error;
      }
      preservePrevious = false;
      return snapshot;
    } finally {
      // If rollback itself fails, retain the last-good tree for recovery.
      // Cleanup cannot turn an already committed cache switch into a failed refresh.
      if (!preservePrevious) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async snapshot(directory: string): Promise<GitMarketplaceSnapshot> {
    const commit = (await this.git(directory, ['rev-parse', '--verify', 'HEAD'])).toString().trim();
    const tree = (
      await this.git(directory, ['ls-tree', '-r', '--name-only', '-z', commit, '--', 'packages'], 4 * 1024 * 1024)
    ).toString('utf8');
    const manifests = tree.split('\0').filter((path) => /^packages\/[a-z0-9-]+\/plugin.yaml$/.test(path));
    if (!manifests.length || manifests.length > 256)
      throw new Error('No supported plugin directories in this repository');
    const plugins: GitMarketplacePackage[] = [];
    for (const path of manifests) {
      const bytes = await this.readBlob(directory, commit, path, MAX_CATALOG_BYTES);
      const document = parseDocument(bytes.toString('utf8'), { uniqueKeys: true });
      if (document.errors.length) throw new Error('Invalid plugin manifest in repository');
      const manifest: unknown = document.toJS({ maxAliasCount: 0 });
      const packagePath = path.slice(0, -'/plugin.yaml'.length);
      const pkg = JSON.parse(
        (await this.readBlob(directory, commit, `${packagePath}/package.json`, MAX_CATALOG_BYTES)).toString('utf8'),
      );
      if (!pkg || typeof pkg.name !== 'string' || typeof pkg.version !== 'string')
        throw new Error('Invalid plugin package metadata');
      plugins.push({ path: packagePath, manifest, package: { name: pkg.name, version: pkg.version } });
    }
    return { commit, catalog: { plugins } };
  }

  private async readBlob(directory: string, commit: string, path: string, maxBytes: number): Promise<Buffer> {
    assertRepositoryPath(path);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error('Invalid marketplace commit');
    const entry = (await this.git(directory, ['ls-tree', '-z', commit, '--', path])).toString('utf8');
    const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t([^\x00]+)\x00$/.exec(entry);
    if (!match || match[3] !== path) throw new Error('Marketplace artifact path is not a regular tracked file');
    const size = Number((await this.git(directory, ['cat-file', '-s', match[2]])).toString().trim());
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes)
      throw new Error('Marketplace file exceeds size limit');
    return this.git(directory, ['cat-file', 'blob', match[2]], maxBytes);
  }
}
