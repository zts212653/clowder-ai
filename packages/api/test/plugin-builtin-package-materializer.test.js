import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';

import {
  FilesystemBuiltinPluginPackageMaterializer,
  publishPluginPackageArchive,
} from '../dist/domains/plugin/index.js';

const execFileAsync = promisify(execFile);
const roots = [];

after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function archivedPackage({
  dependencies = { zod: '4.4.3' },
  includeShrinkwrap = true,
  dependencyRegistry = 'https://registry.npmjs.org/',
  lockfileVersion = 3,
} = {}) {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-f202-builtin-source-'));
  roots.push(sourceRoot);
  const packageRoot = join(sourceRoot, 'package');
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await writeFile(
    join(packageRoot, 'package.json'),
    `${JSON.stringify({
      name: '@clowder-ai/video-analysis',
      version: '0.1.0-alpha.0',
      type: 'module',
      dependencies,
    })}\n`,
  );
  if (includeShrinkwrap) {
    const packages = {
      '': {
        name: '@clowder-ai/video-analysis',
        version: '0.1.0-alpha.0',
        dependencies,
      },
    };
    for (const [name, version] of Object.entries(dependencies)) {
      packages[`node_modules/${name}`] = {
        version,
        resolved: `${dependencyRegistry}${name}/-/${name.split('/').at(-1)}-${version}.tgz`,
        integrity: `sha512-${Buffer.alloc(64, 3).toString('base64')}`,
      };
    }
    await writeFile(
      join(packageRoot, 'npm-shrinkwrap.json'),
      `${JSON.stringify({
        name: '@clowder-ai/video-analysis',
        version: '0.1.0-alpha.0',
        lockfileVersion,
        requires: true,
        packages,
      })}\n`,
    );
  }
  await writeFile(
    join(packageRoot, 'plugin.yaml'),
    [
      'pluginId: dev.clowder.video-analysis',
      'version: 0.1.0-alpha.0',
      'contractVersion: 0.1.0',
      'name: Video Analysis',
      'features:',
      '  - id: analyze-video',
      '    name: Analyze video',
      '    resources: []',
      '    capabilities: []',
      'runtime:',
      '  transport: builtin',
      '',
    ].join('\n'),
  );
  await writeFile(join(packageRoot, 'dist/mcp-entrypoint.js'), '// fixture\n');
  const archivePath = join(sourceRoot, 'package.tgz');
  await execFileAsync('tar', ['czf', archivePath, '-C', sourceRoot, 'package']);
  const bytes = await readFile(archivePath);
  const digest = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  return { bytes, digest };
}

test('materializes a verified builtin package with a closed, script-free npm dependency install', async () => {
  const packagesRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-f202-builtin-cache-'));
  roots.push(packagesRoot);
  const archive = await archivedPackage();
  await publishPluginPackageArchive(packagesRoot, archive.digest, archive.bytes);
  const installs = [];
  const materializer = new FilesystemBuiltinPluginPackageMaterializer({
    packagesRoot,
    installDependencies: async (input) => {
      installs.push(structuredClone(input));
      await mkdir(join(input.cwd, 'node_modules', 'zod'), { recursive: true });
      await writeFile(join(input.cwd, 'node_modules', 'zod', 'package.json'), '{"version":"4.4.3"}\n');
    },
  });

  const materialized = await materializer.resolve({
    pluginInstanceId: 'pi_video',
    pluginId: 'dev.clowder.video-analysis',
    packageDigest: archive.digest,
    packageName: '@clowder-ai/video-analysis',
  });

  assert.equal(installs.length, 1);
  assert.deepEqual(installs[0].dependencies, { zod: '4.4.3' });
  assert.equal(installs[0].env.HOME.startsWith(installs[0].cwd), true);
  assert.equal(installs[0].env.npm_config_ignore_scripts, 'true');
  assert.equal(installs[0].env.npm_config_registry, 'https://registry.npmjs.org/');
  assert.equal('NPM_TOKEN' in installs[0].env, false);
  assert.equal(JSON.parse(await readFile(join(installs[0].cwd, 'npm-shrinkwrap.json'), 'utf8')).lockfileVersion, 3);
  assert.deepEqual(JSON.parse(await readFile(join(installs[0].cwd, 'package.json'), 'utf8')).dependencies, {
    zod: '4.4.3',
  });
  assert.equal((await stat(join(materialized.rootDir, 'dist/mcp-entrypoint.js'))).isFile(), true);
  await materialized.verifyIntegrity();

  const rootDir = materialized.rootDir;
  await materialized.release();
  await assert.rejects(stat(rootDir), (error) => error?.code === 'ENOENT');
});

