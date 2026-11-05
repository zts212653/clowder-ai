import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const api = resolve(import.meta.dirname, '..');

test('a clean build owns governance provenance; stale inputs and missing semantic anchors fail closed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'governance-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rules = join(root, 'cat-cafe-skills/refs/shared-rules.md');
  const script = join(root, 'packages/api/scripts/build-governance-metadata.mjs');
  for (const path of [
    'scripts/build-governance-metadata.mjs',
    'dist/domains/cats/services/context/governance-l0.js',
    'dist/utils/monorepo-root.js',
  ]) {
    const target = join(root, 'packages/api', path);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(api, path), target);
  }
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  await mkdir(dirname(rules), { recursive: true });
  const original = await readFile(resolve(api, '../../cat-cafe-skills/refs/shared-rules.md'), 'utf8');
  await writeFile(rules, original);
  const build = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: tmpdir(), encoding: 'utf8' });
  const first = build();
  assert.equal(first.status, 0, first.stderr);
  const metadata = join(root, 'packages/api/dist/domains/cats/services/context/governance-build.json');
  const before = await readFile(metadata, 'utf8');
  assert.equal(JSON.parse(before).sourceSha256, createHash('sha256').update(original).digest('hex'));
  assert.equal(build('--check').status, 0);
  const changed = original.replace(/^### W3\..+$/m, '### W3. Fixture operator governance');
  assert.notEqual(changed, original);
  await writeFile(rules, changed);
  const stale = build('--check');
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /governance inputs changed/);
  assert.equal(await readFile(metadata, 'utf8'), before, 'check must not bless changed inputs');
  assert.equal(build().status, 0);
  const after = JSON.parse(await readFile(metadata, 'utf8'));
  assert.notEqual(after.sourceSha256, JSON.parse(before).sourceSha256);
  assert.notEqual(after.compiledSha256, JSON.parse(before).compiledSha256);
  assert.equal(build('--check').status, 0);
  await writeFile(rules, changed.replace(/^### P1\..+\n/m, ''));
  const invalid = build();
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /missing P heading P1/);
});
