import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { preflightPluginArchive } from '../dist/domains/plugin/external-runtime/archive-preflight.js';

const expectedSha256 = '42f80b89341701ef07848699c423a813195160182d13a02c3f652ec99f36b0f5';
const deliveryArchive = fileURLToPath(
  new URL('../src/domains/plugin/bundled-packages/chatgpt-dot/0.2.0-alpha.48/package.tgz', import.meta.url),
);

test('the exact frozen Dot delivery archive passes admission and installs offline', async (t) => {
  const bytes = await readFile(deliveryArchive);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedSha256);
  await preflightPluginArchive(deliveryArchive);

  const consumer = await mkdtemp(join(tmpdir(), 'f202-dot-delivery-consumer-'));
  t.after(() => rm(consumer, { recursive: true, force: true }));
  const cache = join(consumer, 'empty-cache');
  await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
  const npm = process.platform === 'win32' ? process.execPath : 'npm';
  const npmPrefix =
    process.platform === 'win32' ? [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')] : [];
  const installed = spawnSync(
    npm,
    [
      ...npmPrefix,
      'install',
      '--ignore-scripts',
      '--package-lock=false',
      '--no-audit',
      '--no-fund',
      '--offline',
      deliveryArchive,
    ],
    {
      cwd: consumer,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: cache },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);

  const installedPackage = JSON.parse(
    await readFile(join(consumer, 'node_modules/@clowder-ai/chatgpt-dot/package.json'), 'utf8'),
  );
  assert.equal(installedPackage.name, '@clowder-ai/chatgpt-dot');
  assert.equal(installedPackage.version, '0.2.0-alpha.48');
  const installedManifest = parse(
    await readFile(join(consumer, 'node_modules/@clowder-ai/chatgpt-dot/plugin.yaml'), 'utf8'),
  );
  assert.equal(installedManifest.pluginId, 'official.chatgpt-dot');
  assert.equal(installedManifest.version, '0.2.0-alpha.48');
  const loaded = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    const entry = import.meta.resolve('@clowder-ai/chatgpt-dot');
    assert.equal(typeof (await import(entry)).default.create, 'function');
    assert.equal(typeof (await import('@clowder-ai/chatgpt-dot/migration')).importLegacyBatch, 'function');
    const sharp = createRequire(entry)('sharp');
    const png = await sharp({create: {width: 1, height: 1, channels: 4, background: '#336699'}}).png().toBuffer();
    assert.equal((await sharp(png).metadata()).width, 1);
  `,
    ],
    { cwd: consumer, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } },
  );
  assert.equal(loaded.status, 0, `${loaded.stdout}\n${loaded.stderr}`);
});
