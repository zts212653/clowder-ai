import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { GitMarketplaceRepository } from '../src/domains/plugin/manager/marketplace/git-marketplace-repository.js';
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

test('source settings survive restart; refresh failure retains metadata; remove does not remove the checkout', async (t) => {
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
});

test('a checked user repository persists across restart and removal only hides its candidates', async (t) => {
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
  assert.equal(
    (await f.repository.readMetadata(f.url, f.firstCommit, 'packages/demo/plugin.yaml')).toString(),
    'pluginId: example.demo\nversion: 1.0.0\n',
  );
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
