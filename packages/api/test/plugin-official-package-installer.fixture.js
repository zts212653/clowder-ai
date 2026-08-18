import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  HostInventoryControlPlane,
  MemoryPluginInventoryStore,
  OfficialPluginInstallError,
  OfficialPluginPackageInstaller,
} from '../dist/domains/plugin/index.js';

const execFileAsync = promisify(execFile);

export function manifest(overrides = {}) {
  return {
    pluginId: 'official.test-source',
    version: '0.1.0-alpha.1',
    contractVersion: '0.1.0',
    name: 'Official Test Source',
    features: [
      {
        id: 'source',
        name: 'Source',
        resources: [],
        capabilities: ['events.publish'],
      },
    ],
    signals: {
      provides: [
        {
          type: 'official.test.v1',
          schemaRef: 'schemas/official.test.v1.schema.json',
          epistemicStatus: 'observation',
          privacyClass: 'content-adjacent',
          sourceClass: 'remote-service',
        },
      ],
    },
    runtime: { transport: 'stdio', entrypoint: 'dist/entrypoint.js' },
    ...overrides,
  };
}

export async function packageArchive({ packageManifest = manifest(), includeSchema = true } = {}) {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-f292-official-package-'));
  const packageRoot = join(sourceRoot, 'package');
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await mkdir(join(packageRoot, 'schemas'), { recursive: true });
  await writeFile(join(packageRoot, 'manifest.json'), `${JSON.stringify(packageManifest)}\n`, 'utf8');
  await writeFile(join(packageRoot, 'dist/entrypoint.js'), '// official fixture\n', 'utf8');
  if (includeSchema) {
    await writeFile(
      join(packageRoot, 'schemas/official.test.v1.schema.json'),
      `${JSON.stringify({
        type: 'object',
        properties: { payload: { type: 'object' }, source: { type: 'object' } },
        required: ['payload', 'source'],
      })}\n`,
      'utf8',
    );
  }
  const archivePath = join(sourceRoot, 'package.tgz');
  await execFileAsync('tar', ['czf', archivePath, '-C', sourceRoot, 'package']);
  const bytes = await readFile(archivePath);
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  return { bytes, integrity };
}

export function catalogEntry(integrity, overrides = {}) {
  return {
    catalogId: 'feishu-meeting-intake',
    packageName: '@clowder-ai/official-test-source',
    version: '0.1.0-alpha.1',
    pluginId: 'official.test-source',
    archiveUrl: 'https://registry.npmjs.org/@clowder-ai/official-test-source/-/official-test-source-0.1.0-alpha.1.tgz',
    packageDigest: integrity,
    effectiveGrants: ['events.publish'],
    ...overrides,
  };
}

export function releaseFence(entry) {
  return { version: entry.version, packageDigest: entry.packageDigest };
}

export async function harness(archive, entry = catalogEntry(archive.integrity)) {
  const packagesRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-f292-official-cache-'));
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, {
    createInstanceId: () => 'pi_official',
    now: () => 10_000,
  });
  const installer = new OfficialPluginPackageInstaller({
    inventory,
    packagesRoot,
    catalog: [entry],
    fetchArchive: async () => archive.bytes,
  });
  return { packagesRoot, store, inventory, installer };
}

export function isInstallError(code) {
  return (error) => error instanceof OfficialPluginInstallError && error.code === code;
}
