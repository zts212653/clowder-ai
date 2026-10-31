import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  prepareDshSecretPatch,
  verifyDshSecretPatch,
} from '../dist/domains/cats/services/agents/providers/dsh-secret-patch.js';

test('packaged DSH plugin passes the production startup admission', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-pin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const args = await prepareDshSecretPatch('dsh', ['--profile', 'acp'], root);
  assert.equal(args.at(-2), '--patch');
  assert.equal(verifyDshSecretPatch(args.at(-1)), true);
});
