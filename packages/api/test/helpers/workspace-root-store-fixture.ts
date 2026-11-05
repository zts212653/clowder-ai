import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

/** Isolate both the durable owner and the legacy cwd fallback. */
export async function rootStoreFixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workspace-root-store-')));
  const cwd = process.cwd();
  const prior = {
    CAT_CAFE_DATA_DIR: process.env.CAT_CAFE_DATA_DIR,
    CAT_CAFE_WORKSPACE_ROOT: process.env.CAT_CAFE_WORKSPACE_ROOT,
    WORKSPACE_LINKED_ROOTS: process.env.WORKSPACE_LINKED_ROOTS,
  };
  process.chdir(root);
  process.env.CAT_CAFE_DATA_DIR = join(root, 'state');
  process.env.CAT_CAFE_WORKSPACE_ROOT = root;
  delete process.env.WORKSPACE_LINKED_ROOTS;
  t.after(async () => {
    process.chdir(cwd);
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