test('rejects non-registry dependency specs before invoking npm', async () => {
  const packagesRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-f202-builtin-reject-'));
  roots.push(packagesRoot);
  const archive = await archivedPackage({ dependencies: { unsafe: 'file:../outside' } });
  await publishPluginPackageArchive(packagesRoot, archive.digest, archive.bytes);
  let installs = 0;
  const materializer = new FilesystemBuiltinPluginPackageMaterializer({
    packagesRoot,
    installDependencies: async () => {
      installs += 1;
    },
  });

  await assert.rejects(
    materializer.resolve({
      pluginInstanceId: 'pi_video',
      pluginId: 'dev.clowder.video-analysis',
      packageDigest: archive.digest,
      packageName: '@clowder-ai/video-analysis',
    }),
    (error) => error?.code === 'UNSAFE_DEPENDENCY_SPEC',
  );
  assert.equal(installs, 0);
});

test('rejects a dependency-bearing runtime package without a publisher-owned shrinkwrap', async () => {
  const packagesRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-f202-builtin-unlocked-'));
  roots.push(packagesRoot);
  const archive = await archivedPackage({ includeShrinkwrap: false });
  await publishPluginPackageArchive(packagesRoot, archive.digest, archive.bytes);
  let installs = 0;
  const materializer = new FilesystemBuiltinPluginPackageMaterializer({
    packagesRoot,
    installDependencies: async () => {
      installs += 1;
    },
  });

  await assert.rejects(
    materializer.resolve({
      pluginInstanceId: 'pi_video',
      pluginId: 'dev.clowder.video-analysis',
      packageDigest: archive.digest,
      packageName: '@clowder-ai/video-analysis',
    }),
    (error) => error?.code === 'DEPENDENCY_LOCK_REQUIRED',
  );
  assert.equal(installs, 0);
});

test('rejects shrinkwrap entries that leave the canonical npm registry boundary', async () => {
  const packagesRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-f202-builtin-lock-origin-'));
  roots.push(packagesRoot);
  const archive = await archivedPackage({ dependencyRegistry: 'https://packages.example.invalid/' });
  await publishPluginPackageArchive(packagesRoot, archive.digest, archive.bytes);
  let installs = 0;
  const materializer = new FilesystemBuiltinPluginPackageMaterializer({
    packagesRoot,
    installDependencies: async () => {
      installs += 1;
    },
  });

  await assert.rejects(
    materializer.resolve({
      pluginInstanceId: 'pi_video',
      pluginId: 'dev.clowder.video-analysis',
      packageDigest: archive.digest,
      packageName: '@clowder-ai/video-analysis',
    }),
    (error) => error?.code === 'UNSAFE_DEPENDENCY_LOCK',
  );
  assert.equal(installs, 0);
});

test('rejects shrinkwrap entries whose host only prefixes the canonical registry hostname', async () => {
  const packagesRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-f202-builtin-lock-spoof-'));
  roots.push(packagesRoot);
  const archive = await archivedPackage({ dependencyRegistry: 'https://registry.npmjs.org.evil.invalid/' });
  await publishPluginPackageArchive(packagesRoot, archive.digest, archive.bytes);
  let installs = 0;
  const materializer = new FilesystemBuiltinPluginPackageMaterializer({
    packagesRoot,
    installDependencies: async () => {
      installs += 1;
    },
  });

  await assert.rejects(
    materializer.resolve({
      pluginInstanceId: 'pi_video',
      pluginId: 'dev.clowder.video-analysis',
      packageDigest: archive.digest,
      packageName: '@clowder-ai/video-analysis',
    }),
    (error) => error?.code === 'UNSAFE_DEPENDENCY_LOCK',
  );
  assert.equal(installs, 0);
});

test('rejects lockfile v2 instead of accepting its second unvalidated dependency tree', async () => {
  const packagesRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-f202-builtin-lock-v2-'));
  roots.push(packagesRoot);
  const archive = await archivedPackage({ lockfileVersion: 2 });
  await publishPluginPackageArchive(packagesRoot, archive.digest, archive.bytes);
  let installs = 0;
  const materializer = new FilesystemBuiltinPluginPackageMaterializer({
    packagesRoot,
    installDependencies: async () => {
      installs += 1;
    },
  });

  await assert.rejects(
    materializer.resolve({
      pluginInstanceId: 'pi_video',
      pluginId: 'dev.clowder.video-analysis',
      packageDigest: archive.digest,
      packageName: '@clowder-ai/video-analysis',
    }),
    (error) => error?.code === 'UNSAFE_DEPENDENCY_LOCK',
  );
  assert.equal(installs, 0);
});
