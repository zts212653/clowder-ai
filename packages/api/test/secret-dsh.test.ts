import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { secretRuntimeScript } from '@cat-cafe/mcp-server/dist/secret-runtime.js';
import {
  prepareDshSecretPatch,
  verifyDshSecretPatch,
} from '../src/domains/cats/services/agents/providers/dsh-secret-patch.js';

test('DSH launch admits only its exact managed patch and immutable plugin content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'secret-dsh-patch-'));
  try {
    const original = ['--profile', 'acp'];
    const args = await prepareDshSecretPatch('/fixture/dsh', original, root);
    assert.deepEqual(args.slice(0, 2), original);
    assert.equal(args[2], '--patch');
    const patch = args[3];
    assert.ok(patch);
    assert.equal(verifyDshSecretPatch(patch), true);
    assert.deepEqual(await prepareDshSecretPatch('/fixture/custom-acp', original, root), original);
    const text = await readFile(patch, 'utf8');
    assert.match(text, /cat-cafe-secret-content/);
    await writeFile(patch, `${text}\n- insert: [{name: attacker}]\n`);
    assert.equal(verifyDshSecretPatch(patch), false);
    await assert.rejects(prepareDshSecretPatch('/fixture/dsh', original, root), /secret_dsh_patch_changed/);
    const changedPlugin = join(root, 'plugin.mjs');
    await writeFile(changedPlugin, 'export default function() {}');
    await mkdir(join(root, 'forged'));
    const forged = join(root, 'forged/secret-dsh.patch.yml');
    await writeFile(
      forged,
      `- insert:\n    - id: cat-cafe-secret-content\n      name: ${JSON.stringify(changedPlugin)}\n`,
    );
    assert.equal(verifyDshSecretPatch(forged), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('DSH launch versions its managed patch without overwriting a retired template', async () => {
  const root = await mkdtemp(join(tmpdir(), 'secret-dsh-patch-version-'));
  try {
    const directory = join(root, '.cat-cafe', 'native-guards');
    await mkdir(directory, { recursive: true });
    const retiredPlugin = join(root, 'scripts', 'secret-dsh-plugin.mjs');
    await mkdir(join(root, 'scripts'));
    await copyFile(secretRuntimeScript('secret-dsh-plugin.mjs'), retiredPlugin);
    const retiredPatch = join(directory, 'secret-dsh.patch.yml');
    const retiredContent = `- insert:\n    - id: cat-cafe-secret-content\n      name: ${JSON.stringify(pathToFileURL(retiredPlugin).href)}\n- id: acp\n  inject: [acpAppStartup, catCafeSecretContent]\n`;
    await writeFile(retiredPatch, retiredContent, { mode: 0o600 });
    assert.equal(verifyDshSecretPatch(retiredPatch), false);

    const args = await prepareDshSecretPatch('/fixture/dsh', ['--profile', 'acp'], root);
    const patch = args.at(-1);
    assert.ok(patch);
    assert.notEqual(patch, retiredPatch);
    assert.equal(await readFile(retiredPatch, 'utf8'), retiredContent);

    const currentContent = await readFile(patch, 'utf8');
    const revision = createHash('sha256').update(currentContent).digest('hex');
    assert.equal(basename(patch), `secret-dsh-${revision}.patch.yml`);
    assert.equal(verifyDshSecretPatch(patch), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('DSH launch admits concurrent first creation of the same managed patch revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'secret-dsh-patch-concurrent-'));
  try {
    const attempts = await Promise.allSettled(
      Array.from({ length: 32 }, () => prepareDshSecretPatch('/fixture/dsh', ['--profile', 'acp'], root)),
    );
    const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
    assert.deepEqual(rejected, []);

    const patches = attempts.map((attempt) => {
      assert.equal(attempt.status, 'fulfilled');
      return attempt.value.at(-1);
    });
    assert.equal(new Set(patches).size, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
