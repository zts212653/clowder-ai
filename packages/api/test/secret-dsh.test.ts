import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
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
