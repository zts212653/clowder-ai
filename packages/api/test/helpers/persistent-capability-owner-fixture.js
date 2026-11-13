import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// These cases exercise the persistent owner's bootstrap/heal/discovery duties.
// Linked worktrees correctly deny implicit writes unless their runtime identity
// is explicit. Give each case a temporary workspace and HOME, never the real
// checkout's capabilities or a user's CLI configuration.
export async function persistentOwnerFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cap-route-test-owner-'));
  const keys = [
    'CAT_CAFE_DEPLOYMENT_ID',
    'CAT_CAFE_RUNTIME_ROOT',
    'CAT_CAFE_WORKSPACE_ROOT',
    'CAT_CAFE_CONFIG_ROOT',
    'HOME',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(async () => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'home'));
  process.env.CAT_CAFE_DEPLOYMENT_ID = 'runtime';
  process.env.CAT_CAFE_RUNTIME_ROOT = resolve(import.meta.dirname, '../../../..');
  process.env.CAT_CAFE_WORKSPACE_ROOT = root;
  delete process.env.CAT_CAFE_CONFIG_ROOT;
  process.env.HOME = join(root, 'home');
}
