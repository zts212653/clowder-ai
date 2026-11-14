import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** gh's automatic GraphQL cache is written in place with no cross-process lock. */
export async function withIsolatedGhReadCache(command, env, execute) {
  const [group, operation] = command;
  const implicitMetadata =
    (group === 'pr' && ['list', 'status', 'checks', 'merge'].includes(operation)) ||
    (group === 'issue' && ['list', 'status'].includes(operation));
  if (!implicitMetadata) {
    return execute(env);
  }

  // Keep authentication/config intact. Only implicit CLI metadata is disposable;
  // in particular, explicit `gh api --cache` must keep its caller-selected cache.
  const cacheHome = mkdtempSync(join(tmpdir(), 'cat-cafe-gh-read-'));
  try {
    return await execute({ ...env, XDG_CACHE_HOME: cacheHome });
  } finally {
    rmSync(cacheHome, { recursive: true, force: true });
  }
}
