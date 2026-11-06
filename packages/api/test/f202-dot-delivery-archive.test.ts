import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { preflightPluginArchive } from '../src/domains/plugin/external-runtime/archive-preflight.js';

const expectedSha256 = 'b29f1f979874e0a04df5c324f9bf55e72a58c00ed118c58ed45409478240dee8';
const deliveryArchive = fileURLToPath(
  new URL('../src/domains/plugin/bundled-packages/chatgpt-dot/0.2.0-alpha.29/package.tgz', import.meta.url),
);

test('the exact frozen Dot delivery archive passes admission and installs offline', async (t) => {
  const bytes = await readFile(deliveryArchive);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedSha256);
  await preflightPluginArchive(deliveryArchive);

  const consumer = await mkdtemp(join(tmpdir(), 'f202-dot-delivery-consumer-'));
  t.after(() => rm(consumer, { recursive: true, force: true }));
  const cache = join(consumer, 'empty-cache');
  await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const installed = spawnSync(
    npm,
    ['install', '--ignore-scripts', '--package-lock=false', '--no-audit', '--no-fund', '--offline', deliveryArchive],
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
  ) as { name: string; version: string };
  assert.equal(installedPackage.name, '@clowder-ai/chatgpt-dot');
  assert.equal(installedPackage.version, '0.2.0-alpha.29');
  const installedManifest = parse(
    await readFile(join(consumer, 'node_modules/@clowder-ai/chatgpt-dot/plugin.yaml'), 'utf8'),
  ) as { pluginId: string; version: string };
  assert.equal(installedManifest.pluginId, 'official.chatgpt-dot');
  assert.equal(installedManifest.version, '0.2.0-alpha.29');
});
