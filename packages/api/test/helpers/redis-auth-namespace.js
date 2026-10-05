import { randomUUID } from 'node:crypto';

/**
 * Per-run Redis keyspace for the auth-invocation suites.
 *
 * Both `auth-invocation-restart.test.js` and
 * `auth-invocation-backend-contract.test.js` used the literal prefix
 * `cat-cafe-test:` and wiped `cat-cafe-test:auth:*` before their fixtures ran.
 * Serially that is harmless. Under the regular API test run
 * (`--test-concurrency=4`) they execute at the same time, so one suite's wipe
 * can delete a record the other has written and not yet verified — the restart
 * assertion then fails for a reason that has nothing to do with restart.
 *
 * The namespace is unique per suite *and* per process, so concurrent runs of
 * the same file (repeat runs, multiple worktrees against the shared 6398
 * instance) cannot collide either. Uniqueness also removes the need to sweep
 * "leftovers from prior runs": a fresh namespace has none by construction, and
 * sweeping a shared prefix was exactly the operation that caused the race.
 */
export function createAuthTestNamespace(suiteLabel) {
  if (!suiteLabel || typeof suiteLabel !== 'string') {
    throw new TypeError('createAuthTestNamespace requires a suite label');
  }
  return `cat-cafe-test:${suiteLabel}-${process.pid}-${randomUUID().slice(0, 8)}:`;
}

/**
 * Delete every key this namespace owns.
 *
 * `keys()` returns fully-prefixed keys while `del()` re-applies the client's
 * keyPrefix, so the prefix has to be stripped before deleting — dropping that
 * step silently deletes nothing.
 */
export async function clearAuthTestNamespace(redis, namespace) {
  const keys = await redis.keys(`${namespace}*`);
  if (keys.length === 0) return 0;
  await redis.del(...keys.map((key) => key.replace(namespace, '')));
  return keys.length;
}
