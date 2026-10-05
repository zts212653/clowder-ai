import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DesktopWindowComponent,
  desktopComponentEnvironment,
} from '../src/domains/plugin/desktop-window-runtime/desktop-component.js';

test('the real npm CLI can load the isolated Host component environment without reading user credentials', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f317-npm-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = desktopComponentEnvironment(root);
  env.HOME = join(root, 'owner-home');
  await mkdir(env.HOME);
  await writeFile(join(env.HOME, '.npmrc'), 'registry=https://owner-private.invalid/\n');
  assert.ok(!Object.keys(env).some((key) => /TOKEN|SECRET|NODE_OPTIONS/.test(key)));
  const result = spawnSync('npm', ['config', 'get', 'registry'], { cwd: root, env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'https://registry.npmjs.org/');
});

test('component preparation consumes only the Host lock and publishes one complete executable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f317-component-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const desktopRoot = join(root, 'desktop');
  const cacheRoot = join(root, 'cache');
  await mkdir(desktopRoot);
  const version = '35.7.5';
  await writeFile(join(desktopRoot, 'package.json'), JSON.stringify({ devDependencies: { electron: version } }));
  await writeFile(
    join(desktopRoot, 'package-lock.json'),
    JSON.stringify({
      packages: {
        'node_modules/electron': {
          version,
          resolved: `https://registry.npmjs.org/electron/-/electron-${version}.tgz`,
          integrity: 'sha512-fixture',
        },
      },
    }),
  );
  const stages: string[] = [];
  const component = new DesktopWindowComponent({
    desktopRoot,
    cacheRoot,
    run: async (stage, dir) => {
      stages.push(stage);
      assert.equal(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).devDependencies.electron, version);
      if (stage !== 'electron') return;
      const moduleRoot = join(dir, 'node_modules/electron');
      await mkdir(join(moduleRoot, 'dist'), { recursive: true });
      await writeFile(join(moduleRoot, 'package.json'), JSON.stringify({ version }));
      await writeFile(join(moduleRoot, 'path.txt'), 'electron');
      await writeFile(join(moduleRoot, 'dist/electron'), 'fixture');
      await chmod(join(moduleRoot, 'dist/electron'), 0o700);
    },
  });
  await assert.rejects(component.executable(), { code: 'ENOENT' });
  const [a, b] = await Promise.all([component.prepare(), component.prepare()]);
  assert.equal(a, b);
  assert.deepEqual(stages, ['dependencies', 'electron']);
  assert.equal(await component.prepare(), a);
  assert.equal(stages.length, 2);
  await writeFile(join(a, '../../path.txt'), '../../../outside');
  await assert.rejects(component.executable());
});
