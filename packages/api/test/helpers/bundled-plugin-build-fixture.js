import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const api = process.env.CAT_CAFE_TEST_API_BUILD_ROOT ?? resolve(import.meta.dirname, '../..');

export async function copyBundledBuildDependencies(root, fromSource = false) {
  const mode = fromSource ? 'src' : 'dist';
  const extension = fromSource ? 'ts' : 'js';
  await mkdir(join(root, mode, 'domains/plugin'), { recursive: true });
  for (const name of ['bundled-plugin-definitions', 'package-capability-admission']) {
    await cp(
      join(api, mode, 'domains/plugin', `${name}.${extension}`),
      join(root, mode, 'domains/plugin', `${name}.${extension}`),
    );
  }
  await symlink(
    join(api, mode, 'domains/cats'),
    join(root, mode, 'domains/cats'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}

export async function bundledBuildFixture(t, description, fromSource = false, { prebuilt = false } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'bundled-build-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  // Preserve the native script's packages/api -> workspace dependency layout.
  const root = join(workspace, 'packages/api');
  const pluginRoot = join(root, 'dist/domains/plugin');
  await mkdir(pluginRoot, { recursive: true });
  await cp(join(api, 'scripts'), join(root, 'scripts'), { recursive: true });
  await symlink(
    join(api, 'node_modules'),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await symlink(
    resolve(api, '../../node_modules'),
    join(workspace, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  await copyBundledBuildDependencies(root, fromSource);
  const producer = await readFile(
    join(
      api,
      fromSource ? 'src/domains/plugin/chatgpt-dot-manifest.ts' : 'dist/domains/plugin/chatgpt-dot-manifest.js',
    ),
    'utf8',
  );
  const manifestImport = producer.match(/'\.\/(bundled-packages\/chatgpt-dot\/([^/]+)\/manifest\.json)'/);
  assert.ok(manifestImport, 'producer must select its bundled JSON manifest');
  const version = manifestImport[2];
  const manifest = JSON.parse(await readFile(join(api, 'src/domains/plugin', manifestImport[1]), 'utf8'));
  assert.equal(manifest.version, version);
  if (!prebuilt) manifest.description = description;
  const producerPath = fromSource
    ? join(root, 'src/domains/plugin/chatgpt-dot-manifest.ts')
    : join(pluginRoot, 'chatgpt-dot-manifest.js');
  await mkdir(dirname(producerPath), { recursive: true });
  await writeFile(producerPath, producer);
  const externalRuntimeRoot = fromSource
    ? join(root, 'src/domains/plugin/external-runtime')
    : join(pluginRoot, 'external-runtime');
  await mkdir(externalRuntimeRoot, { recursive: true });
  for (const file of fromSource ? ['archive-preflight.ts', 'types.ts'] : ['archive-preflight.js', 'types.js']) {
    await cp(
      join(api, fromSource ? 'src/domains/plugin/external-runtime' : 'dist/domains/plugin/external-runtime', file),
      join(externalRuntimeRoot, file),
    );
  }
  const manifestPath = join(dirname(producerPath), manifestImport[1]);
  const sourcePackage = join(root, 'src/domains/plugin/bundled-packages/chatgpt-dot', version);
  await mkdir(sourcePackage, { recursive: true });
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(sourcePackage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const assets = join(sourcePackage, 'assets');
  await mkdir(dirname(assets), { recursive: true });
  if (prebuilt) {
    await cp(join(api, 'src/domains/plugin', manifestImport[1], '../package.tgz'), join(sourcePackage, 'package.tgz'));
  } else {
    // Exercise the generic source builder without repacking or changing the frozen
    // production archive. Only this temporary copy disables the prebuilt definition.
    const scriptPath = join(
      root,
      fromSource ? 'src' : 'dist',
      'domains/plugin',
      `bundled-plugin-definitions.${fromSource ? 'ts' : 'js'}`,
    );
    const script = await readFile(scriptPath, 'utf8');
    const prebuiltDefinition = /\s*prebuilt: \{ sha256: '[a-f0-9]{64}' \},\n/gm;
    assert.equal([...script.matchAll(prebuiltDefinition)].length, 1);
    await writeFile(
      scriptPath,
      script.replace(
        prebuiltDefinition,
        `
    files: ${JSON.stringify(['assets/chatgpt-cloud.svg', manifest.runtime.entrypoint])},
`,
      ),
    );
    await mkdir(assets);
    await writeFile(join(assets, 'chatgpt-cloud.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
    if (manifest.runtime?.entrypoint) {
      const entrypoint = join(sourcePackage, manifest.runtime.entrypoint);
      await mkdir(dirname(entrypoint), { recursive: true });
      await writeFile(entrypoint, 'export const fixture = true;\n');
    }
  }
  return {
    root,
    assets,
    pluginRoot,
    producerPath,
    manifestPath,
    version,
    sourceArchivePath: join(sourcePackage, 'package.tgz'),
    replacePrebuiltArchive: async (bytes) => {
      assert.equal(prebuilt, true, 'only a prebuilt fixture has a frozen archive');
      await writeFile(join(sourcePackage, 'package.tgz'), bytes);
      const scriptPath = join(
        root,
        fromSource ? 'src' : 'dist',
        'domains/plugin',
        `bundled-plugin-definitions.${fromSource ? 'ts' : 'js'}`,
      );
      const script = await readFile(scriptPath, 'utf8');
      const expectedSha = /prebuilt: \{ sha256: '[a-f0-9]{64}' \}/g;
      assert.equal([...script.matchAll(expectedSha)].length, 1);
      await writeFile(
        scriptPath,
        script.replace(expectedSha, `prebuilt: { sha256: '${createHash('sha256').update(bytes).digest('hex')}' }`),
      );
    },
    build: (...args) =>
      spawnSync(
        process.execPath,
        [
          ...(fromSource ? ['--import', new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).href] : []),
          join(root, 'scripts/copy-bundled-plugin-packages.mjs'),
          ...(fromSource ? ['--source'] : []),
          ...args,
        ],
        {
          cwd: tmpdir(),
          encoding: 'utf8',
          windowsHide: true,
        },
      ),
  };
}
