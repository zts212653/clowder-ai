import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  readUnixProcessSnapshot,
  resolveCatCafeDataRoot,
  sameUnixProcess,
  type UnixProcessIdentity,
} from '../../../../../../../utils/cli-process-ownership.js';
import {
  AgyNativeProfileBusyError,
  type AgyNativeTurnScope,
  isNativeTurnRetiredFromSnapshot,
  nativeTurnEnvironmentMarkers,
  openNativeTurnStore,
  type ProfileTurnOwner,
  parseNativeTurnOwner,
  retireOrphanCredentials,
} from './store.js';

let ownIdentity: UnixProcessIdentity | undefined;
function sqliteBusy(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
}

async function isRetired(owner: ProfileTurnOwner, home: string): Promise<boolean> {
  // A verified birth identity is stable for this API's entire lifetime.
  if (owner.identity.pid === process.pid && sameUnixProcess(owner.identity, ownIdentity)) return false;
  const exact = await readUnixProcessSnapshot({ pids: [owner.identity.pid] });
  if (!exact || sameUnixProcess(owner.identity, exact.get(owner.identity.pid))) return false;
  const snapshot = await readUnixProcessSnapshot({
    includeEnvironment: true,
    environmentMarkers: nativeTurnEnvironmentMarkers(owner, home),
  });
  return snapshot !== null && isNativeTurnRetiredFromSnapshot(owner, home, snapshot);
}

/** Async proof happens outside the write transaction; exact token+owner CAS fences the subsequent claim. */
export async function acquireAgyNativeProfileTurnAsync(
  home: string,
  invocationId?: string,
  scope: AgyNativeTurnScope = {},
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  signal?.throwIfAborted();
  ownIdentity ??= (await readUnixProcessSnapshot({ pids: [process.pid] }))?.get(process.pid);
  if (!ownIdentity) throw new Error('Native profile ownership requires a verified process birth identity');
  const identity = ownIdentity;
  let store: ReturnType<typeof openNativeTurnStore>;
  try {
    store = openNativeTurnStore(home, scope, 0);
  } catch (error) {
    if (sqliteBusy(error)) throw new AgyNativeProfileBusyError('Native profile database is busy');
    throw error;
  }
  const { db, table, key, value } = store;
  const token = randomUUID();
  try {
    const previous = db.prepare(`SELECT token, owner FROM ${table} WHERE ${key} = ?`).get(value) as
      | { token: string; owner: string }
      | undefined;
    const owner = previous ? parseNativeTurnOwner(previous.owner, home) : undefined;
    if (owner && !(await isRetired(owner, home)))
      throw new AgyNativeProfileBusyError('Another native turn still owns this conversation or preparation');
    signal?.throwIfAborted();
    db.transaction(() => {
      const current = db.prepare(`SELECT token, owner FROM ${table} WHERE ${key} = ?`).get(value) as
        | { token: string; owner: string }
        | undefined;
      if (current?.token !== previous?.token || current?.owner !== previous?.owner)
        throw new AgyNativeProfileBusyError('Native profile ownership changed during process observation');
      if (owner && !owner.preparation) retireOrphanCredentials(owner.runHome ?? home, home);
      const next: ProfileTurnOwner = {
        identity,
        dataRoot: resolveCatCafeDataRoot(),
        ...(invocationId ? { invocationId } : {}),
        ...(scope.runHome ? { runHome: scope.runHome } : {}),
        ...(scope.preparation ? { preparation: true } : {}),
      };
      db.prepare(`INSERT INTO ${table} (${key}, token, owner) VALUES (?, ?, ?)
        ON CONFLICT(${key}) DO UPDATE SET token = excluded.token, owner = excluded.owner`).run(
        value,
        token,
        JSON.stringify(next),
      );
    }).immediate();
  } catch (error) {
    db.close();
    if (sqliteBusy(error)) throw new AgyNativeProfileBusyError('Native profile database is busy');
    throw error;
  }
  let releasing: Promise<void> | undefined;
  return () => {
    releasing ??= (async () => {
      const deadline = Date.now() + 5000;
      try {
        for (;;) {
          try {
            db.prepare(`DELETE FROM ${table} WHERE ${key} = ? AND token = ?`).run(value, token);
            return;
          } catch (error) {
            if (!sqliteBusy(error) || Date.now() >= deadline) throw error;
            await delay(25);
          }
        }
      } finally {
        db.close();
      }
    })();
    return releasing;
  };
}
