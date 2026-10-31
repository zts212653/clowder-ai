import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sealStaticPackage } from '../src/domains/plugin/external-runtime/static-package-seal.js';

async function tree() {
  const root = await mkdtemp(join(tmpdir(), 'f317-static-seal-'));
  await mkdir(join(root, 'renderer'));
  const path = join(root, 'renderer/main.js');
  await writeFile(path, 'original bytes');
  return { root, path };
}

test('a write during byte admission cannot create a seal even if the bytes are identical', async (t) => {
  const f = await tree();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await assert.rejects(
    sealStaticPackage(f.root, async () => {
      const original = await readFile(f.path);
      await writeFile(f.path, original);
    }),
    /changed while sealing/,
  );
});

test('a replacement directory containing equal bytes invalidates the old private generation', async (t) => {
  const f = await tree();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const check = await sealStaticPackage(f.root, async () => {});
  await rename(join(f.root, 'renderer'), join(f.root, 'previous'));
  await mkdir(join(f.root, 'renderer'));
  await writeFile(f.path, 'original bytes');
  await assert.rejects(check(), /generation changed/);
  await rm(join(f.root, 'renderer'), { recursive: true });
  await rename(join(f.root, 'previous'), join(f.root, 'renderer'));
  await assert.rejects(check(), /damaged/);
});

test('release removes the verified generation; concurrent checks cannot reuse a successful old result', async (t) => {
  const f = await tree();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const check = await sealStaticPackage(f.root, async () => {});
  await Promise.all(Array.from({ length: 8 }, check));
  await rm(f.root, { recursive: true });
  const results = await Promise.allSettled(Array.from({ length: 8 }, check));
  assert.ok(results.every((result) => result.status === 'rejected'));
});
