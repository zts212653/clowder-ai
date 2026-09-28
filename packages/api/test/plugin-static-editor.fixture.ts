import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PluginManifest } from '@clowder-ai/plugin-contract';
import { HostInventoryControlPlane } from '../src/domains/plugin/host-inventory/control-plane.js';
import { MemoryPluginInventoryStore } from '../src/domains/plugin/host-inventory/stores.js';
import { OfficialPluginPackageInstaller } from '../src/domains/plugin/official-package-installer.js';

const html = '<!doctype html><html><body>Static document editor</body></html>';
const integrity = 'sha256-' + createHash('sha256').update(html).digest('base64');

export function staticEditorManifest(): PluginManifest {
  return {
    pluginId: 'test.static-editor',
    version: '0.1.0-alpha.0',
    contractVersion: '0.1.0',
    name: 'Static editor',
    runtime: { transport: 'builtin' },
    features: [
      {
        id: 'edit',
        name: 'Edit',
        resources: [],
        capabilities: [],
        contributions: [{ type: 'content-editor-provider', id: 'docx' }],
      },
    ],
    contributions: [
      {
        type: 'content-editor-provider',
        id: 'docx',
        mediaTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
        surface: {
          entrypoint: 'renderer/index.html',
          integrity,
          sandbox: 'dedicated-origin-iframe',
          navigationPolicy: 'navigation-api-deny',
        },
        bridgeVersion: '1.0.0',
        operations: ['load', 'settle', 'comment', 'tracked-change'],
      },
    ],
  };
}

export async function staticEditorFixture(packageManifest: PluginManifest, body = html, worker?: string) {
  const root = await mkdtemp(join(tmpdir(), 'f309-static-admission-'));
  const source = join(root, 'package');
  await mkdir(join(source, 'renderer'), { recursive: true });
  await writeFile(join(source, 'manifest.json'), JSON.stringify(packageManifest));
  await writeFile(join(source, 'renderer/index.html'), body);
  if (worker !== undefined) await writeFile(join(source, 'renderer/worker.js'), worker);
  await promisify(execFile)('tar', ['czf', join(root, 'package.tgz'), '-C', root, 'package']);
  const bytes = await readFile(join(root, 'package.tgz'));
  const packageDigest = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store);
  const entry = {
    catalogId: 'static-editor',
    packageName: '@test/static-editor',
    pluginId: packageManifest.pluginId,
    version: packageManifest.version,
    distribution: 'registry' as const,
    archiveUrl: 'https://registry.npmjs.org/@test/static-editor/-/static-editor-0.1.0-alpha.0.tgz',
    packageDigest,
    effectiveGrants: [],
  };
  const installer = new OfficialPluginPackageInstaller({
    inventory,
    packagesRoot: join(root, 'cache'),
    catalog: [entry],
    fetchArchive: async () => bytes,
  });
  return {
    root,
    entry,
    bytes,
    store,
    install: () => installer.install(entry.catalogId, entry),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
