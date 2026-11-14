import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { activateDeclaredMcp } from '../dist/domains/plugin/declared/declared-mcp-resources.js';
import {
  FilesystemBuiltinPluginPackageMaterializer,
  HostInventoryControlPlane,
  LocalPluginPackageAdmission,
  MemoryPluginInventoryStore,
} from '../dist/domains/plugin/index.js';

const execFileAsync = promisify(execFile);
const packageName = '@clowder-ai/closure-fixture';
const dependencyName = 'closed-dependency-fixture';

async function writeDependency(root, value) {
  const directory = join(root, 'node_modules', dependencyName);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ name: dependencyName, version: '1.0.0', type: 'module', exports: './index.js' }),
  );
  await writeFile(join(directory, 'index.js'), `export default ${JSON.stringify(value)};\n`);
}

async function archive(root, shipped) {
  const directory = join(root, 'package');
  await mkdir(join(directory, 'dist'), { recursive: true });
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({
      pluginId: 'dev.clowder.closure-fixture',
      version: '1.0.0',
      contractVersion: '0.1.0',
      name: 'Closure fixture',
      features: [
        { id: 'main', name: 'Main', resources: [], capabilities: [], contributions: [{ type: 'mcp', id: 'mcp' }] },
      ],
      contributions: [{ type: 'mcp', id: 'mcp', runtime: { transport: 'stdio', entrypoint: 'dist/mcp.js' } }],
    }),
  );
  const dependencies = { [dependencyName]: '1.0.0' };
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ name: packageName, version: '1.0.0', type: 'module', dependencies }),
  );
  await writeFile(
    join(directory, 'npm-shrinkwrap.json'),
    JSON.stringify({
      name: packageName,
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': { name: packageName, version: '1.0.0', dependencies },
        [`node_modules/${dependencyName}`]: {
          version: '1.0.0',
          resolved: `https://registry.npmjs.org/${dependencyName}/-/${dependencyName}-1.0.0.tgz`,
          integrity: `sha512-${Buffer.alloc(64, 3).toString('base64')}`,
        },
      },
    }),
  );
  await writeFile(join(directory, 'dist/mcp.js'), `import value from '${dependencyName}'; console.log(value);\n`);
  if (shipped) await writeDependency(directory, 'shipped archive dependency');
  const path = join(root, 'fixture.tgz');
  await execFileAsync('tar', ['czf', path, '-C', root, 'package']);
  return path;
}

// Real archive admission, integrity verification, materialization, stable MCP
// staging and launch descriptor. Only registry installation is an offline fixture.
// Before the fix the shipped case copied two dependency trees and threw EEXIST.
for (const shipped of [true, false]) {
  test(`declared MCP uses the Host-admitted ${shipped ? 'shipped' : 'materialized'} archive closure`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'declared-mcp-package-closure-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = await archive(root, shipped);
    const sourceBytes = await readFile(path);
    const packagesRoot = join(root, 'verified-packages');
    const store = new MemoryPluginInventoryStore();
    const inventory = new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_closure_fixture' });
    const installed = await new LocalPluginPackageAdmission({ inventory, packagesRoot }).install({
      kind: 'local-archive',
      path,
    });
    const admission = await store.readAuthority(installed.pluginInstanceId);
    assert.ok(admission);
    assert.equal(admission.packageRecord.provenance.dependencyClosure, shipped ? 'shipped' : 'materialized');
    const before = await store.snapshot();
    let installs = 0;
    const materializer = new FilesystemBuiltinPluginPackageMaterializer({
      packagesRoot,
      installDependencies: async ({ cwd }) => {
        installs++;
        await writeDependency(cwd, 'publisher-locked dependency');
      },
    });
    const launches = await activateDeclaredMcp(admission, {
      projectRoot: root,
      resourcesRoot: join(root, 'resources'),
      persistCapabilities: false,
      mcpConfigIO: {},
      packages: {
        resolveInstalledPackage: async () => assert.fail('named archive must use its verified materializer'),
      },
      mcpPackages: materializer,
      configuration: { readConfig: async () => undefined, readSecret: async () => undefined },
    });
    assert.equal(installs, shipped ? 0 : 1);
    assert.equal(launches.length, 1);
    const { server } = launches[0];
    const { stdout } = await execFileAsync(server.command, server.args, {
      cwd: server.workingDirectory,
      env: { ...process.env, ...server.env },
      timeout: 10_000,
    });
    assert.equal(stdout.trim(), shipped ? 'shipped archive dependency' : 'publisher-locked dependency');
    assert.deepEqual(await store.snapshot(), before, 'MCP staging cannot rewrite admitted package authority');
    assert.deepEqual(await readFile(path), sourceBytes, 'MCP staging leaves the admitted source archive intact');
  });
}
