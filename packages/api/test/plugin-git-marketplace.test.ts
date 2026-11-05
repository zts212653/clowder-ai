import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  GitMarketplaceRepository,
  marketplaceSourceId,
} from '../src/domains/plugin/manager/marketplace/git-marketplace-repository.js';
import { GitMarketplaceSources } from '../src/domains/plugin/manager/marketplace/git-marketplace-sources.js';

const exec = promisify(execFile);

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-marketplace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = join(root, 'upstream');
  await mkdir(join(upstream, 'catalog'), { recursive: true });
  await mkdir(join(upstream, 'packages/demo'), { recursive: true });
  const git = (...args: string[]) => exec('git', args, { cwd: upstream });
  await git('init', '--initial-branch=main');
  await git('config', 'user.name', 'Isolated marketplace test');
  await git('config', 'user.email', 'marketplace@example.invalid');
  const publish = async (version: string) => {
    await writeFile(join(upstream, 'catalog/catalog.json'), JSON.stringify({ schemaVersion: '1', version }));
    await writeFile(join(upstream, 'packages/demo/plugin.yaml'), `pluginId: example.demo\nversion: ${version}\n`);
    await writeFile(join(upstream, 'packages/demo/package.json'), JSON.stringify({ name: '@example/demo', version }));
    await git('add', '.');
    await git('commit', '-m', version);
    return (await git('rev-parse', 'HEAD')).stdout.trim();
  };
  const firstCommit = await publish('1.0.0');
  const repository = new GitMarketplaceRepository({ cacheRoot: join(root, 'cache') });
  return { root, upstream, git, publish, firstCommit, repository, url: pathToFileURL(upstream).href };
}

test('Git marketplace clones, pulls new metadata, and reads metadata at the selected commit', async (t) => {
  const f = await fixture(t);
  const first = await f.repository.refresh(f.url);
  assert.equal(first.commit, f.firstCommit);
  assert.equal(first.catalog.plugins[0].manifest.version, '1.0.0');
  const secondCommit = await f.publish('1.1.0');
  const [second, concurrent] = await Promise.all([f.repository.refresh(f.url), f.repository.refresh(f.url)]);
  assert.equal(second.commit, secondCommit);
  assert.deepEqual(concurrent, second);
  assert.equal(
    Buffer.from(await f.repository.readMetadata(f.url, first.commit, 'packages/demo/plugin.yaml')).toString(),
    'pluginId: example.demo\nversion: 1.0.0\n',
  );
  assert.equal(
    Buffer.from(await f.repository.readMetadata(f.url, second.commit, 'packages/demo/plugin.yaml')).toString(),
    'pluginId: example.demo\nversion: 1.1.0\n',
  );
  await assert.rejects(
    f.repository.withDirectory(f.url, first.commit, 'packages/demo', async () => true),
    /changed/,
  );
  assert.equal(
    await f.repository.withDirectory(f.url, second.commit, 'packages/demo', async (directory) =>
      readFile(join(directory, 'plugin.yaml'), 'utf8'),
    ),
    'pluginId: example.demo\nversion: 1.1.0\n',
  );
  assert.equal(
    await readFile(join(f.upstream, 'packages/demo/plugin.yaml'), 'utf8'),
    'pluginId: example.demo\nversion: 1.1.0\n',
  );
});

test('Git marketplace reads only ordinary tracked blobs inside the repository', async (t) => {
  const f = await fixture(t);
  const { commit } = await f.repository.refresh(f.url);
  for (const path of ['../secret', '/etc/passwd', 'artifacts/../catalog/catalog.json', 'C:\\secret', '']) {
    await assert.rejects(f.repository.readMetadata(f.url, commit, path), /path/i);
  }
  await assert.rejects(f.repository.readMetadata(f.url, 'HEAD', 'packages/demo/plugin.yaml'), /commit/i);
  await assert.rejects(f.repository.refresh('ext::sh -c injected'), /address/i);
});

