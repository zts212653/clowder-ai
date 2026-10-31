import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { resolveCompanionArchiveContract } from '../dist/domains/plugin/desktop-window-runtime/published-companion-v2.js';
import { createHostOfficialPluginCatalog } from '../dist/domains/plugin/manager/host-official-catalog.js';
import { OFFICIAL_BUNDLED_MANIFESTS, OFFICIAL_PLUGIN_CATALOG } from '../dist/domains/plugin/official-catalog.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/runtime-composition.js';
import { sessionAuthPlugin, sessionRoute } from '../dist/infrastructure/session-auth.js';
import { registerPluginManagerRoutes } from '../dist/routes/plugin-manager-routes.js';
import { desktopWindowManifest, windowHtml } from './f317-window-manifest.fixture.js';

// Exact Companion rows (alpha.25/.24) from public b06ce75fc421c42579b0d930133d86e4909fac6b.
const frozenCatalog = JSON.parse(
  await readFile(new URL('./fixtures/f317-manager-companion-catalog.json', import.meta.url), 'utf8'),
);
const sri = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
export const publishedLetterContract = (version) =>
  version === '0.1.0-alpha.24'
    ? '0.1.0-beta.27'
    : ['0.1.0-alpha.30', '0.1.0-alpha.31', '0.1.0-alpha.32'].includes(version)
      ? '0.1.0-beta.29'
      : '0.1.0-beta.28';

export async function managerEntryFixture(
  t,
  {
    corrupt = false,
    catalogData = frozenCatalog,
    latestVersion = '0.1.0-alpha.25',
    previousVersion = '0.1.0-alpha.24',
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'f317-manager-entry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const raw = structuredClone(catalogData);
  const plugin = raw.plugins[0];
  const archives = new Map();
  const archivePaths = {
    '0.1.0-alpha.24': process.env.F317_VERIFIED_PRESENTATION_ARCHIVE,
    '0.1.0-alpha.25': process.env.F317_VERIFIED_LETTER_ARCHIVE,
    '0.1.0-alpha.26': process.env.F317_VERIFIED_ALPHA26_ARCHIVE,
    '0.1.0-alpha.27': process.env.F317_VERIFIED_ALPHA27_ARCHIVE,
    '0.1.0-alpha.28': process.env.F317_VERIFIED_ALPHA28_ARCHIVE,
    '0.1.0-alpha.29': process.env.F317_VERIFIED_ALPHA29_ARCHIVE,
    '0.1.0-alpha.30': process.env.F317_VERIFIED_ALPHA30_ARCHIVE,
    '0.1.0-alpha.31': process.env.F317_VERIFIED_ALPHA31_ARCHIVE,
    '0.1.0-alpha.32': process.env.F317_VERIFIED_ALPHA32_ARCHIVE,
  };
  const actual = plugin.versions.every((release) => Boolean(archivePaths[release.version]));
  for (const release of plugin.versions) {
    const archivePath = archivePaths[release.version];
    let bytes;
    if (actual) {
      bytes = await readFile(archivePath);
      assert.equal(sri(bytes), release.artifact.integrity, 'registry bytes match frozen public discovery');
    } else {
      const source = join(root, release.version);
      const manifest = {
        ...desktopWindowManifest(windowHtml),
        pluginId: plugin.pluginId,
        version: release.version,
        name: plugin.name,
        description: plugin.description,
        icon: plugin.icon,
      };
      const contract = publishedLetterContract(release.version);
      manifest.contributions[0].bridgeVersion =
        contract === '0.1.0-beta.29' ? '1.6.0' : contract === '0.1.0-beta.28' ? '1.5.0' : '1.4.0';
      await mkdir(join(source, 'package/renderer/skins'), { recursive: true });
      await writeFile(join(source, 'package/manifest.json'), JSON.stringify(manifest));
      await writeFile(join(source, 'package/renderer/index.html'), windowHtml);
      await writeFile(join(source, 'package', plugin.icon.src), Buffer.from('fixture image'));
      await promisify(execFile)('tar', ['czf', join(source, 'package.tgz'), '-C', source, 'package']);
      bytes = await readFile(join(source, 'package.tgz'));
      release.artifact.integrity = sri(bytes);
      release.artifact.shasum = createHash('sha1').update(bytes).digest('hex');
    }
    archives.set(release.version, bytes);
  }
  const companionArchives = plugin.versions.map((release) => ({
    version: release.version,
    packageDigest: release.artifact.integrity,
    contract: publishedLetterContract(release.version),
  }));
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot: root,
    messageStore: new MessageStore(),
    ...(actual ? {} : { companionArchives }),
    desktopExecutor: { open: async () => assert.fail('discovery/install/update must not open a window') },
  });
  t.after(() => runtime.shutdown());
  let oldRelease = false;
  const catalog = createHostOfficialPluginCatalog(async () => {
    const selected = structuredClone(raw);
    if (oldRelease)
      selected.plugins[0].versions = selected.plugins[0].versions.filter(
        (release) => release.version === previousVersion,
      );
    return selected;
  });
  const base = OFFICIAL_PLUGIN_CATALOG.find((row) => row.pluginId === plugin.pluginId);
  assert.ok(base);
  const releaseEntry = () => {
    const release = plugin.versions.find((row) => row.version === (oldRelease ? previousVersion : latestVersion));
    return {
      ...base,
      catalogId: plugin.pluginId,
      version: release.version,
      archiveUrl: release.artifact.tarballUrl,
      packageDigest: release.artifact.integrity,
    };
  };
  const downloads = [];
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: catalog,
    catalogManifests: OFFICIAL_BUNDLED_MANIFESTS,
    prepareDesktopComponent: async () => {},
    fetchOfficialArchive: async (entry) => {
      downloads.push(entry.version);
      const bytes = archives.get(entry.version);
      assert.ok(bytes);
      return corrupt ? Buffer.concat([bytes, Buffer.from('tampered')]) : bytes;
    },
  });
  const app = Fastify();
  t.after(() => app.close());
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: process.env.DEFAULT_OWNER_USER_ID ?? 'default-user' });
  registerPluginManagerRoutes(app, { manager: composition.manager, auditLog: { append: async () => {} } });
  const session = await app.inject({ method: 'GET', url: '/api/session', remoteAddress: '127.0.0.1' });
  assert.equal(session.statusCode, 200);
  const headers = {
    cookie: session.cookies.map((row) => `${row.name}=${row.value}`).join('; '),
    host: 'localhost:3512',
    origin: 'http://localhost:3511',
    'x-csrf-token': session.json().csrfToken,
  };
  const request = (method, url, payload) => app.inject({ method, url, payload, headers, remoteAddress: '127.0.0.1' });
  const assertVersion = async (version) => {
    const snapshot = await runtime.inventoryStore.snapshot();
    const instance = snapshot.instances.find((row) => row.pluginId === plugin.pluginId);
    const pkg = snapshot.packages.find((row) => row.packageDigest === instance?.packageDigest);
    assert.equal(pkg?.version, version);
    assert.equal(
      resolveCompanionArchiveContract(pkg, actual ? undefined : companionArchives),
      publishedLetterContract(version),
    );
    assert.equal(instance.activationState, 'disabled');
    assert.equal(instance.runtimeState, 'stopped');
    return instance;
  };
  return {
    app,
    request,
    catalog,
    runtime,
    downloads,
    releaseEntry,
    assertVersion,
    setOld: async (value) => {
      oldRelease = value;
      await catalog.refresh();
    },
  };
}
