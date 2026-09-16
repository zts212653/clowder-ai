import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readBoundedPackageFile } from '../dist/domains/plugin/external-runtime/bounded-package-file.js';

test('package snapshots reject escape, file and ancestor symlinks before reading', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'f309-file-boundary-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = join(scratch, 'package');
  const outside = join(scratch, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, 'worker.js'), 'outside-package');
  await writeFile(join(root, 'worker.js'), 'safe');
  await symlink(join(outside, 'worker.js'), join(root, 'linked.js'));
  await symlink(outside, join(root, 'linked-directory'));

  assert.equal((await readBoundedPackageFile(root, 'worker.js', 4)).toString(), 'safe');
  await assert.rejects(readBoundedPackageFile(root, 'worker.js', 3), /budget/);
  await assert.rejects(readBoundedPackageFile(root, '../outside/worker.js', 100), /escapes/);
  await assert.rejects(readBoundedPackageFile(root, 'linked.js', 100), /link|type/);
  await assert.rejects(readBoundedPackageFile(root, 'linked-directory/worker.js', 100), /link/);
});