test('source settings survive restart; refresh failure retains metadata and the usable checkout', async (t) => {
  const f = await fixture(t);
  const path = join(f.root, 'settings/sources.json');
  const options = {
    path,
    repository: f.repository,
    officialUrl: f.url,
    environment: JSON.stringify([f.url, pathToFileURL(join(f.root, 'missing-preset')).href]),
    validateCatalog: (raw: unknown) => !!raw && typeof raw === 'object' && 'plugins' in raw,
  };
  const sources = new GitMarketplaceSources(options);
  const list = await sources.list();
  assert.equal(list.length, 2);
  assert.deepEqual(
    list.map((source) => source.origin),
    ['official', 'environment'],
  );
  // An inaccessible preset must not erase a successful independent source.
  await sources.refresh();
  assert.equal((await sources.catalogs())[0]?.source.commit, f.firstCommit);
  const restarted = new GitMarketplaceSources(options);
  assert.equal((await restarted.catalogs())[0]?.source.commit, f.firstCommit);
  await assert.rejects(restarted.remove(list[0].id), /Host configuration/);
  await f.git('remote', 'add', 'unavailable-test', 'file:///not-present');
  await writeFile(join(f.upstream, 'packages/demo/package.json'), 'not-json');
  await f.git('add', '.');
  await f.git('commit', '-m', 'broken metadata');
  const afterFailure = await restarted.refresh();
  assert.equal(afterFailure[0].status, 'error');
  assert.equal((await restarted.catalogs())[0]?.source.commit, f.firstCommit);
  await f.repository.withDirectory(f.url, f.firstCommit, 'packages/demo', async (directory) => {
    assert.match(await readFile(join(directory, 'package.json'), 'utf8'), /1.0.0/);
  });
});

test('a checked user repository persists across restart and removal clears only its reconstructible cache', async (t) => {
  const f = await fixture(t);
  const options = {
    path: join(f.root, 'prefs.json'),
    repository: f.repository,
    officialUrl: pathToFileURL(join(f.root, 'unavailable-official')).href,
    validateCatalog: (value: unknown) => !!value && typeof value === 'object' && 'plugins' in value,
  };
  const sources = new GitMarketplaceSources(options);
  await assert.rejects(sources.add('file:///nonexistent-plugin-marketplace-test'));
  assert.equal((await sources.list()).length, 1);
  const added = await sources.add(f.url);
  assert.equal(added.length, 2);
  assert.equal(added[1].origin, 'user');
  const restarted = new GitMarketplaceSources(options);
  assert.equal((await restarted.catalogs())[0].source.commit, f.firstCommit);
  await restarted.remove(added[1].id);
  assert.equal((await restarted.catalogs()).length, 0);
  assert.equal((await new GitMarketplaceSources(options).list()).length, 1);
  await assert.rejects(access(join(f.root, 'cache', added[1].id)), { code: 'ENOENT' });
  assert.ok(await readFile(join(f.upstream, 'packages/demo/plugin.yaml')));
  assert.equal(JSON.parse(await readFile(options.path, 'utf8')).catalogs[added[1].id], undefined);
  await restarted.add(f.url);
  assert.equal((await restarted.catalogs())[0].source.commit, f.firstCommit);
});

