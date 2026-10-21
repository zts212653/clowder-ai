import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  HostInventoryControlPlane,
  LocalPluginPackageAdmission,
  MemoryPluginInventoryStore,
  packageDirectoryName,
} from '../dist/domains/plugin/index.js';
import { manifest } from './plugin-official-package-installer.fixture.js';

// Build fixture bytes without tar so fixture creation cannot mask a consumer's
// drive-colon bug when the Windows lane places GNU tar first on PATH.
function archive(entries) {
  const blocks = entries.flatMap(([name, content]) => {
    const bytes = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    const octal = (value, width) => `${value.toString(8).padStart(width - 1, '0')}\0`;
    header.write(octal(0o644, 8), 100, 8);
    header.write(octal(0, 8), 108, 8);
    header.write(octal(0, 8), 116, 8);
    header.write(octal(bytes.length, 12), 124, 12);
    header.write(octal(0, 12), 136, 12);
    header.fill(0x20, 148, 156);
    header.write('0', 156);
    header.write('ustar\0', 257, 6);
    header.write('00', 263, 2);
    const sum = [...header].reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    return [header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)];
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

async function privateRoot(run) {
  const root = await mkdtemp(join(tmpdir(), 'plugin tar ; $literal '));
  try {
    // POSIX GNU tar also treats a colon-bearing archive operand as remote.
    const scoped = join(root, process.platform === 'win32' ? 'windows drive' : 'drive:operand');
    await mkdir(scoped);
    await run(scoped);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('local directory admission packages and verifies real bytes with the selected tar', async () => {
  await privateRoot(async (root) => {
    const source = join(root, 'source package');
    await mkdir(join(source, 'dist'), { recursive: true });
    await mkdir(join(source, 'schemas'));
    await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest()));
    const entrypoint = 'throw new Error("package admission must not execute this");\n';
    await writeFile(join(source, 'dist', 'entrypoint.js'), entrypoint);
    await writeFile(join(source, 'schemas', 'official.test.v1.schema.json'), JSON.stringify({ type: 'object' }));
    const packagesRoot = join(root, 'Host packages');
    const store = new MemoryPluginInventoryStore();
    const admission = new LocalPluginPackageAdmission({
      inventory: new HostInventoryControlPlane(store),
      packagesRoot,
      grantPolicy: () => ['messaging.send'],
    });

    const result = await admission.install({ kind: 'local-directory', path: source });

    assert.equal(result.pluginId, 'official.test-source');
    const snapshot = await store.snapshot();
    assert.equal(snapshot.instances.length, 1);
    assert.equal(snapshot.instances[0].runtimeState, 'stopped');
    assert.deepEqual(snapshot.grants[0].effectiveGrants, ['messaging.send']);
    const bytes = await readFile(join(packagesRoot, packageDirectoryName(result.packageDigest), 'package.tgz'));
    assert.equal(result.packageDigest, `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
    assert.equal(await readFile(join(source, 'dist', 'entrypoint.js'), 'utf8'), entrypoint);
    assert.equal(
      (await readdir(packagesRoot)).some((name) => name.startsWith('.local-directory-')),
      false,
    );
  });
});

function pluginBytes(version = '0.1.0-alpha.1') {
  return archive([
    ['package/manifest.json', JSON.stringify(manifest({ version, signals: undefined }))],
    ['package/dist/entrypoint.js', 'throw new Error("admission must not execute this");\n'],
  ]);
}

test('archive admission preserves source bytes and rejects duplicate installation without changing configuration', async () => {
  await privateRoot(async (root) => {
    const sourceArchive = join(root, 'source package ; $literal.tgz');
    const store = new MemoryPluginInventoryStore();
    const packagesRoot = join(root, 'Host packages');
    const admission = new LocalPluginPackageAdmission({
      inventory: new HostInventoryControlPlane(store),
      packagesRoot,
      grantPolicy: () => ['messaging.send'],
    });
    await writeFile(sourceArchive, pluginBytes());
    const first = await admission.install({ kind: 'local-archive', path: sourceArchive });
    await store.transaction((tx) =>
      tx.instances.put({
        ...tx.instances.get(first.pluginInstanceId),
        configReadiness: 'ready',
      }),
    );
    const before = await store.snapshot();
    const bytes = await readFile(sourceArchive);
    await assert.rejects(
      admission.install({ kind: 'local-archive', path: sourceArchive }),
      /inventory admission failed/,
    );
    assert.deepEqual(await readFile(sourceArchive), bytes);
    const snapshot = await store.snapshot();
    assert.equal(snapshot.instances.length, 1);
    assert.deepEqual(snapshot.instances, before.instances);
    await access(join(packagesRoot, packageDirectoryName(first.packageDigest), 'package.tgz'));
  });
});

test('archive portability preserves layout rejection without publishing inventory', async () => {
  await privateRoot(async (root) => {
    const sourceArchive = join(root, 'multiple roots.tgz');
    await writeFile(
      sourceArchive,
      archive([
        ['first/index.js', 'one'],
        ['second/index.js', 'two'],
      ]),
    );
    const store = new MemoryPluginInventoryStore();
    const admission = new LocalPluginPackageAdmission({
      inventory: new HostInventoryControlPlane(store),
      packagesRoot: join(root, 'packages'),
      grantPolicy: () => [],
    });
    await assert.rejects(admission.install({ kind: 'local-archive', path: sourceArchive }), /archive|package/i);
    assert.equal((await store.snapshot()).instances.length, 0);
  });
});

test(
  'directory and archive admission keep tar operands local to a private cwd',
  { skip: process.platform === 'win32' },
  async () => {
    await privateRoot(async (root) => {
      const probePath = join(root, 'tar-probe');
      const recordedPath = join(root, 'tar-calls.jsonl');
      // Delegate to real tar after enforcing its archive-coordinate contract.
      // This makes the regression executable on BSD-only development machines;
      // Windows separately runs these consumers against actual BSD and GNU tar.
      await writeFile(
        probePath,
        `#!${process.execPath}\n` +
          `const {spawnSync}=require('node:child_process');\n` +
          `const {appendFileSync}=require('node:fs');\n` +
          `const args=process.argv.slice(2);\n` +
          `appendFileSync(${JSON.stringify(recordedPath)},JSON.stringify({args,cwd:process.cwd()})+'\\n');\n` +
          `if(args[1].includes(':') || require('node:path').isAbsolute(args[1])) {process.stderr.write('archive operand is not local');process.exit(2);}\n` +
          `const result=spawnSync('tar',args,{stdio:'inherit'});\n` +
          `process.exit(result.status ?? 1);\n`,
      );
      await chmod(probePath, 0o700);
      const source = join(root, 'local source');
      await mkdir(join(source, 'dist'), { recursive: true });
      await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest({ signals: undefined })));
      await writeFile(join(source, 'dist', 'entrypoint.js'), '// never executed');
      const admission = new LocalPluginPackageAdmission({
        inventory: new HostInventoryControlPlane(new MemoryPluginInventoryStore()),
        packagesRoot: join(root, 'packages'),
        grantPolicy: () => ['messaging.send'],
        tarBin: probePath,
      });
      const admitted = await admission.install({ kind: 'local-directory', path: source });
      assert.equal(admitted.pluginId, 'official.test-source');
      const sourceArchive = join(root, 'update.tgz');
      await writeFile(sourceArchive, pluginBytes('0.1.0-alpha.2'));
      const archiveAdmission = new LocalPluginPackageAdmission({
        inventory: new HostInventoryControlPlane(new MemoryPluginInventoryStore()),
        packagesRoot: join(root, 'archive packages'),
        grantPolicy: () => ['messaging.send'],
        tarBin: probePath,
      });
      await archiveAdmission.install({ kind: 'local-archive', path: sourceArchive });
      const calls = (await readFile(recordedPath, 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(calls.length, 7, 'directory packing plus three verified staging calls per admission');
      assert.match(calls[0].cwd, /\.local-directory-/);
      const physicalRoot = await realpath(root);
      assert.ok(calls.every((call) => call.cwd.startsWith(physicalRoot)));
    });
  },
);
