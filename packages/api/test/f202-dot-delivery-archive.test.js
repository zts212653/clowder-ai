import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { preflightPluginArchive } from '../dist/domains/plugin/external-runtime/archive-preflight.js';

const expectedSha256 = '6214d9b5717900bde17691ff255d148df90423b46fe7820476f6bc1ce3c4283e';
const deliveryArchive = fileURLToPath(
  new URL('../src/domains/plugin/bundled-packages/chatgpt-dot/0.2.0-alpha.51/package.tgz', import.meta.url),
);

test('the exact frozen Dot delivery archive passes admission and installs offline', { timeout: 150_000 }, async (t) => {
  const stage = (name) => writeSync(2, `[f202-frozen-archive] ${name}\n`);
  stage('read and verify archive');
  const bytes = await readFile(deliveryArchive);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedSha256);
  stage('Host archive preflight');
  await preflightPluginArchive(deliveryArchive);

  const consumer = await mkdtemp(join(tmpdir(), 'f202-dot-delivery-consumer-'));
  t.after(() => rm(consumer, { recursive: true, force: true }));
  const cache = join(consumer, 'empty-cache');
  await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
  const npm = process.platform === 'win32' ? process.execPath : 'npm';
  const npmPrefix =
    process.platform === 'win32' ? [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')] : [];
  stage('empty-cache npm install --offline');
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
      timeout: 60_000,
      killSignal: 'SIGKILL',
    },
  );
  assert.equal(
    installed.status,
    0,
    `offline install: ${installed.error?.stack ?? ''}\n${installed.stdout}\n${installed.stderr}`,
  );

  const installedPackage = JSON.parse(
    await readFile(join(consumer, 'node_modules/@clowder-ai/chatgpt-dot/package.json'), 'utf8'),
  );
  assert.equal(installedPackage.name, '@clowder-ai/chatgpt-dot');
  assert.equal(installedPackage.version, '0.2.0-alpha.51');
  const installedManifest = parse(
    await readFile(join(consumer, 'node_modules/@clowder-ai/chatgpt-dot/plugin.yaml'), 'utf8'),
  );
  assert.equal(installedManifest.pluginId, 'official.chatgpt-dot');
  assert.equal(installedManifest.version, '0.2.0-alpha.51');
  stage('installed module and PNG consumer');
  const loaded = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    console.error('[f202-frozen-consumer] resolve module');
    const entry = import.meta.resolve('@clowder-ai/chatgpt-dot');
    assert.equal(typeof (await import(entry)).default.create, 'function');
    console.error('[f202-frozen-consumer] load migration');
    assert.equal(typeof (await import('@clowder-ai/chatgpt-dot/migration')).importLegacyBatch, 'function');
    console.error('[f202-frozen-consumer] load sharp');
    const sharp = createRequire(entry)('sharp');
    console.error('[f202-frozen-consumer] encode PNG');
    const png = await sharp({create: {width: 1, height: 1, channels: 4, background: '#336699'}}).png().toBuffer();
    console.error('[f202-frozen-consumer] read PNG metadata');
    assert.equal((await sharp(png).metadata()).width, 1);
    console.error('[f202-frozen-consumer] complete');
  `,
    ],
    { cwd: consumer, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' }, timeout: 60_000, killSignal: 'SIGKILL' },
  );
  assert.equal(
    loaded.status,
    0,
    `module/PNG consumer: ${loaded.error?.stack ?? ''}\n${loaded.stdout}\n${loaded.stderr}`,
  );
  stage('complete');
});