test('one repository can track two branches independently across refresh and restart', async (t) => {
  const f = await fixture(t);
  await f.git('checkout', '-b', 'feature/plugin');
  const featureCommit = await f.publish('2.0.0');
  await f.git('checkout', 'main');
  const options = {
    path: join(f.root, 'branches.json'),
    repository: f.repository,
    validateCatalog: (value: unknown) => !!value && typeof value === 'object' && 'plugins' in value,
  };
  const sources = new GitMarketplaceSources(options);
  assert.equal(
    (await sources.list()).length,
    0,
    'official npm catalog must not be duplicated as a Git directory source',
  );
  await sources.add(f.url, 'main');
  await sources.add(f.url, 'feature/plugin');
  const restarted = new GitMarketplaceSources(options);
  const catalogs = await restarted.catalogs();
  assert.equal(catalogs.length, 2);
  assert.notEqual(catalogs[0].source.id, catalogs[1].source.id);
  assert.equal(catalogs[0].source.branch, 'main');
  assert.equal(catalogs[1].source.commit, featureCommit);
  await assert.rejects(restarted.add(f.url, 'main'), /already/i);
  await assert.rejects(restarted.add(f.url, '--upload-pack=bad'), /branch/i);
  const mainCommit = await f.publish('1.1.0');
  const refreshed = await restarted.refresh();
  assert.ok(refreshed.every((source) => source.status === 'ready'));
  assert.equal((await restarted.catalogs())[0].source.commit, mainCommit);
  assert.equal((await restarted.catalogs())[1].source.commit, featureCommit);
  const bytes = await f.repository.withDirectory(
    f.url,
    featureCommit,
    'packages/demo',
    (directory) => readFile(join(directory, 'plugin.yaml'), 'utf8'),
    'feature/plugin',
  );
  assert.match(bytes, /2.0.0/);
});

test('rewritten remote history refreshes a validated checkout without operator cache cleanup', async (t) => {
  const f = await fixture(t);
  const sources = new GitMarketplaceSources({
    path: join(f.root, 'prefs.json'),
    repository: f.repository,
    validateCatalog: (value) => !!value && typeof value === 'object' && 'plugins' in value,
  });
  await sources.add(f.url, 'main');
  await f.git('checkout', '--orphan', 'rewritten');
  const rewritten = await f.publish('2.0.0');
  await f.git('branch', '-M', 'main');
  const refreshed = await sources.refresh();
  assert.equal(refreshed[0].status, 'ready');
  assert.equal(refreshed[0].commit, rewritten);
  await f.repository.withDirectory(
    f.url,
    rewritten,
    'packages/demo',
    async (directory) => {
      assert.match(await readFile(join(directory, 'plugin.yaml'), 'utf8'), /2.0.0/);
    },
    'main',
  );
});

test('strict catalog rejection and network failure preserve the last installable checkout', async (t) => {
  const f = await fixture(t);
  const sources = new GitMarketplaceSources({
    path: join(f.root, 'prefs.json'),
    repository: f.repository,
    validateCatalog: (value) =>
      (value as { plugins: Array<{ package: { version: string } }> }).plugins.every(
        (p) => p.package.version === '1.0.0',
      ),
  });
  await sources.add(f.url);
  await f.publish('2.0.0');
  assert.equal((await sources.refresh())[0].status, 'error');
  await f.repository.withDirectory(f.url, f.firstCommit, 'packages/demo', async (directory) => {
    assert.match(await readFile(join(directory, 'package.json'), 'utf8'), /1.0.0/);
  });
  await rename(f.upstream, join(f.root, 'offline'));
  assert.equal((await sources.refresh())[0].status, 'error');
  assert.equal((await sources.catalogs())[0].source.commit, f.firstCommit);
  await f.repository.withDirectory(f.url, f.firstCommit, 'packages/demo', async () => true);
});

test('removing one branch leaves another branch cache and installed data untouched', async (t) => {
  const f = await fixture(t);
  await f.git('branch', 'other');
  const sources = new GitMarketplaceSources({
    path: join(f.root, 'prefs.json'),
    repository: f.repository,
    validateCatalog: () => true,
  });
  await sources.add(f.url, 'main');
  await sources.add(f.url, 'other');
  const data = join(f.root, 'installed/data');
  await mkdir(data, { recursive: true });
  await writeFile(join(data, 'message'), 'keep');
  await sources.remove(marketplaceSourceId(f.url, 'main'));
  await assert.rejects(access(join(f.root, 'cache', marketplaceSourceId(f.url, 'main'))), { code: 'ENOENT' });
  await access(join(f.root, 'cache', marketplaceSourceId(f.url, 'other')));
  assert.equal(await readFile(join(data, 'message'), 'utf8'), 'keep');
});
