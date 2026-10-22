import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const api = resolve(import.meta.dirname, '../..');

export async function bundledBuildFixture(t, description, fromSource = false) {
  const root = await mkdtemp(join(tmpdir(), 'bundled-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pluginRoot = join(root, 'dist/domains/plugin');
  await mkdir(pluginRoot, { recursive: true });
  await cp(join(api, 'scripts'), join(root, 'scripts'), { recursive: true });
  await symlink(
    join(api, 'node_modules'),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  const producer = await readFile(join(api, 'dist/domains/plugin/chatgpt-dot-manifest.js'), 'utf8');
  assert.match(producer, /description: '[^']*'/);
  const producerPath = fromSource
    ? join(root, 'src/domains/plugin/chatgpt-dot-manifest.ts')
    : join(pluginRoot, 'chatgpt-dot-manifest.js');
  await mkdir(dirname(producerPath), { recursive: true });
  await writeFile(
    producerPath,
    producer.replace(/description: '[^']*'/, `description: ${JSON.stringify(description)}`),
  );
  // Leave only canonical SVG inputs. A checkout must not need old JSON/tar/index outputs.
  const assets = join(root, 'src/domains/plugin/bundled-packages/chatgpt-dot/0.1.2/assets');
  await mkdir(dirname(assets), { recursive: true });
  await cp(join(api, 'src/domains/plugin/bundled-packages/chatgpt-dot/0.1.2/assets'), assets, { recursive: true });
  return {
    root,
    assets,
    pluginRoot,
    producerPath,
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
        },
      ),
  };
}
